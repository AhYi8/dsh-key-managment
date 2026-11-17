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
 * 轮换:支持手动切换、按调用次数/定时自动轮换,以及调用失败时的换钥兜底
 * (零内容阶段识别密钥级/额度级失败后切到下一把可选密钥并重放)。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createClient as createWebdavClient } from 'webdav'
import z from '@deepseek-ai/schemastery'
import { probeKey } from './quota-bridge.js'
import {
  backupsToDelete,
  backupFileName,
  buildSnapshot,
  decryptSnapshot,
  encryptSnapshot,
  listBackups,
  normalizeRestoredSnapshot,
  parseBackupFileName,
  planRestore,
  sanitizeDeviceName,
  validateBackupConfig,
} from './backup.js'
import {
  classifyStreamFailure,
  hitValue,
  isFallbackFailureChunk,
  isSelectable,
  isStreamContentChunk,
  MAX_ALIAS_LENGTH,
  QUOTA_COOLDOWN_MS,
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
  /** 调用遇密钥失效或额度不足时自动换钥重发(兜底),默认开启。 */
  fallbackOnFailure: z.boolean().default(true).volatile(),
  /* ---- WebDAV 备份:定时上传加密快照,恢复为手动选版本覆盖 ---- */
  /** 是否启用定时备份;关闭后仅可手动备份。 */
  webdavEnabled: z.boolean().default(false).volatile(),
  /** WebDAV 服务地址,如 https://dav.jianguoyun.com/dav/。 */
  webdavUrl: z.string().default('').volatile(),
  webdavUsername: z.string().default('').volatile(),
  /** WebDAV 密码/应用密码;存本机配置,不上传。 */
  webdavPassword: z.string().default('').volatile(),
  /** 远程备份目录(相对服务根),不存在时会尝试创建。 */
  webdavDir: z.string().default('dsh-key-managment').volatile(),
  /** 备份加密密钥:多端必须一致,否则解密失败(恢复会被拒绝)。 */
  webdavEncryptKey: z.string().default('').volatile(),
  /** 设备名:备份文件名前缀与轮转分组;留空取主机名。 */
  webdavDevice: z.string().default('').volatile(),
  /** 定时备份间隔(分钟),下限 5。 */
  webdavIntervalMin: z.number().step(1).min(5).max(1440).default(60).volatile(),
  /** 每台设备保留的备份份数,超出删最旧。 */
  webdavKeep: z.number().step(1).min(1).max(50).default(5).volatile(),
})

/** 同源 API 路由路径;客户端用同一常量访问。 */
export const API_PATH = '/dsh-key-managment/api'

/**
 * 同一 turn 内「额度/欠费」失败重复换钥的次数上限。
 *
 * 额度是账户级状态:池内密钥往往同属一个账户,继续逐把试只会把一次用户请求
 * 放大成几十次失败请求与写盘。密钥级失败不设这个上限——每把确实是坏钥,
 * 跳过它才是正确行为(按用户要求"试到耗尽")。
 */
