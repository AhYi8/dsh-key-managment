/**
 * 密钥管理插件 Host 半区。
 *
 * 职责:
 * - 扫描 `llm` 目录中已配置的供应商,结合 settings 命名空间里的
 *   `apiKeyEnv` 找到每个供应商的原始凭据引用名;
 * - 为可管理供应商维护一个密钥池:池内密钥值存 DSH 凭据存储,
 *   元数据(id/名称/引用名)存 profile 目录下的状态文件,无明文;
 * - "切换密钥"即字面替换:把池内选中值写回供应商原始引用,
 *   与设置页(模型页密钥字段)保存走同一条凭据通道;
 * - 通过 webServer 的同源 HTTP 路由向 Web 客户端暴露 JSON API。
 *
 * 只做手动轮换:没有自动故障转移、重试或冷却策略(需求裁剪)。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { probeKey } from './quota-bridge.js'
import {
  hitValue,
  isSelectable,
  MAX_KEYS_PER_PROVIDER,
  digestOf,
  findKeyByDigest,
  mergeRuntimeState,
  newKeyId,
  newPoolRef,
  newProviderRecord,
  nextAlias,
  normalizeState,
  normalizeRotation,
  parseAction,
  parseBatchEntries,
  pickNextKeyId,
  probeRoundDelay,
  projectProvider,
  settleKeyHealth,
  shouldRotateCalls,
  shouldRotateInterval,
  tailOf,
  validateAlias,
  validateKeyValue,
  validateProbeConfig,
} from './core.js'

export const name = 'dsh-key-managment'
export const inject = ['llm', 'credentials', 'webServer']

/** 插件配置:插件详情页与配置界面展示的就是这些字段。 */
export const Config = z.object({
  /** 是否启用密钥余额探测(探测关闭时界面只展示历史快照)。 */
  quotaProbe: z.boolean().default(true).volatile(),
  /** 后台探测轮间隔(毫秒),默认 30 分钟。 */
  quotaIntervalMs: z.number().step(60_000).min(60_000).max(86_400_000).default(1_800_000).volatile(),
  /** 一轮内相邻两次厂商调用之间的间隔(毫秒),默认 5 秒,限流友好。 */
  quotaProbeGapMs: z.number().step(100).min(200).max(60_000).default(5_000).volatile(),
})

/** 同源 API 路由路径;客户端用同一常量访问。 */
export const API_PATH = '/dsh-key-managment/api'

/**
 * 状态文件位置:跟随 profile 目录(与生态内其他插件一致),
 * 无 profile 环境退回 DSH_HOME,再退回主目录。
 */
function stateFilePath() {
  const base = process.env.DSH_PROFILE_DIR || process.env.DSH_HOME
  return join(base || process.cwd(), 'key-managment-state.json')
}

/** 从 settings 命名空间值里按路径取嵌套对象。 */
function getPath(value, path) {
  let current = value
  for (const part of path ?? []) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

/** 读取一个 volatile 配置字段的当前值(取值器或字面量)。 */
function live(config, field, fallback) {
  const value = config?.[field]
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value === undefined ? fallback : value
}

/**
 * 原子改名的有界重试。
 *
 * Windows 上文件被占用(杀毒软件/索引服务/其它实例)时 rename 会以
 * EACCES/EPERM/EBUSY 失败;重试几次通常就能成功,否则每次失败都会在
 * profile 目录里留下一个临时文件。
 */
async function renameWithRetry(from, to, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = error?.code
      const transient = code === 'EACCES' || code === 'EPERM' || code === 'EBUSY'
      if (!transient || attempt >= attempts) throw error
      await new Promise(resolve => setTimeout(resolve, 50 * attempt))
    }
  }
}

