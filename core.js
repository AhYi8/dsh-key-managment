/**
 * 密钥管理插件的核心纯逻辑。
 *
 * 该模块不依赖宿主运行时(Node API 仅用 node:crypto 的 createHash),
 * 便于用 node:test 直接单测;宿主 index.js 只做服务编排。
 */
import { createHash, randomBytes } from 'node:crypto'

/** 状态文档版本;字段或语义变化时递增。 */
export const STATE_VERSION = 1

/** 密钥值的长度上限:防御性拒绝异常长的粘贴内容。 */
export const MAX_KEY_LENGTH = 4096

/** 别名长度上限,与参考实现的体验一致。 */
export const MAX_ALIAS_LENGTH = 80

/** 单个供应商密钥池容量上限,防止误粘贴造成无界增长。 */
export const MAX_KEYS_PER_PROVIDER = 50

/** 生成一个非敏感的密钥记录 id。 */
export function newKeyId() {
  return `k_${randomBytes(6).toString('hex')}`
}

/**
 * 为池内新密钥生成插件作用域的凭据引用名。
 * 值本身存 DSH 凭据存储,状态文件只留引用名。
 */
export function newPoolRef(provider) {
  const stem = String(provider).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 34) || 'PROVIDER'
  const hash = createHash('sha256').update(String(provider)).digest('hex').slice(0, 6).toUpperCase()
  return `KEYMGR_${stem}_${hash}_K_${randomBytes(6).toString('hex').toUpperCase()}`
}

/** 密钥值的 SHA-256 摘要,用于在不见明文的前提下比对"当前生效的是哪一把"。 */
export function digestOf(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

/** 密钥尾号:仅暴露最后 4 位用于界面识别。 */
export function tailOf(value) {
  const text = String(value)
  return text.length <= 4 ? text : text.slice(-4)
}

/** 校验密钥值;返回错误消息,合法时返回 null。 */
export function validateKeyValue(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return '密钥值不能为空'
  if (value.length > MAX_KEY_LENGTH) return `密钥值过长(上限 ${MAX_KEY_LENGTH} 字符)`
  return null
}

/** 校验别名;空串表示使用默认命名,返回错误消息或 null。 */
export function validateAlias(alias) {
  if (alias === undefined || alias === null) return null
  if (typeof alias !== 'string') return '名称必须是字符串'
  const trimmed = alias.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > MAX_ALIAS_LENGTH) return `名称过长(上限 ${MAX_ALIAS_LENGTH} 字符)`
  return null
}

/**
 * 生成下一个默认别名 Key_n:n 取池内历史最大编号 + 1,
 * 避免删除中间密钥后编号复用导致混淆。
 */
export function nextAlias(keys) {
  let max = 0
  for (const key of keys) {
    const match = /^Key_(\d+)$/.exec(key.alias ?? '')
    if (match) max = Math.max(max, Number.parseInt(match[1], 10))
  }
  return `Key_${max + 1}`
}

/** 创建空的供应商纳管记录。 */
export function newProviderRecord(provider, displayName, settingsNs, keyRef) {
  return {
    provider: String(provider),
    displayName: String(displayName ?? provider),
    settingsNs: String(settingsNs ?? ''),
    /** 供应商原始凭据引用名(即设置页密钥字段的引用),切换时写回这里。 */
    keyRef: String(keyRef),
    /** 池内密钥列表。 */
    keys: [],
    /** 当前生效的密钥 id;null 表示生效密钥未知或不在池内。 */
    activeKeyId: null,
    /** 自动轮换配置(以供应商池为分组单位)。 */
    rotation: normalizeRotation(undefined),
    /** 轮转游标:下一把候选在 keys 里的位置。 */
    cursor: 0,
    /** 当前生效密钥自上次轮换以来服务的请求数。 */
    requestCount: 0,
    /** 上次轮换的时间戳;0 表示从未轮换。 */
    lastRotatedAt: 0,
  }
}

/**
 * 状态文档的规范化入口:修复缺失字段、剔除非法条目,
 * 保证旧文件或手改文件不会让插件崩溃。
 */