const QUOTA_FALLBACK_MAX_PER_TURN = 1

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
  /** 最近一次备份结果;界面展示"备份了什么时间、成功与否"。 */
  let backupStatus = { lastRunAt: 0, ok: false, error: null, file: null, deletedFailures: [] }
  /** 上次定时备份的触发时间;0 表示启动后先补一次。 */
  let lastBackupAt = 0
  /** 备份在途标志:上一次未结束时跳过本轮,防止 WebDAV 卡死时无限叠加。 */
  let backupInFlight = false

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
    ctx.logger.warn(`初始化失败: ${error?.message ?? error}`)
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
    ctx.logger.warn('后台探测启动闸门超时:未等到 settings 就绪,先按目录默认端点探一轮')
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
        ctx.logger.warn(`扫描失败(可在界面手动刷新): ${error?.message ?? error}`)
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
    } catch (error) {
      // 首次运行(文件不存在)属正常;文件存在却解析失败说明状态损坏,
      // 静默吞掉会让后续所有"以磁盘为准"的判断都建立在空态上,必须留痕。
      if (error?.code !== 'ENOENT') {
        ctx.logger.warn(`状态文件读取失败(按空状态兜底): ${path}: ${error?.message ?? error}`)
      }
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
        ctx.logger.warn(`余额快照落盘失败: ${error?.message ?? error}`)
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
      ctx.logger.warn(`后台余额探测失败: ${error?.message ?? error}`)
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
   * 轮换的实际实现(不加锁)。
   *
   * 只给已经持锁的调用方用(兜底路径),其余入口一律走下面的
   * `rotateToNext`——否则按次数/定时/手动与兜底会交错推进游标,
   * 一次故障白跳两把密钥。
   */
  async function rotateToNextUnlocked(provider, options = {}) {
    const probeUnknown = options.probeUnknown !== false
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
      if (probeUnknown && (candidate.health ?? 'unknown') === 'unknown') {
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
        ctx.logger.warn(`轮换选中 ${key.alias} 失败,标记无效并跳过: ${error?.message ?? error}`)
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
    ctx.logger.warn(`${provider} 池内没有可轮换的密钥(全部无效或限流冷却中)`)
    await persist()
    return false
  }

  /**
   * 自动轮换到下一把可选密钥:无效/冷却中的限流密钥自动跳过。
   * 候选状态为"未知"时先探测一次落定健康状态再决定用不用;
   * 选中后推进游标,保证整池循环而不是在两把之间打转。
   *
   * 所有触发入口共用同一把切换锁:按次数、定时、手动与失败兜底并发时
   * 只允许一次轮换,否则会一次故障连跳多把。
   *
   * @param options.probeUnknown 未知候选是否先探测。真正的用户请求路径
   *   (调用失败兜底)必须传 false:那里多打一次探测请求会直接拖慢用户请求,
   *   而失败本身已经证明了候选需要换。
   */
  function rotateToNext(provider, options = {}) {
    return withSwitchLock(provider, () => rotateToNextUnlocked(provider, options))
  }

  /**
   * 每个供应商一把切换锁:并发请求同时撞上同一把失效密钥时,只允许一次轮换。
   *
   * 没有它的话,N 个并发请求会各自读到同一个 activeKeyId,依次把游标推 N 次,
   * 一次故障能白跳掉 N 把可用密钥。
   */
  const switchLocks = new Map()
  function withSwitchLock(provider, task) {
    const previous = switchLocks.get(provider) ?? Promise.resolve()
    // 前一次失败也要继续排:锁链不能因一次异常永久拒绝后续请求。
    const run = previous.then(task, task)
    switchLocks.set(provider, run.then(() => {}, () => {}))
    return run
  }

  /**
   * 每次请求的失败归因快照,按 AbortSignal 关联。
   *
   * llm/stream 与 agent/request-error 是两段不同的瀑布,payload 里都没有请求 id;
   * agent loop 把同一个 phase signal 同时放进请求对象和 request-error 事件,
   * 因此可以用 signal 的对象身份把"这次失败用的是哪把密钥、是否零内容"带到
   * 恢复点。键是 signal,恢复点消费时显式 delete,未消费的条目随 signal
   * 被回收,不需要额外清理。
   */
  const pendingFailures = new WeakMap()

  /**
   * 下一次出站是「兜底触发的重发」的标记(按 signal)。
   * 按调用次数轮换只该数用户的请求,不把兜底重发也算一次;
   * DSH 自己的重试(429 等)不经过这里,仍按原有口径计数。
   */
  const recoveryRetries = new WeakSet()

  /** 同一 turn 内因额度失败换钥的次数,用于按 turn 收敛放大。 */
  const quotaFallbacks = new WeakMap()

  /** 取请求的取消信号;不是对象就拿不到关联键。 */
  function signalKeyOf(options) {
    const signal = options?.signal
    return signal !== null && typeof signal === 'object' ? signal : undefined
  }

  /**
   * 失败处理前确认「这把密钥确实是本次请求用的那把」。
   *
   * - 生效钥已被换走:并发请求可能已经处理过同一把,直接允许重发;
   * - 仍是生效钥:用原引用当前值的摘要对齐,防止用户中途在设置页改过密钥,
   *   把失败记到没参与本次请求的那把头上。
   *
   * @returns 'serving'(该处理这把) | 'handled'(已被别人处理) | 'stale'(无法归因)
   */
  async function fallbackTarget(provider, keyId) {
    const record = recordOf(provider)
    if (record === undefined) return 'stale'
    const key = liveKeyOf(provider, keyId)
    if (record.activeKeyId !== keyId) {
      const handled = key !== undefined && (key.health === 'invalid'
        || (key.health === 'limited' && Number(key.cooldownUntil) > Date.now()))
      return handled ? 'handled' : 'stale'
    }
    if (key === undefined) return 'stale'
    const current = hitValue(await safeResolve(record.keyRef))
    const poolValue = hitValue(await safeResolve(key.ref))
    if (current === undefined || poolValue === undefined) return 'stale'
    return digestOf(current) === digestOf(poolValue) ? 'serving' : 'stale'
  }

  /**
   * 把一次调用失败落成健康状态(写活对象,由调用方统一落盘)。
   *
   * - 密钥级(invalid):仅当值确实不可用,后续轮换与候选筛选立即跳过;
   * - 额度级(quota):账户欠费的密钥换到别的账户仍可能成功,永久拉黑会误伤
   *   整池,因此只标 limited 并给固定冷却,到期后探测会重新判定。
   */
  function settleFallbackVerdict(provider, keyId, action) {
    const key = liveKeyOf(provider, keyId)
    if (key === undefined) return false
    if (action === 'invalid') {
      key.health = 'invalid'
      key.cooldownUntil = 0
      key.cooldownLevel = 0
    } else {
      key.health = 'limited'
      key.cooldownUntil = Date.now() + QUOTA_COOLDOWN_MS
      key.cooldownLevel = 0
    }
    return true
  }

  /**
   * 处理一次「零内容阶段的失败」:标记这把密钥、切到下一把可选密钥。
   *
   * 只负责状态与凭据切换;真正的"重发请求"由调用方(agent loop 的
   * request-error 恢复点)用新凭据重新出站,因为 llm/stream 的 `next()`
   * 有单次调用守卫,不能自己重放。
   *
   * @returns 会话是否已经换到别的密钥(调用方才允许返回 retry)。
   */
  async function rotateForFailure(provider, keyId, action) {
    if (disposed) return false
    return withSwitchLock(provider, async () => {
      const target = await fallbackTarget(provider, keyId)
      if (target === 'stale') return false
      if (target === 'handled') return true
      if (!settleFallbackVerdict(provider, keyId, action)) return false
      await persist()
      // 等锁期间别的请求可能已经把生效钥换走了:这次只需重发,别再跳一把。
      if (recordOf(provider)?.activeKeyId !== keyId) return true
      // 请求路径上不探测未知候选:失败已经说明要换,探测只会加延迟。
      // 这里已经在锁内,必须调不加锁的版本,否则自己把自己锁死。
      return rotateToNextUnlocked(provider, { probeUnknown: false })
    })
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
      fallbackOnFailure: live(config, 'fallbackOnFailure', true),
      webdavEnabled: live(config, 'webdavEnabled', false),
      webdavUrl: live(config, 'webdavUrl', ''),
      webdavUsername: live(config, 'webdavUsername', ''),
      webdavPassword: live(config, 'webdavPassword', ''),
      webdavDir: live(config, 'webdavDir', ''),
      webdavEncryptKey: live(config, 'webdavEncryptKey', ''),
      webdavDevice: live(config, 'webdavDevice', ''),
      webdavIntervalMin: live(config, 'webdavIntervalMin', 60),
      webdavKeep: live(config, 'webdavKeep', 5),
    }
  }

  /** 写插件配置:经 configEditor 走 Loader 正常落盘;volatile 字段即时生效。 */
  async function writeConfig(patch) {
    // 校验规则放在 core 的纯函数里,与单测共用同一份:
    // 界面按一套规则、宿主按另一套,是最常见的手写校验错位来源。
    const configError = validateProbeConfig(patch) ?? validateBackupConfig(patch)
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
    // 备份会读取磁盘状态上传;恢复会覆盖本地池,两者都必须先以磁盘为准。
    'backupNow',
    'backupRestore',
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
      case 'backupNow':
        // 手动备份不重置定时节奏;互斥由 runBackup 内部管理。
        return runBackup()
      case 'backupList':
        return remoteBackupList()
      case 'backupRestore':
        if (typeof body.file !== 'string' || body.file.length === 0) throw new Error('缺少 file 字段')
        return restoreBackup(body.file)
      case 'backupStatus':
        return { ok: true, status: backupStatus, device: backupDeviceName(), enabled: live(config, 'webdavEnabled', false) === true }
      case 'getConfig':
        return readConfig()
      case 'setConfig':
        return writeConfig({
          ...(body.quotaProbe !== undefined ? { quotaProbe: body.quotaProbe } : {}),
          ...(body.quotaIntervalMs !== undefined ? { quotaIntervalMs: body.quotaIntervalMs } : {}),
          ...(body.quotaProbeGapMs !== undefined ? { quotaProbeGapMs: body.quotaProbeGapMs } : {}),
          ...(body.fallbackOnFailure !== undefined ? { fallbackOnFailure: body.fallbackOnFailure } : {}),
          ...(body.webdavEnabled !== undefined ? { webdavEnabled: body.webdavEnabled } : {}),
          ...(body.webdavUrl !== undefined ? { webdavUrl: body.webdavUrl } : {}),
          ...(body.webdavUsername !== undefined ? { webdavUsername: body.webdavUsername } : {}),
          ...(body.webdavPassword !== undefined ? { webdavPassword: body.webdavPassword } : {}),
          ...(body.webdavDir !== undefined ? { webdavDir: body.webdavDir } : {}),
          ...(body.webdavEncryptKey !== undefined ? { webdavEncryptKey: body.webdavEncryptKey } : {}),
          ...(body.webdavDevice !== undefined ? { webdavDevice: body.webdavDevice } : {}),
          ...(body.webdavIntervalMin !== undefined ? { webdavIntervalMin: body.webdavIntervalMin } : {}),
          ...(body.webdavKeep !== undefined ? { webdavKeep: body.webdavKeep } : {}),
        })
      default:
        throw new Error(`未知动作: ${action}`)
    }
  }

  // 首次扫描不在 ready 里做:settings 注入可能晚于启动,
  // 扫描统一由 settings 就绪后的补扫与 API 调用前的 ensureScanned 触发。

  // 请求归因 + 失败观察:llm/stream 瀑布里按供应商计数、触发按次数轮换,
  // 并把「这次请求用了哪把密钥、失败是否发生在零内容阶段」记在 signal 上,
  // 供 agent/request-error 决定要不要换钥重发。
  //
  // 注意两点:
  // 1) 该瀑布不 await 监听器返回值——监听器必须同步返回 AsyncIterable;
  // 2) cordis 的 waterfall 给每个监听器的 next() 有单次调用守卫
  //    ("next() called multiple times"),所以这里绝不能自己重放请求。
  ctx.effect(() => ctx.on('llm/stream', (options, next) => {
    const providerId = typeof options?.provider === 'string' ? options.provider : undefined
    let rotationProvider = undefined
    try {
      const record = providerId === undefined ? undefined : recordOf(providerId)
      if (record !== undefined) {
        // 只统计被本插件管理的池;计数先加,再判断是否触发按次数轮换。
        // 兜底触发的重发不重复计数(见 recoveryRetries)。
        const signal = signalKeyOf(options)
        if (signal !== undefined && recoveryRetries.has(signal)) {
          recoveryRetries.delete(signal)
        } else {
          record.requestCount = (record.requestCount ?? 0) + 1
          const rotation = normalizeRotation(record.rotation)
          if (shouldRotateCalls(rotation, record.requestCount)) {
            rotationProvider = providerId
          }
        }
      }
    } catch (error) {
      // 归因失败不阻断请求本身。
      ctx.logger.warn(`请求计数失败: ${error?.message ?? error}`)
    }
    // 未纳管:完全透传,零额外开销(也不套生成器)。
    if (providerId === undefined || recordOf(providerId) === undefined) return next()
    return (async function* () {
      if (rotationProvider !== undefined) {
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
          ctx.logger.warn(`按次数自动轮换失败: ${error?.message ?? error}`)
        }
      }
      // 归因快照只记「请求开始时生效的是哪把」:不在热路径上解析凭据,
      // 真正的归属由恢复点在失败时用摘要复核(见 fallbackTarget)。
      const signal = signalKeyOf(options)
      const keyId = recordOf(providerId)?.activeKeyId
      const pending = signal !== undefined && keyId !== null && typeof keyId === 'string'
        ? { provider: providerId, keyId, zeroContent: true, failure: undefined }
        : undefined
      if (pending !== undefined) pendingFailures.set(signal, pending)
      for await (const chunk of next()) {
        if (pending !== undefined) {
          // 只有真正的输出块才算「已产出内容」:pi-ai 的失败流固定先发一个
          // usage 元数据块再发错误终止块,把 usage 当内容会让兜底永不触发。
          if (isFallbackFailureChunk(chunk)) pending.failure = chunk.reason?.failure
          else if (isStreamContentChunk(chunk)) pending.zeroContent = false
        }
        yield chunk
      }
    })()
  }), 'dsh-key-managment: llm/stream 请求计数与失败观察')

  // 请求恢复点:agent loop 在模型调用失败后询问是否重试。这里换钥并回答
  // 「重试」,循环会用新凭据重新 prepareRequest 并重新派发(凭据在出站时解析)。
  // 只处理零内容阶段、可归因到具体密钥的认证/额度失败;其余交给下一个监听器。
  ctx.effect(() => ctx.on('agent/request-error', (payload, next) => {
    const signal = payload?.signal
    if (signal === null || typeof signal !== 'object') return next()
    const pending = pendingFailures.get(signal)
    if (pending === undefined) return next()
    // 一次失败只处理一次:先摘掉快照,再判断要不要兜底。
    pendingFailures.delete(signal)
    if (pending.provider !== payload?.provider) return next()
    if (live(config, 'fallbackOnFailure', true) !== true) return next()
    // 失败事实以宿主下发的为准(块里的只是快照的备份)。
    const failure = payload?.failure ?? pending.failure
    if (failure === undefined || pending.zeroContent !== true) return next()
    if (signal.aborted === true) return next()
    const verdict = classifyStreamFailure(failure)
    if (verdict.action === 'none') return next()
    if (verdict.action === 'quota') {
      // 账户级额度问题不逐把试:同 turn 超过上限就放行原失败。
      const used = quotaFallbacks.get(signal) ?? 0
      if (used >= QUOTA_FALLBACK_MAX_PER_TURN) return next()
      quotaFallbacks.set(signal, used + 1)
    }
    // next() 只能调用一次:先决定动作,不能兜底时再退给下一个监听器。
    return rotateForFailure(pending.provider, pending.keyId, verdict.action).then(
      rotated => {
        if (!rotated) return next()
        // 只在实际重发时打标记,避免污染同一 signal 上后续的正常请求计数。
        recoveryRetries.add(signal)
        ctx.logger.warn(`${pending.provider} 调用失败(${verdict.reason}),已自动换到下一把密钥`)
        return { kind: 'retry' }
      },
      error => {
        ctx.logger.warn(`失效兜底失败(${pending.provider}): ${error?.message ?? error}`)
        return next()
      },
    )
  }), 'dsh-key-managment: 调用失败自动换钥')

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
              ctx.logger.warn(`定时轮换失败(${record.provider}): ${error?.message ?? error}`)
            })
          }
        }
      })()
    }, 60_000)
    return () => { clearInterval(timer) }
  }, 'dsh-key-managment: 定时轮换检查')

  /* ------------------------- WebDAV 备份与恢复 ------------------------- */

  /** 设备名:配置优先,留空取主机名;清洗后作为备份文件名前缀与轮转分组。 */
  function backupDeviceName() {
    return sanitizeDeviceName(live(config, 'webdavDevice', '') || hostname())
  }

  /** 读取备份配置并做完整性校验;缺项时抛出明确错误。 */
  function requireBackupConfig() {
    const url = String(live(config, 'webdavUrl', '')).trim().replace(/\/+$/, '')
    const username = String(live(config, 'webdavUsername', '')).trim()
    const password = String(live(config, 'webdavPassword', ''))
    const dir = String(live(config, 'webdavDir', '')).trim().replace(/^\/+|\/+$/g, '')
    const encryptKey = String(live(config, 'webdavEncryptKey', ''))
    if (!/^https?:\/\//i.test(url)) throw new Error('WebDAV 服务地址未配置或不合法')
    if (username.length === 0 || password.length === 0) throw new Error('WebDAV 账号或密码未配置')
    if (encryptKey.length === 0) throw new Error('备份加密密钥未配置')
    return { url, username, password, dir, encryptKey }
  }

  /** 组装 WebDAV 客户端与远程路径;每次操作重建以即时跟随配置变化。 */
  function webdavContext() {
    const conf = requireBackupConfig()
    const client = createWebdavClient(conf.url, { username: conf.username, password: conf.password })
    // 远程路径拼接:目录段已去首尾斜杠,文件名由 parseBackupFileName 保证不含路径分隔符。
    const remotePath = (name) => `${conf.dir.length > 0 ? `/${conf.dir}` : ''}/${name}`
    return { ...conf, client, remotePath }
  }

  /** 备份文件的远程目录;目录名为空时直接用服务根。 */
  function backupRemoteDir(context) {
    return context.dir.length > 0 ? `/${context.dir}` : '/'
  }

  /** 列出远程备份(新到旧);网络/认证错误原样抛出,由调用方呈现。 */
  async function remoteBackupList() {
    const context = webdavContext()
    const contents = await context.client.getDirectoryContents(backupRemoteDir(context))
    const entries = Array.isArray(contents) ? contents : []
    const { backups } = listBackups(entries.map(entry => entry.basename ?? entry.filename))
    return {
      ok: true,
      device: backupDeviceName(),
      backups: backups.map(entry => ({ name: entry.name, device: entry.device, time: entry.timestamp })),
    }
  }

  /** 列出目录并按本设备前缀轮转删除超限旧备份;删除失败只记录,不阻断。 */
  async function rotateRemoteBackups(context) {
    const keep = Math.max(1, Math.round(Number(live(config, 'webdavKeep', 5)) || 5))
    const failures = []
    try {
      const contents = await context.client.getDirectoryContents(backupRemoteDir(context))
      const entries = Array.isArray(contents) ? contents : []
      for (const victim of backupsToDelete(entries.map(entry => entry.basename ?? entry.filename), backupDeviceName(), keep)) {
        try {
          await context.client.deleteFile(context.remotePath(victim))
        } catch (error) {
          // 权限/只读挂载等场景:本次备份已完成,残留文件下次备份时重试清理。
          failures.push(`${victim}: ${error?.message ?? error}`)
        }
      }
    } catch (error) {
      failures.push(`备份列表获取失败(跳过轮转): ${error?.message ?? error}`)
    }
    return failures
  }

  /**
   * 执行一次备份:以磁盘为准同步 → 构建快照(含密钥明文) → 加密上传 → 轮转。
   * 结果写入 backupStatus 供界面展示;错误向上抛出,由调用方决定如何记录。
   *
   * 互斥:backupInFlight 在本函数内统一管理——定时器与手动 backupNow
   * 走不同入口,共用这个标志防止两个 runBackup 并发上传/轮转。
   */
  async function runBackup() {
    if (backupInFlight) throw new Error('已有备份在进行中,请稍后再试')
    backupInFlight = true
    try {
      const context = webdavContext()
      // 与变更动作同理:先以磁盘为准,避免陈旧实例把旧状态备份上去。
      await syncProvidersFromDisk()
      const snapshot = await buildSnapshot(state, async (ref) => hitValue(await safeResolve(ref)))
      // 数据完整性闸门:
      // - 快照总密钥数为 0 一律拒绝(本地也为空时,空备份没有任何恢复价值,
      //   反而会以"空快照 + 轮转"逐步挤掉云端的好备份——本功能最初的
      //   丢数据事故正是这个路径);
      // - 本地有钥的供应商在快照里变成空池(凭据读取失败的典型症状)同样拒绝。
      const snapshotKeyTotal = Object.values(snapshot.providers)
        .reduce((sum, record) => sum + record.keys.length, 0)
      if (snapshotKeyTotal === 0) {
        throw new Error('快照中没有任何可备份的密钥,已放弃本次备份以保护云端历史备份')
      }
      const starved = Object.values(state.providers)
        .filter(record => (record.keys?.length ?? 0) > 0)
        .filter(record => (snapshot.providers[record.provider]?.keys.length ?? 0) === 0)
        .map(record => record.provider)
      if (starved.length > 0) {
        throw new Error(`以下供应商的密钥值读取失败,已放弃本次备份以保护数据: ${starved.join(', ')}`)
      }
      const payload = await encryptSnapshot(snapshot, context.encryptKey)
      const name = backupFileName(backupDeviceName(), new Date())
      // 逐级创建目录(MKCOL 是单层的,多级目录必须逐段建;已存在等情况报错吞掉):
      // 例如配置 backup/dsh-keys 而 backup 不存在时,只建最后一级会 409,
      // 后续 PUT 必然失败,表现为定时备份永远失败。
      let parent = ''
      for (const segment of context.dir.split('/').filter(part => part.length > 0)) {
        parent += `/${segment}`
        try {
          await context.client.createDirectory(parent)
        } catch {
          // 目录已存在或服务端不支持 MKCOL:继续建下一级。
        }
      }
      await context.client.putFileContents(context.remotePath(name), payload, { overwrite: true })
      const deletedFailures = await rotateRemoteBackups(context)
      backupStatus = { lastRunAt: Date.now(), ok: true, error: null, file: name, deletedFailures }
      if (deletedFailures.length > 0) {
        ctx.logger.warn(`备份轮转存在未删除的旧备份: ${deletedFailures.join('; ')}`)
      }
      // view 是 async 函数:必须 await 后再展开,否则展开的是 Promise 实例,
      // 得到空对象,响应缺失 providers/available 等全量状态字段。
      return { ok: true, file: name, deletedFailures, ...(await view()) }
    } finally {
      backupInFlight = false
    }
  }

  /**
   * 从指定备份恢复:下载 → 解密(失败即中止,不触碰本地) → 生成恢复计划
   * → 写凭据、重建 providers → 落盘。任何一步失败都不改变本地状态。
   */
  async function restoreBackup(name) {
    const parsed = parseBackupFileName(name)
    if (parsed === null) throw new Error('备份文件名不合法')
    const context = webdavContext()
    const raw = await context.client.getFileContents(context.remotePath(parsed.name), { format: 'binary' })
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    const snapshot = normalizeRestoredSnapshot(await decryptSnapshot(buffer, context.encryptKey))
    if (snapshot === null) throw new Error('备份内容结构无效,已中止恢复')
    // 恢复侧闸门:快照里没有任何密钥时拒绝恢复——覆盖一个空快照只会
    // 把本地数据清空,没有任何恢复价值。
    const snapshotKeyTotal = Object.values(snapshot.providers)
      .reduce((sum, record) => sum + record.keys.length, 0)
    if (snapshotKeyTotal === 0) {
      throw new Error('备份里没有可恢复的密钥,已中止恢复')
    }
    // 恢复前先以磁盘为准:计划基于最新状态生成,孤儿引用才清得干净。
    await syncProvidersFromDisk()
    const plan = planRestore(snapshot, state.providers, provider => newPoolRef(provider))
    // 先写后清:写失败时本地池还是旧值,不会出现"引用清了值没写上"的半态。
    // 补偿:写入中途失败时,已写入的新引用会成为状态文件里没有的孤儿明文,
    // 必须尽力清理;persist 失败同理(状态未落盘,新引用同样是孤儿)。
    const appliedRefs = []
    const previousProviders = state.providers
    try {
      for (const entry of plan.refsToSet) {
        await ctx.credentials.set(entry.ref, entry.value)
        appliedRefs.push(entry.ref)
      }
      // 按调用次数轮换的进度取较大值:恢复不应把本进程已累计的调用计数
      // 倒退回备份时刻,否则"按次数轮换"会重新数一遍(与 syncProvidersFromDisk
      // 保留内存较大值的口径一致)。
      for (const [provider, record] of Object.entries(plan.providers)) {
        const live = previousProviders[provider]
        if (live !== undefined && typeof live.requestCount === 'number'
          && live.requestCount > record.requestCount) {
          record.requestCount = live.requestCount
        }
      }
      state.providers = plan.providers
      await persist()
    } catch (error) {
      // persist 失败时内存态必须一并回滚:只回滚凭据会留下"内存=恢复后、
      // 磁盘=恢复前"的混合态,后续 syncProvidersFromDisk 的并集合并会把
      // 两边记录混在一起,旧记录引用的池凭据还已被清掉,指向空值。
      state.providers = previousProviders
      for (const ref of appliedRefs) {
        try { await ctx.credentials.unset(ref) } catch { /* 尽力清理 */ }
      }
      throw error
    }
    // 落盘成功后才清旧池引用:清到一半出错也不影响已持久化的新状态,
    // 残留的旧引用(明文孤儿)与原注释口径一致,无害。
    for (const ref of plan.refsToUnset) {
      try {
        await ctx.credentials.unset(ref)
      } catch {
        // 与 deleteKey 同理:状态文件已不含该引用,残留凭据无害。
      }
    }
    // 清理被移除供应商的余额快照:quotaStore 不清理的话,view 会把已不存在
    // 供应商的 quota 原样下发给界面。
    const livePrefixes = new Set(Object.keys(state.providers))
    for (const cacheKey of [...quotaStore.keys()]) {
      if (!livePrefixes.has(cacheKey.split('\u0000')[0])) quotaStore.delete(cacheKey)
    }
    for (const warning of plan.warnings) ctx.logger.warn(`恢复备份: ${warning}`)
    // 恢复只替换了 state.providers,内存目录里的 managed 还是恢复前的旧值:
    // 徽标读新状态显示"已纳入管理",可纳管列表却按旧标记把同一批供应商
    // 再列一遍,两处自相矛盾。这里按新状态重算,再下发视图。
    for (const entry of directory.values()) {
      entry.managed = recordOf(entry.provider) !== undefined
    }
    ctx.logger.info(`已从备份 ${parsed.name} 恢复 ${Object.keys(plan.providers).length} 个供应商的密钥池`)
    // view 是 async 函数:必须 await 后展开,否则得到空对象(同 runBackup)。
    return { ok: true, restored: Object.keys(plan.providers).length, warnings: plan.warnings, ...(await view()) }
  }

  // 定时备份:每分钟检查一次,距上次触发满配置间隔即备份一次。
  // 间隔下限 5 分钟(schema 强制);互斥由 runBackup 内的 backupInFlight 统一管理。
  // 必须经 mutationTail 派发:绕过队列会与 restoreBackup 等变更动作真并发,
  // 在恢复中途做 sync/上传,可能产出半恢复态的快照。
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (disposed) return
      if (live(config, 'webdavEnabled', false) !== true) return
      const intervalMin = Math.max(5, Number(live(config, 'webdavIntervalMin', 60)) || 60)
      const now = Date.now()
      if (now - lastBackupAt < intervalMin * 60_000) return
      lastBackupAt = now
      // 先等启动闸门:重载后立刻抢跑会在凭据服务就绪前构建出空快照
      // (runBackup 的完整性闸门会兜底拒绝,但不能只依赖它)。
      void startupReady.then(() => {
        if (disposed) return
        // 失败只回退约 1 分钟:下次 tick 即重试;持续失败(如配置错误)时
        // 每次尝试都会重新排到一分钟后,不会形成无间隔风暴。
        const scheduledAt = lastBackupAt
        return mutationTail
          .catch(() => {})
          .then(() => runBackup())
          .catch((error) => {
            lastBackupAt = Math.min(scheduledAt + intervalMin * 60_000, Date.now() - intervalMin * 60_000 + 60_000)
            backupStatus = {
              lastRunAt: Date.now(), ok: false,
              error: error?.message ?? String(error), file: null, deletedFailures: [],
            }
            ctx.logger.warn(`定时备份失败: ${error?.message ?? error}`)
          })
      })
    }, 60_000)
    return () => { clearInterval(timer) }
  }, 'dsh-key-managment: WebDAV 定时备份')

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