export function apply(ctx, config) {
  const statePath = stateFilePath()
  let state = normalizeState(undefined)
  /** 运行时目录:llm 目录里 Key 型供应商的发现信息;不落盘。 */
  let directory = new Map()
  /** 设置服务快照;由 ctx.inject 异步补齐,缺失时扫描报错。 */
  let settings = undefined
  /** 串行化所有变更动作,避免并发写状态文件。 */
  let mutationTail = Promise.resolve()
  /** 余额探测:快照存储(cache 兼做 TTL 判定)+ 在途去重,键为 provider\u0000keyId。 */
  const quotaStore = new Map()
  const quotaInflight = new Map()
  /** 余额快照的持久化文件路径:与状态文件分开,避免互相干扰。 */
  const quotaPath = join(dirname(statePath), 'key-managment-quota.json')
  /** 后台探测轮的运行标志:防止上一轮未结束时叠加新一轮。 */
  let backgroundProbing = false
  /** 实例是否已被卸载:卸载后不再探测与落盘,避免旧实例覆盖新实例的状态。 */
  let disposed = false
  /** 配置编辑器;由 ctx.inject 异步补齐。 */
  let configEditor = undefined

  /**
   * 初始化:读状态文件 + 读余额快照。
   *
   * apply 保持同步(Loader 才能在重装时正确释放它,不留孤儿实例);
   * 首次扫描独立可重试(ensureScanned):settings 注入可能晚于启动,
   * 扫描失败不能让 ready 永久 rejected,否则所有 API 全部失效(审查 P1-2)。
   */
  const ready = (async () => {
    await mkdir(dirname(statePath), { recursive: true })
    state = normalizeState(await readStateFile(statePath))
    // 恢复余额快照:重启后界面立即有数据,不用再探测。
    for (const [cacheKey, payload] of Object.entries(await readStateFile(quotaPath) ?? {})) {
      if (payload !== null && typeof payload === 'object') quotaStore.set(cacheKey, payload)
    }
  })()
  ready.catch((error) => {
    ctx.warn?.(`初始化失败: ${error?.message ?? error}`)
  })

  /**
   * 启动闸门:首次扫描尝试结束后放行后台探测。
   *
   * 启动首轮必须等 settings 到位,否则探测拿不到供应商 profile,
   * 会打到目录默认端点、得到与实际账户无关的余额。
   */
  let releaseStartup
  let startupTimer
  const startupReady = new Promise(resolve => {
    releaseStartup = () => {
      if (startupTimer !== undefined) {
        clearTimeout(startupTimer)
        startupTimer = undefined
      }
      resolve()
    }
  })
  // 兜底:settings 迟到或扫描卡死时,超时后照样开跑。
  // 否则后台探测会静默停摆——宁可用目录默认端点探一轮,也不要完全不探。
  startupTimer = setTimeout(() => {
    ctx.warn?.('后台探测启动闸门超时:未等到 settings 就绪,先按目录默认端点探一轮')
    releaseStartup()
  }, 30_000)

  /** 首次扫描标记;失败可由下一次 API 调用重试。 */
  let scanned = false
  async function ensureScanned() {
    if (scanned) return
    await scan()
    scanned = true
  }

  ctx.effect(() => ctx.inject(['settings'], (scope) => {
    settings = scope.settings
    // settings 到位后补扫一次(启动时它可能还没挂上)。
    void (async () => {
      // 等状态读盘完成再扫:否则 state.providers 还是空的,
      // 已纳管的供应商会被当成"可纳管"重新出现。
      await ready.catch(() => {})
      try {
        await ensureScanned()
      } catch (error) {
        ctx.warn?.(`扫描失败(可在界面手动刷新): ${error?.message ?? error}`)
      } finally {
        // 扫描尝试结束(成功或失败):放行后台探测的启动首轮。
        releaseStartup()
      }
    })()
    return () => { settings = undefined }
  }), 'dsh-key-managment: settings 获取')

  ctx.effect(() => ctx.inject(['configEditor'], (scope) => {
    configEditor = scope.configEditor
    return () => { configEditor = undefined }
  }), 'dsh-key-managment: configEditor 获取')

  // 卸载标记:插件被移除/重载时置位,让在飞的后台轮主动放弃本轮。
  ctx.effect(() => () => {
    disposed = true
    if (startupTimer !== undefined) {
      clearTimeout(startupTimer)
      startupTimer = undefined
    }
  }, 'dsh-key-managment: 卸载标记')

  async function readStateFile(path) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      // 首次运行或文件损坏:normalizeState 会兜底为空状态。
      return undefined
    }
  }

  /**
   * 落盘临时文件后缀:每个实例一个。
   *
   * 插件重载时新旧实例可能同时落盘,共用固定临时名会互相截断、写出半截 JSON;
   * 同一实例内的落盘已串行化(persistTail / quotaTail),复用同一个临时名不会
   * 并发写,失败残留的临时文件也最多一个,不会无界堆积。
   */
  const tempSuffix = randomUUID()

  /**
   * 原子化写状态文件:先写临时文件再改名。
   * persistTail 串行化所有落盘:定时轮、stream 归因、API 变更都可能并发
   * 触发 persist,交错写同一个临时文件会落成半截 JSON(审查 P0-1)。
   */
  let persistTail = Promise.resolve()
  function persist() {
    // 链首先吃掉上一次失败:否则一次写盘错误(磁盘满/权限)会让 persistTail
    // 永远处于 rejected 状态,之后所有落盘都被跳过,插件变更静默丢失。
    persistTail = persistTail.catch(() => {}).then(async () => {
      const tempPath = `${statePath}.${tempSuffix}.tmp`
      await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8')
      await renameWithRetry(tempPath, statePath)
    })
    return persistTail
  }

  function recordOf(provider) {
    return state.providers[provider]
  }

  /**
   * 取当前内存态里某把密钥的活对象。
   *
   * "以磁盘为准"的定时同步会整体替换 state.providers,先前持有的
   * record/key 引用随之成为孤儿——写在孤儿上的健康状态会随落盘丢失。
   * 需要读写某把密钥的当前状态时,按 id 到这里重新定位。
   */
  function liveKeyOf(provider, keyId) {
    const record = recordOf(provider)
    if (record === undefined || !Array.isArray(record.keys)) return undefined
    return record.keys.find(entry => entry?.id === keyId)
  }

  function requireRecord(provider) {
    const record = recordOf(provider)
    if (record === undefined) throw new Error(`供应商 ${provider} 尚未纳管`)
    return record
  }

  /** 解析池内每个引用与原始引用的值摘要;供归属判断与视图投影。 */
  async function digestSnapshot(record) {
    const digests = new Map()
    for (const key of record.keys) {
      const value = hitValue(await safeResolve(key.ref))
      if (value !== undefined) digests.set(key.ref, digestOf(value))
    }
    const currentRaw = await safeResolve(record.keyRef)
    const currentValue = hitValue(currentRaw)
    const current = currentValue === undefined
      ? null
      : { digest: digestOf(currentValue), tail: tailOf(currentValue) }
    return { digests, current }
  }

  async function safeResolve(ref) {
    try {
      return await ctx.credentials.resolve(ref)
    } catch {
      // 读失败按"无值"处理,与凭据缺失同路;真实错误在写路径再报。
      return undefined
    }
  }

  /** 探测时实时读取供应商 profile(拿 baseURL);设置不可用时回退目录缓存。 */
  function profileOf(provider) {
    const found = directory.get(provider)
    const record = recordOf(provider)
    const ns = record?.settingsNs ?? found?.settingsNs ?? 'llm-pi-ai'
    const descriptor = settings?.describe({ redactSecrets: true })?.find(entry => entry.ns === ns)
    const path = found?.settingsPath ?? ['providers', provider]
    const profile = getPath(descriptor?.value, path)
    return profile !== null && typeof profile === 'object' ? profile : undefined
  }

  /** 余额快照落盘:原子写 + 串行化,失败只留日志(快照可重建,不值得打断请求)。 */
  let quotaTail = Promise.resolve()
  async function persistQuota() {
    // 单独一条串行队列:后台轮、删密钥、手动刷新可能同时触发落盘,
    // 并发写会让"已删除的条目"被后到的旧快照写回文件。
    quotaTail = quotaTail.catch(() => {}).then(async () => {
      try {
        // 与状态文件同理:临时名按实例唯一,避免并发写互相截断。
        const tempPath = `${quotaPath}.${tempSuffix}.tmp`
        await writeFile(tempPath, JSON.stringify(Object.fromEntries(quotaStore), null, 2), 'utf8')
        await renameWithRetry(tempPath, quotaPath)
      } catch (error) {
        ctx.warn?.(`余额快照落盘失败: ${error?.message ?? error}`)
      }
    })
    return quotaTail
  }

  /** 一个供应商的余额快照(不探测);界面打开弹窗只读这个,不再全量探测。 */
  function quotaFor(provider) {
    const record = requireRecord(provider)
    const quotas = {}
    for (const key of record.keys) {
      quotas[key.id] = quotaStore.get(`${provider}\u0000${key.id}`) ?? null
    }
    return { ok: true, provider, quotas }
  }

  /**
   * 后台探测一轮:串行扫全部纳管供应商,组内间隔 quotaProbeGapMs。
   * 由定时器驱动;上一轮未结束时不叠加;探测开着才跑。
   */
  async function backgroundPass() {
    if (backgroundProbing) return
    if (disposed) return
    if (live(config, 'quotaProbe', true) !== true) return
    backgroundProbing = true
    try {
      const gapMs = live(config, 'quotaProbeGapMs', 5_000)
      let stateDirty = false
      let first = true
      for (const listed of Object.values(state.providers)) {
        // 卸载后放弃本轮:继续探测并落盘会把旧实例的状态覆盖到新实例上。
        if (disposed) return
        // 每轮按 provider 重新取活记录:dispatch 与定时同步都会替换
        // state.providers,持有旧对象会让健康写静默丢失(审查 P0-1)。
        const record = recordOf(listed.provider)
        if (record === undefined) continue
        const profile = profileOf(record.provider)
        // 待探列表也取活对象:一轮要探几分钟,期间的同步会换掉密钥集合,
        // 按旧快照遍历会探到已删除的密钥,残留快照还会被写回余额缓存。
        for (const key of [...record.keys]) {
          // 卸载后立即放弃本轮:组内间隔动辄数秒,只在 provider 边界检查不够——
          // 继续探测并落盘会把旧实例的状态覆盖到新实例已经写好的文件上。
          if (disposed) return
          if (!first) await new Promise(resolve => setTimeout(resolve, gapMs))
          first = false
          // force=true:后台轮的目标就是刷新,不被 TTL 短路。
          const payload = await probeKey(ctx, record, key, profile, quotaStore, quotaInflight, true)
          // 探测结果推导健康状态:有效/限流/无效,轮换时据此跳过。
          // 按 id 写回当前内存态的活对象:一轮要探几分钟,期间定时同步
          // 会整体替换 state.providers,写进旧引用的结论会随落盘丢失。
          const settled = settleKeyHealth(state.providers, record.provider, key.id, payload, Date.now())
          if (settled.changed) {
            stateDirty = true
          }
        }
      }
      // 落盘前再确认一次:卸载后不再用旧内存态覆盖新实例已写入的文件。
      if (disposed) return
      await persistQuota()
      if (stateDirty) await persist()
    } catch (error) {
      ctx.warn?.(`后台余额探测失败: ${error?.message ?? error}`)
    } finally {
      backgroundProbing = false
    }
  }

  // 后台定时探测:启动即探一轮,之后每轮开始重读配置
  // (改间隔下一轮即生效,默认 30 分钟)。
  ctx.effect(() => {
    let stopped = false
    // 挂起的等待定时器:卸载时要一并取消,否则进程会多等一个轮间隔
    // (默认 30 分钟)才退出——清理函数只置停止标志取消不了它。
    let pending = undefined
    void (async () => {
      // 等状态读盘 + 首次扫描结束再开跑:否则探测拿不到供应商 profile。
      await startupReady
      if (stopped) return
      let round = 0
      while (!stopped) {
        // 第 0 轮不等待:进程刚起来立刻探一次,之后才按间隔轮转。
        const delayMs = probeRoundDelay(round, live(config, 'quotaIntervalMs', 1_800_000))
        if (delayMs > 0) {
          await new Promise(resolve => {
            pending = setTimeout(resolve, delayMs)
          })
          pending = undefined
          if (stopped) break
        }
        await backgroundPass()
        round += 1
      }
    })()
    return () => {
      stopped = true
      if (pending !== undefined) {
        clearTimeout(pending)
        pending = undefined
      }
    }
  }, 'dsh-key-managment: 后台余额探测定时器')

  /**
   * 扫描 llm 目录 + settings 命名空间:
   * - 已纳管的供应商保留池数据,只刷新 displayName;
   * - 新发现的 Key 型供应商进入运行时目录(unmanaged),
   *   由界面触发"纳管"后才写入状态文件;
   * - 账号登录型(nativeAuth 且无 apiKeyEnv)不出现。
   */
  async function scan() {
    if (settings === undefined) throw new Error('设置服务不可用,无法扫描供应商')
    const entries = await Promise.resolve(ctx.llm.listConfigurableProviders())
    if (!Array.isArray(entries)) throw new Error('llm 目录返回了意外的形状')
    const namespaces = settings.describe({ redactSecrets: true })
    const byNs = new Map(namespaces.map(ns => [ns.ns, ns]))
    directory = new Map()
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || typeof entry.provider !== 'string') continue
      if (typeof entry.error === 'string' && entry.error.length > 0) continue
      const ns = byNs.get(entry.settingsNs)
      const profile = getPath(ns?.value, entry.settingsPath)
      const keyRef = profile !== null && typeof profile === 'object' && typeof profile.apiKeyEnv === 'string'
        ? profile.apiKeyEnv
        : undefined
      if (typeof keyRef !== 'string' || keyRef.length === 0) continue
      const record = recordOf(entry.provider)
      directory.set(entry.provider, {
        provider: entry.provider,
        displayName: entry.displayName ?? entry.provider,
        settingsNs: entry.settingsNs,
        settingsPath: [...(entry.settingsPath ?? [])],
        keyRef,
        managed: record !== undefined,
      })
      // 已纳管的:同步显示名(池数据不动)。
      if (record !== undefined) record.displayName = entry.displayName ?? record.displayName
    }
    return view()
  }

  /** 纳管:把当前原引用密钥导入为 Key_1,并登记原始引用。 */
  async function adopt(provider) {
    const found = directory.get(provider)
    if (found === undefined) throw new Error(`供应商 ${provider} 不可纳管(未发现 API Key 型凭据)`)
    if (recordOf(provider) !== undefined) throw new Error(`供应商 ${provider} 已纳管`)
    const value = hitValue(await safeResolve(found.keyRef))
    if (value === undefined) throw new Error('该供应商当前没有已保存的密钥,请先在设置页填入')
    const ref = newPoolRef(provider)
    await ctx.credentials.set(ref, value)
    const record = newProviderRecord(found.provider, found.displayName, found.settingsNs, found.keyRef)
    record.keys = [{ id: newKeyId(), alias: 'Key_1', ref, createdAt: Date.now(), lastUsedAt: Date.now(), health: 'unknown', cooldownUntil: 0 }]
    // 当前生效的就是这把。
    record.activeKeyId = record.keys[0].id
    record.lastRotatedAt = Date.now()
    state.providers[provider] = record
    found.managed = true
    try {
      await persist()
    } catch (error) {
      // 落盘失败:凭据已写进凭据库而状态文件没有它,
      // 会留下一把无人管理的明文密钥(界面也删不掉),必须补偿清理。
      try { await ctx.credentials.unset(ref) } catch { /* 尽力清理 */ }
      delete state.providers[provider]
      found.managed = false
      throw error
    }
    return view(provider)
  }

  /** 切换:把池内选中值写回原始引用(字面替换);同时重置轮换计数。 */
  async function activate(provider, keyId) {
    const record = requireRecord(provider)
    const key = record.keys.find(entry => entry.id === keyId)
    if (key === undefined) throw new Error('密钥不存在')
    const value = hitValue(await safeResolve(key.ref))
    if (value === undefined) throw new Error('该密钥的值已不可读(可能被外部删除)')
    await ctx.credentials.set(record.keyRef, value)
    // 上面两次 await 期间定时同步可能已替换 state.providers:
    // 状态字段一律按 id 回查活对象再写,写进旧引用会随落盘丢失
    // (界面"生效中"会与真实在用密钥不一致,计数也不清零)。
    const liveRecord = requireRecord(provider)
    const liveKey = liveKeyOf(provider, keyId)
    if (liveKey !== undefined) liveKey.lastUsedAt = Date.now()
    liveRecord.activeKeyId = keyId
    // 无论手动还是自动轮换,换到新密钥都从零计数、重新计时。
    liveRecord.requestCount = 0
    liveRecord.lastRotatedAt = Date.now()
    await persist()
    return view(provider)
  }

  /**
   * 自动轮换到下一把可选密钥:无效/冷却中的限流密钥自动跳过。
   * 候选状态为"未知"时先探测一次落定健康状态再决定用不用;
   * 选中后推进游标,保证整池循环而不是在两把之间打转。
   */
  async function rotateToNext(provider) {
    const total = requireRecord(provider).keys.length
    for (let attempt = 0; attempt < total; attempt += 1) {
      // 每轮重新取活记录:探测期间的 await 可能让 60 秒定时同步整体替换
      // state.providers,手里的旧 record 会成为孤儿——游标推进与候选判定
      // 都必须落在活对象上,否则会反复选中同一把密钥。
      const record = requireRecord(provider)
      const nextId = pickNextKeyId(record, Date.now(), record.activeKeyId ?? undefined)
      if (nextId === undefined) break
      const index = record.keys.findIndex(item => item.id === nextId)
      const key = record.keys[index]
      // 未知候选:先探测一次,探测即落定健康状态(结果同时进余额快照)。
      // 未知与否也读活对象:手里这份 record 可能已是孤儿,它上面的
      // health 停留在上一次同步前的旧值。
      const candidate = liveKeyOf(provider, nextId) ?? key
      if ((candidate.health ?? 'unknown') === 'unknown') {
        const payload = await probeKey(ctx, record, key, profileOf(provider), quotaStore, quotaInflight, true)
        // 按 id 写回活对象:探测期间定时同步可能已替换 state.providers。
        settleKeyHealth(state.providers, provider, key.id, payload, Date.now())
      }
      // 推进游标(无论选不选中,都从这一把之后继续找):写活记录,
      // 否则游标停在旧对象上,池内循环退化成反复选同一把。
      const liveRecord = requireRecord(provider)
      const liveIndex = liveRecord.keys.findIndex(item => item.id === nextId)
      if (liveIndex >= 0) liveRecord.cursor = (liveIndex + 1) % liveRecord.keys.length
      // 候选判定必须读活对象:上面的探测结论写在活对象上,手里这份
      // record 可能已是孤儿,照旧读会漏掉"该密钥正在限流"的事实,
      // 轮换就会选中一把限流中的密钥。
      const liveKey = liveKeyOf(provider, nextId) ?? key
      if (!isSelectable(liveKey, Date.now())) continue
      try {
        await activate(provider, nextId)
        return true
      } catch (error) {
        // 选中密钥的值不可读(ref 被外部删除等):标记无效并尝试下一把,
        // 不能让单个坏候选中断整池轮换(审查 P1-6)。
        ctx.warn?.(`轮换选中 ${key.alias} 失败,标记无效并跳过: ${error?.message ?? error}`)
        // 同样写活对象:孤儿上的标记会随落盘丢失,坏密钥将永远保持可用。
        const target = liveKeyOf(provider, nextId) ?? key
        target.health = 'invalid'
        target.cooldownUntil = 0
        target.cooldownLevel = 0
        // 计数同样要写在活记录上:写进旧对象就清不掉,
        // 阈值持续满足 → 之后每个请求都触发一次轮换。
        requireRecord(provider).requestCount = 0
        await persist()
      }
    }
    ctx.warn?.(`${provider} 池内没有可轮换的密钥(全部无效或限流冷却中)`)
    await persist()
    return false
  }

  /** 设置供应商的自动轮换配置。 */
  async function setRotation(provider, patch) {
    const record = requireRecord(provider)
    const merged = normalizeRotation({ ...normalizeRotation(record.rotation), ...patch })
    record.rotation = merged
    await persist()
    return view(provider)
  }

  /**
   * 添加一把密钥到池内;返回失败原因(null 表示成功)。
   * 单条添加与批量导入共用这条路径,保证校验与去重规则一致。
   *
   * @param createdRefs 收集本次写入的凭据引用,供调用方在落盘失败时补偿清理
   * @param existingDigests 预取的池内摘要(批量导入用,避免 O(N²) 逐把 resolve)
   */
  async function addKeyEntry(record, value, alias, createdRefs, existingDigests) {
    const keyError = validateKeyValue(value)
    if (keyError !== null) return keyError
    const aliasError = validateAlias(alias)
    if (aliasError !== null) return aliasError
    if (record.keys.length >= MAX_KEYS_PER_PROVIDER) {
      return `密钥池已满(上限 ${MAX_KEYS_PER_PROVIDER} 把)`
    }
    const digest = digestOf(value)
    if (existingDigests !== undefined) {
      if (existingDigests.has(digest)) return '该密钥已在池内'
    } else {
      for (const existing of record.keys) {
        const existingValue = hitValue(await safeResolve(existing.ref))
        if (existingValue !== undefined && digestOf(existingValue) === digest) {
          return '该密钥已在池内'
        }
      }
    }
    const ref = newPoolRef(record.provider)
    await ctx.credentials.set(ref, value)
    createdRefs?.push(ref)
    // 上面 await 期间定时同步可能已替换 state.providers:
    // push 进旧数组等于没加——活池子里没这把,凭据却留在凭据库成了无主明文。
    // 按 provider 回查活记录再写入。
    const liveRecord = requireRecord(record.provider)
    liveRecord.keys.push({
      id: newKeyId(),
      alias: alias?.trim() || nextAlias(liveRecord.keys),
      ref,
      createdAt: Date.now(),
      lastUsedAt: 0,
    })
    return null
  }

  /** 落盘失败时补偿清理本次已写入的凭据引用,避免游离明文(审查 P2-3)。 */
  async function persistWithCompensation(record, createdRefs) {
    try {
      await persist()
    } catch (error) {
      for (const ref of createdRefs) {
        try { await ctx.credentials.unset(ref) } catch { /* 尽力清理 */ }
      }
      // 回滚内存态,保持与磁盘一致。注意要回滚**活记录**:
      // addKeyEntry 把新密钥 push 进了活记录,回滚旧记录等于没回滚——
      // 凭据已删,池子里却留着这把指向空凭据的密钥。
      const liveRecord = recordOf(record.provider) ?? record
      liveRecord.keys = liveRecord.keys.filter(key => !createdRefs.includes(key.ref))
      throw error
    }
  }

  /** 添加密钥:默认命名 Key_n,值重复时拒绝。 */
  async function addKey(provider, value, alias) {
    const record = requireRecord(provider)
    const createdRefs = []
    const reason = await addKeyEntry(record, value, alias, createdRefs)
    if (reason !== null) throw new Error(reason)
    await persistWithCompensation(record, createdRefs)
    return view(provider)
  }

  /**
   * 批量导入:每行一个密钥,逐行报告结果。
   * 部分成功是预期结果:失败的行给出原因与行号,不影响其它行。
   */
  async function addKeys(provider, text) {
    const record = requireRecord(provider)
    const { entries, failures } = parseBatchEntries(text)
    // 池内摘要只预取一次:批量 N 行 × M 把的逐把 resolve 会退化成 O(N²)(审查 P3)。
    const { digests } = await digestSnapshot(record)
    const existingDigests = new Set(digests.values())
    const result = { added: 0, failures: [...failures] }
    const createdRefs = []
    for (const entry of entries) {
      const reason = await addKeyEntry(record, entry.value, entry.alias, createdRefs, existingDigests)
      if (reason === null) result.added += 1
      else result.failures.push({ line: entry.line, reason })
    }
    if (result.added > 0) await persistWithCompensation(record, createdRefs)
    const snapshot = await view(provider)
    return { ...snapshot, added: result.added, failures: result.failures }
  }

  /** 把当前生效但不在池内的密钥一键纳管。 */
  async function adoptCurrent(provider) {
    const record = requireRecord(provider)
    const value = hitValue(await safeResolve(record.keyRef))
    if (value === undefined) throw new Error('原始引用当前没有值')
    return addKey(provider, value)
  }

  async function renameKey(provider, keyId, alias) {
    const record = requireRecord(provider)
    const key = record.keys.find(entry => entry.id === keyId)
    if (key === undefined) throw new Error('密钥不存在')
    const aliasError = validateAlias(alias)
    if (aliasError !== null) throw new Error(aliasError)
    const trimmed = alias?.trim()
    if (!trimmed) throw new Error('名称不能为空')
    key.alias = trimmed
    await persist()
    return view(provider)
  }

  /** 删除池内密钥;生效中的密钥不允许删,避免误删后无从恢复。 */
  async function deleteKey(provider, keyId) {
    const record = requireRecord(provider)
    const index = record.keys.findIndex(entry => entry.id === keyId)
    if (index < 0) throw new Error('密钥不存在')
    const { digests, current } = await digestSnapshot(record)
    const key = record.keys[index]
    if (current !== null && findKeyByDigest(record, digests, current.digest)?.id === key.id) {
      // 原引用值就是这把时,禁止删除:它还在为实际请求服务。
      throw new Error('生效中的密钥不能删除;先切换到其他密钥')
    }
    // 上面 await 期间定时同步可能已替换 state.providers:
    // splice 旧数组等于没删——活池子里这把还在,凭据却已删,界面会留一把死密钥。
    // 按 provider 回查活记录再删。
    const liveRecord = requireRecord(provider)
    const liveIndex = liveRecord.keys.findIndex(entry => entry.id === keyId)
    if (liveIndex >= 0) liveRecord.keys.splice(liveIndex, 1)
    // 同步清掉余额快照:否则残留条目随 view 永久下发,无界增长(审查 P2-1)。
    quotaStore.delete(`${provider}\u0000${key.id}`)
    try {
      await ctx.credentials.unset(key.ref)
    } catch {
      // 凭据清不掉不阻塞删除:状态文件已不含该引用,残留值无害。
    }
    await persist()
    await persistQuota()
    return view(provider)
  }

  /** 取消纳管:只移除池数据与插件凭据,原始引用与现值不动。 */
  async function removeProvider(provider) {
    const record = requireRecord(provider)
    for (const key of record.keys) {
      // 余额快照一并清掉(审查 P2-1)。
      quotaStore.delete(`${provider}\u0000${key.id}`)
      try {
        await ctx.credentials.unset(key.ref)
      } catch {
        // 同 deleteKey:残留凭据无害。
      }
    }
    delete state.providers[provider]
    await persist()
    await persistQuota()
    // 目录标记只在内存里(不落盘),改完不必再写一次状态文件。
    const found = directory.get(provider)
    if (found !== undefined) found.managed = false
    return view()
  }

  /** 全量视图:纳管供应商 + 未纳管的可纳管目录。 */
  async function view(focusProvider) {
    const providers = []
    for (const record of Object.values(state.providers)) {
      const { digests, current } = await digestSnapshot(record)
      providers.push(projectProvider(record, digests, current))
    }
    const available = [...directory.values()]
      .filter(entry => !entry.managed)
      .map(entry => ({
        provider: entry.provider,
        displayName: entry.displayName,
        keyRef: entry.keyRef,
      }))
    // 全量余额快照随视图下发:界面打开弹窗零探测,直接渲染。
    const quotas = {}
    for (const [cacheKey, payload] of quotaStore) {
      quotas[cacheKey.replace('\u0000', '/')] = payload
    }
    return {
      ok: true,
      focus: focusProvider ?? null,
      providers,
      available,
      quotas,
      managedCount: providers.length,
      keyCount: providers.reduce((sum, entry) => sum + entry.keyCount, 0),
    }
  }

  /** 单把密钥的余额探测;force 时先丢缓存强制重探(结果即写快照)。 */
  async function quotaOne(provider, keyId, force) {
    const record = requireRecord(provider)
    const key = record.keys.find(entry => entry.id === keyId)
    if (key === undefined) throw new Error('密钥不存在')
    if (live(config, 'quotaProbe', true) !== true) {
      throw new Error('余额探测已在插件配置中关闭')
    }
    if (force) quotaStore.delete(`${provider}\u0000${keyId}`)
    const payload = await probeKey(ctx, record, key, profileOf(provider), quotaStore, quotaInflight, force === true)
    // 手动探测也要落定健康状态:否则徽标(来自状态文件)与圆环(来自本次探测)
    // 会各说各话——圆环已经报"密钥无效",徽标还挂着"有效"。
    const settled = settleKeyHealth(state.providers, provider, key.id, payload, Date.now())
    if (settled.changed) {
      await persist()
    }
    await persistQuota()
    return { ok: true, payload }
  }

  /** 读取当前插件配置(界面展示用)。 */
  function readConfig() {
    return {
      ok: true,
      quotaProbe: live(config, 'quotaProbe', true),
      quotaIntervalMs: live(config, 'quotaIntervalMs', 1_800_000),
      quotaProbeGapMs: live(config, 'quotaProbeGapMs', 5_000),
    }
  }

  /** 写插件配置:经 configEditor 走 Loader 正常落盘;volatile 字段即时生效。 */
  async function writeConfig(patch) {
    // 校验规则放在 core 的纯函数里,与单测共用同一份:
    // 界面按一套规则、宿主按另一套,是最常见的手写校验错位来源。
    const configError = validateProbeConfig(patch)
    if (configError !== null) throw new Error(configError)
    const entry = ctx.fiber?.entry
    if (entry === undefined || configEditor === undefined) {
      throw new Error('当前环境不支持配置写入')
    }
    await configEditor.edit(entry, current => ({ ...current, ...patch }))
    return readConfig()
  }

  /** 会改动池数据的动作:执行前先重读磁盘,避免用陈旧内存状态覆盖最新文件。 */
  const MUTATING_ACTIONS = new Set([
    'adoptProvider',
    'addKey',
    'addKeys',
    'adoptCurrentKey',
    'activateKey',
    'renameKey',
    'deleteKey',
    'removeProvider',
    'rotateNow',
    'setRotation',
    'refresh',
    // quotaKey 会把探测结论写回健康状态,同样要先以磁盘为准。
    'quotaKey',
  ])

  /**
   * 以磁盘为准原位同步 providers:陈旧实例(重载残留)的内存配置可能与
   * 磁盘不一致,导致"界面已关闭轮换却仍在轮换"(审查后用户实测命中)。
   *
   * 轮换配置(模式/间隔/次数)一律以磁盘为准;但 requestCount 是本进程
   * 累计的调用数,磁盘上只是上次落盘时的快照——这里保留内存里的较大值,
   * 否则每 60 秒一次的定时同步会把计数清零,"按调用次数轮换"永远触发不了。
   */
  async function syncProvidersFromDisk() {
    const fresh = normalizeState(await readStateFile(statePath))
    state.providers = mergeRuntimeState(state.providers, fresh.providers)
  }

  /** 动作分派;所有变更动作串行执行。 */
  async function dispatch(body) {
    const parsed = parseAction(body)
    if (parsed.error !== undefined) throw new Error(parsed.error)
    const { action, provider, keyId, alias, value, force } = parsed
    // 初始化未完成时先等它,避免在状态还没读盘时动数据。
    await ready.catch(() => {})
    // 首次扫描可重试:settings 注入晚于启动时这里补扫;只读动作失败也继续。
    await ensureScanned().catch(() => {})
    if (MUTATING_ACTIONS.has(action)) {
      // 重读磁盘并原位同步(替换 state 对象会让后台轮/stream 归因的旧引用失联)。
      await syncProvidersFromDisk()
    }
    switch (action) {
      case 'getState':
        return view()
      case 'refresh':
        return scan()
      case 'adoptProvider':
        if (!provider) throw new Error('缺少 provider')
        return adopt(provider)
      case 'addKey':
        if (!provider) throw new Error('缺少 provider')
        return addKey(provider, value, alias)
      case 'addKeys':
        if (!provider) throw new Error('缺少 provider')
        if (typeof body.text !== 'string') throw new Error('缺少 text 字段')
        return addKeys(provider, body.text)
      case 'adoptCurrentKey':
        if (!provider) throw new Error('缺少 provider')
        return adoptCurrent(provider)
      case 'activateKey':
        if (!provider || !keyId) throw new Error('缺少 provider 或 keyId')
        return activate(provider, keyId)
      case 'renameKey':
        if (!provider || !keyId || alias === undefined) throw new Error('缺少 provider、keyId 或 alias')
        return renameKey(provider, keyId, alias)
      case 'deleteKey':
        if (!provider || !keyId) throw new Error('缺少 provider 或 keyId')
        return deleteKey(provider, keyId)
      case 'removeProvider':
        if (!provider) throw new Error('缺少 provider')
        return removeProvider(provider)
      case 'quotaProvider':
        if (!provider) throw new Error('缺少 provider')
        return quotaFor(provider)
      case 'setRotation':
        if (!provider) throw new Error('缺少 provider')
        return setRotation(provider, {
          ...(body.mode !== undefined ? { mode: body.mode } : {}),
          ...(body.intervalMs !== undefined ? { intervalMs: body.intervalMs } : {}),
          ...(body.requests !== undefined ? { requests: body.requests } : {}),
        })
      case 'rotateNow':
        if (!provider) throw new Error('缺少 provider')
        // 返回完整视图:客户端把响应当作全量状态渲染,缺字段会崩。
        return rotateToNext(provider)
          .then(async rotated => ({ ...(await view(provider)), rotated }))
      case 'quotaKey':
        if (!provider || !keyId) throw new Error('缺少 provider 或 keyId')
        return quotaOne(provider, keyId, force === true)
      case 'getConfig':
        return readConfig()
      case 'setConfig':
        return writeConfig({
          ...(body.quotaProbe !== undefined ? { quotaProbe: body.quotaProbe } : {}),
          ...(body.quotaIntervalMs !== undefined ? { quotaIntervalMs: body.quotaIntervalMs } : {}),
          ...(body.quotaProbeGapMs !== undefined ? { quotaProbeGapMs: body.quotaProbeGapMs } : {}),
        })
      default:
        throw new Error(`未知动作: ${action}`)
    }
  }

  // 首次扫描不在 ready 里做:settings 注入可能晚于启动,
  // 扫描统一由 settings 就绪后的补扫与 API 调用前的 ensureScanned 触发。

  // 请求归因:llm/stream 瀑布里按供应商计数;按调用次数的自动轮换在这里触发。
  // 注意:该瀑布不 await 监听器返回值——监听器必须同步返回 AsyncIterable,
  // 返回 Promise 会导致 "upstream is not async iterable"。
  ctx.effect(() => ctx.on('llm/stream', (options, next) => {
    let rotationProvider = undefined
    try {
      const providerId = options?.provider
      const record = typeof providerId === 'string' ? recordOf(providerId) : undefined
      if (record !== undefined) {
        // 只统计被本插件管理的池;计数先加,再判断是否触发按次数轮换。
        record.requestCount = (record.requestCount ?? 0) + 1
        const rotation = normalizeRotation(record.rotation)
        if (shouldRotateCalls(rotation, record.requestCount)) {
          rotationProvider = providerId
        }
      }
    } catch (error) {
      // 归因失败不阻断请求本身。
      ctx.warn?.(`请求计数失败: ${error?.message ?? error}`)
    }
    if (rotationProvider === undefined) return next()
    // 触发按次数轮换:上游迭代器先取好,包装成 async generator——
    // 在产出第一个块之前完成密钥切换(credentials.set),再透传上游。
    const upstream = next()
    return (async function* () {
      try {
        // 内存配置可能是陈旧实例残留(界面已改"关闭"但这里没跟上):
        // 触发阈值时以磁盘为准复核,不符则纠正内存并放弃轮换。
        const disk = normalizeState(await readStateFile(statePath))
        const diskRecord = disk.providers[rotationProvider]
        const diskRotation = normalizeRotation(diskRecord?.rotation)
        const record = recordOf(rotationProvider)
        if (record !== undefined && diskRecord !== undefined) {
          if (diskRotation.mode !== normalizeRotation(record.rotation).mode) {
            record.rotation = diskRotation
            record.requestCount = 0
          }
        }
        if (diskRotation.mode === 'calls' && shouldRotateCalls(diskRotation, (record?.requestCount ?? 0))) {
          await rotateToNext(rotationProvider)
        }
      } catch (error) {
        ctx.warn?.(`按次数自动轮换失败: ${error?.message ?? error}`)
      }
      for await (const chunk of upstream) {
        yield chunk
      }
    })()
  }), 'dsh-key-managment: llm/stream 请求计数')

  // 定时轮换:每 60 秒先以磁盘同步配置(陈旧实例自愈),再检查 interval 到点。
  ctx.effect(() => {
    const timer = setInterval(() => {
      void (async () => {
        try {
          await syncProvidersFromDisk()
        } catch {
          // 读盘失败就按内存判定,不要中断检查。
        }
        const now = Date.now()
        for (const record of Object.values(state.providers)) {
          const rotation = normalizeRotation(record.rotation)
          if (shouldRotateInterval(rotation, record.lastRotatedAt ?? 0, now)) {
            void rotateToNext(record.provider).catch((error) => {
              ctx.warn?.(`定时轮换失败(${record.provider}): ${error?.message ?? error}`)
            })
          }
        }
      })()
    }, 60_000)
    return () => { clearInterval(timer) }
  }, 'dsh-key-managment: 定时轮换检查')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH,
    handler: async (req, res) => {
      const sendJson = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(payload))
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      if (req.method !== 'POST') {
        sendJson(405, { ok: false, error: '仅支持 POST' })
        return
      }
      // 请求体上限:状态视图与动作参数都很小,1 MiB 足够并防御滥用。
      // 按 Buffer 收集再统一解码:逐块 += 会把跨块的多字节 UTF-8 打碎成 U+FFFD
      // (中文别名/批量文本常见);close/error 都要 resolve,destroy 后才不会挂死。
      const MAX_BODY_BYTES = 1024 * 1024
      const chunks = []
      let received = 0
      let oversized = false
      let finishBody
      const bodyReady = new Promise(resolve => { finishBody = resolve })
      req.on('data', (chunk) => {
        received += chunk.length
        if (received > MAX_BODY_BYTES) {
          // 超限后不再累积也不再继续读:先把 413 回给客户端再断开。
          // 先 destroy 再回响应的话,客户端只会看到连接重置,拿不到 413。
          oversized = true
          req.pause()
          finishBody()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', finishBody)
      req.on('error', finishBody)
      req.on('close', finishBody)
      await bodyReady
      if (oversized) {
        // 响应写完再断开连接:保证客户端能收到 413。
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: '请求体过大' }), () => { req.destroy() })
        return
      }
      let body
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        body = raw.length > 0 ? JSON.parse(raw) : {}
      } catch {
        sendJson(400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
      // 变更动作串行;读动作走同一队列以保证视图一致性(负载极低,无性能顾虑)。
      const result = await (mutationTail = mutationTail
        .then(() => dispatch(body))
        .then(payload => ({ status: 200, payload }))
        .catch(error => ({ status: 400, payload: { ok: false, error: error?.message ?? String(error) } })))
      sendJson(result.status, result.payload)
    },
  }), 'dsh-key-managment: API 路由')
}