export function normalizeState(raw) {
  const state = {
    version: STATE_VERSION,
    providers: {},
  }
  if (raw === null || typeof raw !== 'object') return state
  const providers = raw.providers
  if (providers !== null && typeof providers === 'object') {
    for (const [provider, record] of Object.entries(providers)) {
      if (record === null || typeof record !== 'object') continue
      if (typeof record.keyRef !== 'string' || record.keyRef.length === 0) continue
      const keys = Array.isArray(record.keys) ? record.keys : []
      state.providers[provider] = {
        provider: String(provider),
        displayName: typeof record.displayName === 'string' ? record.displayName : String(provider),
        settingsNs: typeof record.settingsNs === 'string' ? record.settingsNs : '',
        keyRef: record.keyRef,
        activeKeyId: typeof record.activeKeyId === 'string' ? record.activeKeyId : null,
        rotation: normalizeRotation(record.rotation),
        cursor: typeof record.cursor === 'number' ? record.cursor : 0,
        requestCount: typeof record.requestCount === 'number' && record.requestCount > 0 ? record.requestCount : 0,
        lastRotatedAt: typeof record.lastRotatedAt === 'number' ? record.lastRotatedAt : 0,
        keys: keys
          .filter(key => key !== null && typeof key === 'object' && typeof key.id === 'string' && typeof key.ref === 'string')
          .map(key => ({
            id: key.id,
            alias: typeof key.alias === 'string' && key.alias.length > 0 ? key.alias : 'Key_1',
            ref: key.ref,
            createdAt: typeof key.createdAt === 'number' ? key.createdAt : 0,
            lastUsedAt: typeof key.lastUsedAt === 'number' ? key.lastUsedAt : 0,
            health: key.health === 'ok' || key.health === 'limited' || key.health === 'invalid' ? key.health : 'unknown',
            cooldownUntil: typeof key.cooldownUntil === 'number' && key.cooldownUntil > 0 ? key.cooldownUntil : 0,
            cooldownLevel: typeof key.cooldownLevel === 'number' && key.cooldownLevel > 0 ? Math.round(key.cooldownLevel) : 0,
          })),
      }
    }
  }
  return state
}

/**
 * 投影单个供应商的对外视图。
 *
 * @param record 纳管记录
 * @param digests Map<poolRef, digest> 池内各凭据引用的值摘要(宿主预解析)
 * @param current 供应商原始引用当前值摘要与尾号;null 表示原引用无值
 */
export function projectProvider(record, digests, current) {
  const byDigest = new Map()
  for (const key of record.keys) {
    const digest = digests.get(key.ref)
    if (digest !== undefined) byDigest.set(digest, key.id)
  }
  const currentKeyId = current?.digest !== undefined ? byDigest.get(current.digest) ?? null : null
  const unknown = current !== null && current !== undefined && current.digest !== undefined && currentKeyId === null
  const now = Date.now()
  return {
    provider: record.provider,
    displayName: record.displayName,
    keyCount: record.keys.length,
    activeKeyId: currentKeyId ?? record.activeKeyId,
    /** 自动轮换配置与计数,供界面展示与设置。 */
    rotation: normalizeRotation(record.rotation),
    requestCount: record.requestCount ?? 0,
    lastRotatedAt: record.lastRotatedAt ?? 0,
    /** 当前原引用密钥与池内任何一把都不匹配时,给出尾号供"一键纳管"。 */
    unknown: unknown ? { tail: current.tail } : null,
    keys: record.keys.map(key => ({
      id: key.id,
      alias: key.alias,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      // 摘要缺失表示凭据存储里读不到值(被外部删除等),界面标注缺失。
      valueMissing: !digests.has(key.ref),
      health: key.health ?? 'unknown',
      // 冷却已到期的限流密钥按"有效"展示(下一轮探测会重新判定)。
      limited: key.health === 'limited' && Number(key.cooldownUntil) > now,
      cooldownUntil: key.cooldownUntil ?? 0,
    })),
  }
}

/**
 * 找到与当前原引用值匹配的池内密钥;用于切换前的归属判断。
 * 返回密钥记录或 undefined。
 */
export function findKeyByDigest(record, digests, currentDigest) {
  if (currentDigest === undefined) return undefined
  for (const key of record.keys) {
    if (digests.get(key.ref) === currentDigest) return key
  }
  return undefined
}

/* ------------------------- 密钥健康状态与自动轮换 ------------------------- */

