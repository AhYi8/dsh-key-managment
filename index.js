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
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { probeKey } from './quota-bridge.js'
import {
  healthFromQuota,
  isSelectable,
  MAX_KEYS_PER_PROVIDER,
  digestOf,
  findKeyByDigest,
  newKeyId,
  newPoolRef,
  newProviderRecord,
  nextAlias,
  normalizeState,
  normalizeRotation,
  parseAction,
  parseBatchEntries,
  pickNextKeyId,
  projectProvider,
  shouldRotateCalls,
  shouldRotateInterval,
  tailOf,
  validateAlias,
  validateKeyValue,
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

/** 从凭据 resolve 的返回值里提取明文;返回形状做防御性兼容。 */
function hitValue(hit) {
  if (hit === undefined || hit === null) return undefined
  if (typeof hit === 'string') return hit
  if (typeof hit.value === 'string' && hit.value.length > 0) return hit.value
  if (typeof hit.secret === 'string' && hit.secret.length > 0) return hit.secret
  return undefined
}

/** 读取一个 volatile 配置字段的当前值(取值器或字面量)。 */
function live(config, field, fallback) {
  const value = config?.[field]
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value === undefined ? fallback : value
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
    void ensureScanned().catch((error) => {
      ctx.warn?.(`扫描失败(可在界面手动刷新): ${error?.message ?? error}`)
    })
    return () => { settings = undefined }
  }), 'dsh-key-managment: settings 获取')

  ctx.effect(() => ctx.inject(['configEditor'], (scope) => {
    configEditor = scope.configEditor
    return () => { configEditor = undefined }
  }), 'dsh-key-managment: configEditor 获取')

  async function readStateFile(path) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      // 首次运行或文件损坏:normalizeState 会兜底为空状态。
      return undefined
    }
  }

  /**
   * 原子化写状态文件:先写临时文件再改名。
   * persistTail 串行化所有落盘:定时轮、stream 归因、API 变更都可能并发
   * 触发 persist,交错写同一个临时文件会落成半截 JSON(审查 P0-1)。
   */
  let persistTail = Promise.resolve()
  function persist() {
    persistTail = persistTail.then(async () => {
      const tempPath = `${statePath}.tmp`
      await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8')
      await rename(tempPath, statePath)
    })
    return persistTail
  }

  function recordOf(provider) {
    return state.providers[provider]
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

  /** 余额快照落盘:原子写,失败只留日志(快照可重建,不值得打断请求)。 */
  async function persistQuota() {
    try {
      const tempPath = `${quotaPath}.tmp`
      await writeFile(tempPath, JSON.stringify(Object.fromEntries(quotaStore), null, 2), 'utf8')
      await rename(tempPath, quotaPath)
    } catch (error) {
      ctx.warn?.(`余额快照落盘失败: ${error?.message ?? error}`)
    }
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
    if (live(config, 'quotaProbe', true) !== true) return
    backgroundProbing = true
    try {
      const gapMs = live(config, 'quotaProbeGapMs', 5_000)
      let stateDirty = false
      let first = true
      for (const listed of Object.values(state.providers)) {
        // 每次迭代重新按 provider 取记录:dispatch 的原位重读会替换
        // state.providers,持有旧对象会让健康写静默丢失(审查 P0-1)。
        const record = recordOf(listed.provider)
        if (record === undefined) continue
        const profile = profileOf(record.provider)
        for (const key of record.keys) {
          if (!first) await new Promise(resolve => setTimeout(resolve, gapMs))
          first = false
          // force=true:后台轮的目标就是刷新,不被 TTL 短路。
          const payload = await probeKey(ctx, record, key, profile, quotaStore, quotaInflight, true)
          // 探测结果推导健康状态:有效/限流/无效,轮换时据此跳过。
          const verdict = healthFromQuota(payload, key.health ?? 'unknown', key.cooldownLevel ?? 0, Date.now())
          if (key.health !== verdict.health || (key.cooldownUntil ?? 0) !== verdict.cooldownUntil) {
            key.health = verdict.health
            key.cooldownUntil = verdict.cooldownUntil
            key.cooldownLevel = verdict.level
            stateDirty = true
          }
        }
      }
      await persistQuota()
      if (stateDirty) await persist()
    } catch (error) {
      ctx.warn?.(`后台余额探测失败: ${error?.message ?? error}`)
    } finally {
      backgroundProbing = false
    }
  }

  // 后台定时探测:每轮开始重读配置,改间隔下一轮即生效(默认 30 分钟)。
  ctx.effect(() => {
    let stopped = false
    void (async () => {
      while (!stopped) {
        const intervalMs = Math.max(60_000, live(config, 'quotaIntervalMs', 1_800_000))
        await new Promise(resolve => setTimeout(resolve, intervalMs))
        if (stopped) break
        await backgroundPass()
      }
    })()
    return () => { stopped = true }
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
    await persist()
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
    key.lastUsedAt = Date.now()
    record.activeKeyId = key.id
    // 无论手动还是自动轮换,换到新密钥都从零计数、重新计时。
    record.requestCount = 0
    record.lastRotatedAt = Date.now()
    await persist()
    return view(provider)
  }

  /**
   * 自动轮换到下一把可选密钥:无效/冷却中的限流密钥自动跳过。
   * 候选状态为"未知"时先探测一次落定健康状态再决定用不用;
   * 选中后推进游标,保证整池循环而不是在两把之间打转。
   */
  async function rotateToNext(provider) {
    const record = requireRecord(provider)
    const total = record.keys.length
    for (let attempt = 0; attempt < total; attempt += 1) {
      const nextId = pickNextKeyId(record, Date.now(), record.activeKeyId ?? undefined)
      if (nextId === undefined) break
      const key = record.keys.find(item => item.id === nextId)
      const index = record.keys.findIndex(item => item.id === nextId)
      // 未知候选:先探测一次,探测即落定健康状态(结果同时进余额快照)。
      if ((key.health ?? 'unknown') === 'unknown') {
        const payload = await probeKey(ctx, record, key, profileOf(provider), quotaStore, quotaInflight, true)
        const verdict = healthFromQuota(payload, key.health ?? 'unknown', key.cooldownLevel ?? 0, Date.now())
        key.health = verdict.health
        key.cooldownUntil = verdict.cooldownUntil
        key.cooldownLevel = verdict.level
      }
      // 推进游标(无论选不选中,都从这一把之后继续找)。
      record.cursor = (index + 1) % total
      if (!isSelectable(key, Date.now())) continue
      try {
        await activate(provider, nextId)
        return true
      } catch (error) {
        // 选中密钥的值不可读(ref 被外部删除等):标记无效并尝试下一把,
        // 不能让单个坏候选中断整池轮换(审查 P1-6)。
        ctx.warn?.(`轮换选中 ${key.alias} 失败,标记无效并跳过: ${error?.message ?? error}`)
        key.health = 'invalid'
        key.cooldownUntil = 0
        key.cooldownLevel = 0
        record.requestCount = 0
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
    record.keys.push({
      id: newKeyId(),
      alias: alias?.trim() || nextAlias(record.keys),
      ref,
      createdAt: Date.now(),
      lastUsedAt: 0,
    })
    return null
  }

  /** 添加密钥:默认命名 Key_n,值重复时拒绝。 */
  /** 落盘失败时补偿清理本次已写入的凭据引用,避免游离明文(审查 P2-3)。 */
  async function persistWithCompensation(record, createdRefs) {
    try {
      await persist()
    } catch (error) {
      for (const ref of createdRefs) {
        try { await ctx.credentials.unset(ref) } catch { /* 尽力清理 */ }
      }
      // 回滚内存态,保持与磁盘一致。
      record.keys = record.keys.filter(key => !createdRefs.includes(key.ref))
      throw error
    }
  }

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
    record.keys.splice(index, 1)
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
    const found = directory.get(provider)
    if (found !== undefined) found.managed = false
    await persist()
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
    if (patch.quotaProbe !== undefined && typeof patch.quotaProbe !== 'boolean') {
      throw new Error('quotaProbe 必须是布尔值')
    }
    if (patch.quotaIntervalMs !== undefined
      && (typeof patch.quotaIntervalMs !== 'number' || patch.quotaIntervalMs < 60_000 || patch.quotaIntervalMs > 86_400_000)) {
      throw new Error('quotaIntervalMs 必须是 60000-86400000 之间的数字')
    }
    if (patch.quotaProbeGapMs !== undefined
      && (typeof patch.quotaProbeGapMs !== 'number' || patch.quotaProbeGapMs < 200 || patch.quotaProbeGapMs > 60_000)) {
      throw new Error('quotaProbeGapMs 必须是 200-60000 之间的数字')
    }
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
  ])

  /**
   * 以磁盘为准原位同步 providers:陈旧实例(重载残留)的内存配置可能与
   * 磁盘不一致,导致"界面已关闭轮换却仍在轮换"(审查后用户实测命中)。
   */
  async function syncProvidersFromDisk() {
    const fresh = normalizeState(await readStateFile(statePath))
    state.providers = fresh.providers
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

  // 启动扫描已在 ready 里完成(读盘 + scan);这里不再重复扫描。

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
      const chunks = []
      let received = 0
      let oversized = false
      req.on('data', (chunk) => {
        chunks.push(chunk)
        received += chunk.length
        if (received > 1024 * 1024) {
          oversized = true
          req.destroy()
        }
      })
      await new Promise((resolve) => {
        req.on('end', resolve)
        req.on('error', resolve)
        req.on('close', resolve)
      })
      if (oversized) {
        sendJson(413, { ok: false, error: '请求体过大' })
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