/** 限流冷却的起步时长与上限(指数退避:60s 起步,翻倍,封顶 30 分钟)。 */
export const LIMIT_COOLDOWN_BASE_MS = 60_000
export const LIMIT_COOLDOWN_MAX_MS = 30 * 60_000

/**
 * 从一次余额探测结果推导密钥健康状态。
 *
 * - ok 且所有窗口用量 <100%      → ok(有效)
 * - ok 但存在 100% 用尽的窗口    → limited(限流),冷却到窗口重置时间
 * - 探测错误 kind=rate / 429     → limited,指数退避冷却
 * - 探测错误 kind=auth / 无凭据  → invalid(无效)
 * - 其它错误(parse/network)     → 保持原状态
 *
 * @param payload 探测负载(quotaStore 里的快照)
 * @param prev 上一次的健康状态;首次为 'unknown'
 * @param prevLevel 上一次限流的退避级别
 * @param now 当前时间戳
 */
export function healthFromQuota(payload, prev, prevLevel, now) {
  if (payload === undefined || payload === null) {
    return { health: prev ?? 'unknown', cooldownUntil: 0, level: prevLevel ?? 0 }
  }
  if (payload.status === 'ok') {
    const windows = Array.isArray(payload.windows) ? payload.windows : []
    const exhausted = windows.filter(w => typeof w.usedPercent === 'number' && w.usedPercent >= 100)
    if (exhausted.length > 0) {
      // 冷却到最早重置的耗尽窗口;缺重置时间则退避 10 分钟。
      const resets = exhausted.map(w => w.resetAt).filter(v => typeof v === 'number' && v > now)
      const cooldownUntil = resets.length > 0 ? Math.min(...resets) : now + 10 * 60_000
      return { health: 'limited', cooldownUntil, level: 0 }
    }
    return { health: 'ok', cooldownUntil: 0, level: 0 }
  }
  if (payload.status === 'error') {
    const kind = payload.error?.kind ?? ''
    const message = String(payload.error?.message ?? '')
    if (kind === 'no-credential' || kind === 'auth' || /401|403|invalid[_ ]api[_ ]key/i.test(message)) {
      return { health: 'invalid', cooldownUntil: 0, level: 0 }
    }
    if (kind === 'rate' || /429|rate[ _-]?limit/i.test(message)) {
      // 指数退避:连续限流翻倍,封顶 30 分钟。
      const level = Math.min((prevLevel ?? 0) + 1, 30)
      const cooldownMs = Math.min(LIMIT_COOLDOWN_MAX_MS, LIMIT_COOLDOWN_BASE_MS * 2 ** level)
      return { health: 'limited', cooldownUntil: now + cooldownMs, level }
    }
    // parse/network 等:探测自身问题,不改判密钥。
    return { health: prev ?? 'unknown', cooldownUntil: 0, level: prevLevel ?? 0 }
  }
  // unsupported 等:维持原状。
  return { health: prev ?? 'unknown', cooldownUntil: 0, level: prevLevel ?? 0 }
}

/**
 * 轮换候选判定:无效密钥跳过;限流密钥在冷却期内跳过(到期自动恢复参选)。
 */
export function isSelectable(key, now) {
  if (key.valueMissing === true) return false
  if (key.health === 'invalid') return false
  if (key.health === 'limited' && Number(key.cooldownUntil) > now) return false
  return true
}

/**
 * 轮换选择:从游标处轮转,返回下一把可选密钥(不含 excludeKeyId)。
 * 无可选时返回 undefined(全部无效/限流中)。
 */
export function pickNextKeyId(record, now, excludeKeyId) {
  const keys = Array.isArray(record.keys) ? record.keys : []
  if (keys.length === 0) return undefined
  const start = ((Number(record.cursor) || 0) % keys.length + keys.length) % keys.length
  for (let offset = 0; offset < keys.length; offset += 1) {
    const index = (start + offset) % keys.length
    const key = keys[index]
    if (key.id === excludeKeyId) continue
    if (isSelectable(key, now)) return key.id
  }
  return undefined
}

/** 规范化供应商的轮换配置;非法值回落到默认(关闭)。最小值均为 1,不设上限。 */
export function normalizeRotation(raw) {
  const rotation = raw !== null && typeof raw === 'object' ? raw : {}
  const mode = rotation.mode === 'interval' || rotation.mode === 'calls' ? rotation.mode : 'off'
  const intervalMs = typeof rotation.intervalMs === 'number' && rotation.intervalMs >= 60_000
    ? Math.round(rotation.intervalMs)
    : 30 * 60_000
  const requests = typeof rotation.requests === 'number' && rotation.requests >= 1
    ? Math.round(rotation.requests)
    : 50
  return { mode, intervalMs, requests }
}

/** 按调用次数轮换是否到点。 */
export function shouldRotateCalls(rotation, requestCount) {
  return rotation.mode === 'calls' && requestCount >= rotation.requests
}

/** 定时轮换是否到点;从未轮换过(lastRotatedAt=0)时以纳管时间为基准。 */
export function shouldRotateInterval(rotation, lastRotatedAt, now) {
  if (rotation.mode !== 'interval') return false
  const base = lastRotatedAt > 0 ? lastRotatedAt : now
  return now - base >= rotation.intervalMs
}

/* --------------------------- 后台探测调度 --------------------------- */

/**
 * 后台探测的轮次节奏:第 0 轮(启动首探)立即执行,之后每轮等待 intervalMs。
 *
 * 把"启动立即"表达成 0 延迟而不是拆成两段循环:轮次序号本身就是调度
 * 策略,单测可以直接断言首轮不等待。
 *
 * @param round 已完成的轮次序号(启动首探之前为 0)
 * @param intervalMs 配置的轮间隔(毫秒)
 * @returns 距下一轮开始的等待毫秒数(0 表示立即执行)
 */
export function probeRoundDelay(round, intervalMs) {
  if (!Number.isFinite(round) || round <= 0) return 0
  const value = Number.isFinite(intervalMs) ? Math.round(intervalMs) : 0
  // 下限 1 分钟:配置写坏时也不能把厂商端点打成轮询风暴。
  return Math.max(60_000, value)
}

/**
 * 解析批量粘贴的密钥文本:每行一个密钥。
 *
 * 行格式:
 * - `sk-xxxx`            —— 只有密钥,名称自动按 Key_n 生成;
 * - `我的主力|sk-xxxx`   —— 用 `|` 前缀指定名称(取第一个 `|` 之前部分);
 * - 空行与 `#` 开头的行跳过。
 *
 * @param text 粘贴的原始文本
 * @returns { entries: {line, alias?, value}[], failures: {line, reason}[] }
 */
export function parseBatchEntries(text) {
  const entries = []
  const failures = []
  if (typeof text !== 'string') return { entries, failures }
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]
    const line = index + 1
    const trimmed = raw.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    let alias
    let value = trimmed
    const separator = trimmed.indexOf('|')
    // 只有当左侧非空且不过长时才当作名称,避免把含 `|` 的真实密钥拆错。
    if (separator > 0 && separator <= MAX_ALIAS_LENGTH) {
      const head = trimmed.slice(0, separator).trim()
      const tail = trimmed.slice(separator + 1).trim()
      if (head.length > 0) {
        if (tail.length === 0) {
          // 写了名称却没给密钥:这是笔误,明确报错而不是把它当密钥存进去。
          failures.push({ line, reason: '名称后缺少密钥' })
          continue
        }
        alias = head
        value = tail
      }
    }
    const error = validateKeyValue(value)
    if (error !== null) {
      failures.push({ line, reason: error })
      continue
    }
    const aliasError = validateAlias(alias)
    if (aliasError !== null) {
      failures.push({ line, reason: aliasError })
      continue
    }
    entries.push({ line, ...(alias !== undefined ? { alias } : {}), value })
  }
  return { entries, failures }
}

/** 校验动作请求的公共入口:返回规范化字段或错误消息。 */
export function parseAction(body) {
  if (body === null || typeof body !== 'object') return { error: '请求体必须是 JSON 对象' }
  const action = body.action
  if (typeof action !== 'string') return { error: '缺少 action 字段' }
  const provider = typeof body.provider === 'string' && body.provider.length > 0 ? body.provider : undefined
  const keyId = typeof body.keyId === 'string' && body.keyId.length > 0 ? body.keyId : undefined
  const alias = typeof body.alias === 'string' ? body.alias : undefined
  const value = typeof body.value === 'string' ? body.value : undefined
  const force = body.force === true
  return { action, provider, keyId, alias, value, force }
}
