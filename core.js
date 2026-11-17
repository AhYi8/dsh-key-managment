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

/**
 * 从凭据 resolve 的返回值里提取明文。
 *
 * 宿主实现返回 `{ value, source }`;这里同时兼容裸字符串与 `{ secret }` 形态,
 * 让"读凭据"只有一处实现——探测桥与 Host 半区对同一形状的理解必须一致,
 * 否则会出现"设置页能看到密钥、探测却报密钥不可读"的分裂。
 */
export function hitValue(hit) {
  if (hit === undefined || hit === null) return undefined
  if (typeof hit === 'string') return hit
  if (typeof hit.value === 'string' && hit.value.length > 0) return hit.value
  if (typeof hit.secret === 'string' && hit.secret.length > 0) return hit.secret
  return undefined
}

/**
 * 从一段文本里抹掉密钥明文。
 *
 * 余额适配器抛出的错误原文可能带上密钥;错误消息会进 HTTP 响应与落盘快照,
 * 因此落盘/下发前必须先脱敏(明文只允许存在于凭据存储)。
 */
export function redactSecret(message, secret) {
  const text = typeof message === 'string' ? message : String(message ?? '')
  if (typeof secret !== 'string' || secret.length === 0) return text
  return text.split(secret).join('***')
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
 * 把内存里的运行时状态合并进"刚读自磁盘"的状态(原位修改)。
 *
 * requestCount 是本进程累计的调用数,磁盘上只是上次落盘时的快照:
 * 定时同步(每 60 秒)与变更动作前的同步都会用磁盘状态覆盖内存状态,
 * 若整体采用磁盘值,计数会被反复清零,"按调用次数轮换"永远攒不满阈值。
 *
 * 健康判定同理:磁盘上是上次落盘的快照,内存里是最近一次探测的结论。
 * 同步若整体采用磁盘值,后台轮刚探测出的结论会被旧快照覆盖——
 * 表现为"额度已用尽,密钥状态却一直不变"。
 * 内存里的健康状态只有在给出明确结论(ok/limited/invalid)时才覆盖磁盘:
 * 仍是 unknown(尚未探测)时不覆盖磁盘上已有的结论。
 *
 * 轮换**配置**仍然以磁盘为准(陈旧实例自愈),这里只保留运行时状态。
 *
 * 磁盘上没有的供应商(内存里刚纳管、尚未落盘)必须保留:丢弃会让池子
 * 凭空消失,已写入凭据库的密钥变成无主明文,轮换也无从进行。
 *
 * @param memoryProviders 同步前的内存状态
 * @param freshProviders 刚从磁盘读出并规范化的状态(会被原位修改)
 * @returns freshProviders(便于链式调用)
 */
export function mergeRuntimeState(memoryProviders, freshProviders) {
  if (memoryProviders === null || typeof memoryProviders !== 'object') return freshProviders
  if (freshProviders === null || typeof freshProviders !== 'object') return freshProviders
  for (const [provider, record] of Object.entries(memoryProviders)) {
    const incoming = freshProviders[provider]
    if (incoming === undefined) {
      // 磁盘上没有这个供应商:内存里的那份更可能是刚纳管还没落盘的,
      // 保留它,免得池子凭空消失(凭据已写入凭据库,丢不得)。
      freshProviders[provider] = record
      continue
    }
    if (incoming === null || typeof incoming !== 'object') continue
    const memory = Number(record?.requestCount ?? 0)
    const disk = Number(incoming.requestCount ?? 0)
    if (Number.isFinite(memory) && memory > disk) incoming.requestCount = memory
    const memoryKeys = Array.isArray(record?.keys) ? record.keys : []
    const incomingKeys = Array.isArray(incoming.keys) ? incoming.keys : []
    for (const memoryKey of memoryKeys) {
      if (memoryKey === null || typeof memoryKey !== 'object') continue
      if (memoryKey.health !== 'ok' && memoryKey.health !== 'limited' && memoryKey.health !== 'invalid') continue
      const target = incomingKeys.find(entry => entry !== null && typeof entry === 'object' && entry.id === memoryKey.id)
      if (target === undefined) continue
      target.health = memoryKey.health
      target.cooldownUntil = memoryKey.cooldownUntil ?? 0
      target.cooldownLevel = memoryKey.cooldownLevel ?? 0
    }
  }
  return freshProviders
}

/**
 * 探测配置的取值约束;与 Host 半区 Config schema 保持一致。
 *
 * 规则放在纯函数里:界面与宿主按同一份约束校验,免得用户填了值却被拒。
 */
export const PROBE_CONFIG_RULES = {
  quotaProbe: { type: 'boolean' },
  quotaIntervalMs: { min: 60_000, max: 86_400_000, step: 60_000, stepHint: '(整分钟)' },
  quotaProbeGapMs: { min: 200, max: 60_000, step: 100 },
}

/** 校验一个数字型配置字段;返回错误消息(null 表示通过)。 */
function checkNumberRule(name, value, rule) {
  if (value === undefined) return null
  // 类型错误与越界共用一条消息:同一个字段的说法保持一致。
  if (typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max) {
    return `${name} 必须是 ${rule.min}-${rule.max} 之间的数字`
  }
  // 步长:schema 用 step 约束,不合规的值宿主会抛英文原文错误,这里先给出中文提示。
  if (value % rule.step !== 0) {
    return `${name} 必须是 ${rule.step} 的倍数${rule.stepHint ?? ''}`
  }
  return null
}

/**
 * 校验探测配置补丁;返回错误消息(null 表示通过)。
 *
 * @param patch 待校验的补丁,如 { quotaIntervalMs: 90000 }
 */
export function validateProbeConfig(patch) {
  if (patch === null || typeof patch !== 'object') return '配置补丁必须是对象'
  if (patch.quotaProbe !== undefined && typeof patch.quotaProbe !== 'boolean') {
    return 'quotaProbe 必须是布尔值'
  }
  if (patch.fallbackOnFailure !== undefined && typeof patch.fallbackOnFailure !== 'boolean') {
    return 'fallbackOnFailure 必须是布尔值'
  }
  const intervalError = checkNumberRule('quotaIntervalMs', patch.quotaIntervalMs, PROBE_CONFIG_RULES.quotaIntervalMs)
  if (intervalError !== null) return intervalError
  const gapError = checkNumberRule('quotaProbeGapMs', patch.quotaProbeGapMs, PROBE_CONFIG_RULES.quotaProbeGapMs)
  if (gapError !== null) return gapError
  return null
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

/**
 * 限流冷却的起步时长与上限(指数退避:60s 为基数,每次连续限流翻倍,封顶 30 分钟)。
 *
 * 注意实际首次退避是 120s:冷却时长按 `基数 × 2^级别` 计算,而级别从 1 起算。
 */
export const LIMIT_COOLDOWN_BASE_MS = 60_000
export const LIMIT_COOLDOWN_MAX_MS = 30 * 60_000

/**
 * 「账号无 coding 套餐」的固定冷却时长。
 *
 * 智谱等 coding plan 供应商对没订阅套餐的账号,额度端点直接报
 * 「当前用户不存在 coding plan」:这不是探测自身的问题,而是资格缺失——
 * 订阅前这把密钥必然不可用。按限流处理但给一整天冷却(套餐不会几分钟内
 * 变出来),到期后下一轮探测重新判定,用户订阅完即自动恢复。
 */
export const NO_PLAN_COOLDOWN_MS = 24 * 60 * 60_000

/**
 * 「账号无 coding 套餐」的措辞:中文为智谱实机文案,英文覆盖其它供应商。
 * MiniMax 的两条是实机采集:无订阅是「no active token plan subscription」,
 * 而无资格账号走会话鉴权,报「cookie is missing, log in again」——按厂商
 * 语义这是资格缺失而非密钥失效,判 invalid 会误伤整池。
 */
const NO_PLAN_TEXT = /不存在\s*coding\s*plan|no\s+coding[\s_-]?plan|coding[\s_-]?plan.{0,12}(?:not\s+(?:exist|found|available)|missing)|未开通.{0,6}(?:coding\s*)?套餐|no\s+active[^\n]{0,24}\bplan\b(?:\s+subscription)?|cookie\s+is\s+missing/i

/**
 * 从一次余额探测结果推导密钥健康状态。
 *
 * - ok 且所有窗口用量 <100%      → ok(有效)
 * - ok 但存在 100% 用尽的窗口    → limited(限流),冷却到窗口重置时间
 * - ok 但余额窗口不可用(余额 ≤0 或 is_available=false)
 *                                → limited,固定 10 分钟冷却
 * - 探测错误 kind=rate / 429     → limited,指数退避冷却
 * - 探测错误 kind=auth / 无凭据  → invalid(无效)
 * - 其它错误(parse/network)     → 保持原状态(健康状态与冷却时间都不动)
 *
 * @param payload 探测负载(quotaStore 里的快照)
 * @param prev 上一次的健康状态;首次为 'unknown'
 * @param prevLevel 上一次限流的退避级别
 * @param now 当前时间戳
 * @param prevCooldown 上一次的冷却截止时间;"保持原状态"时原样保留。
 *   少了它,一次探测失败(网络抖动)会把仍在冷却中的密钥立刻放回可选池,
 *   指数退避形同虚设。
 */
export function healthFromQuota(payload, prev, prevLevel, now, prevCooldown = 0) {
  if (payload === undefined || payload === null) {
    return { health: prev ?? 'unknown', cooldownUntil: prevCooldown, level: prevLevel ?? 0 }
  }
  if (payload.status === 'ok') {
    const windows = Array.isArray(payload.windows) ? payload.windows : []
    // 余额型窗口(DeepSeek 官方 /user/balance):官方没有百分比和重置时间,
    // is_available=false 或余额 ≤0(含透支)都视为不可用。不判限流的话,
    // 轮换会把余额为 0 的密钥当有效密钥选中,切过去只会拿到 402。
    const overdrawn = windows.find(w => w?.tier === 'balance' && (
      w.available === false || (typeof w.remainingValue === 'number' && w.remainingValue <= 0)))
    if (overdrawn !== undefined) {
      // 余额没有重置时间,给固定 10 分钟冷却;到下一轮探测会重新判定。
      return { health: 'limited', cooldownUntil: now + QUOTA_COOLDOWN_MS, level: 0 }
    }
    const exhausted = windows.filter(w => typeof w.usedPercent === 'number' && w.usedPercent >= 100)
    if (exhausted.length > 0) {
      // 冷却到最早重置的耗尽窗口;缺重置时间则退避 10 分钟。
      const resets = exhausted.map(w => w.resetAt).filter(v => typeof v === 'number' && v > now)
      const cooldownUntil = resets.length > 0 ? Math.min(...resets) : now + QUOTA_COOLDOWN_MS
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
    // 账号没订阅 coding 套餐:限流一天(level 归零,不参与指数退避)。
    if (NO_PLAN_TEXT.test(message)) {
      return { health: 'limited', cooldownUntil: now + NO_PLAN_COOLDOWN_MS, level: 0 }
    }
    // parse/network 等:探测自身问题,不改判密钥——冷却时间也原样保留。
    return { health: prev ?? 'unknown', cooldownUntil: prevCooldown, level: prevLevel ?? 0 }
  }
  // unsupported 等:维持原状。
  return { health: prev ?? 'unknown', cooldownUntil: prevCooldown, level: prevLevel ?? 0 }
}

/**
 * 用一次探测结论落定某把密钥的健康状态,写回"当前内存态"里的那把密钥。
 *
 * 后台探测一轮要串行扫全部供应商,单是 minimax-cn 的 50 把密钥 × 5 秒
 * 组内间隔就要 4 分多钟。这期间"以磁盘为准"的定时同步会整体替换
 * state.providers,先前持有的 key 引用便成了孤儿——写进孤儿的结论
 * 不会进入下一次落盘,表现为"额度已用尽,状态却一直不变"。
 * 因此这里按 id 重新定位当前内存态里的那把密钥:判定用的前值也取自
 * 活对象(限流退避级别才能连续累加),结论也必然落在活对象上。
 *
 * @param providers 当前内存态的供应商集合(state.providers)
 * @param provider 供应商键
 * @param keyId 池内密钥 id
 * @param payload 探测负载(quotaStore 里的快照)
 * @param now 当前时间戳
 * @returns { changed: boolean, health: string } changed 表示状态确实变了(需要落盘)
 */
export function settleKeyHealth(providers, provider, keyId, payload, now) {
  const record = providers?.[provider]
  if (record === undefined || !Array.isArray(record.keys)) return { changed: false, health: 'unknown' }
  const key = record.keys.find(entry => entry?.id === keyId)
  if (key === undefined) return { changed: false, health: 'unknown' }
  const verdict = healthFromQuota(payload, key.health ?? 'unknown', key.cooldownLevel ?? 0, now, key.cooldownUntil ?? 0)
  // 退避级别也要比较:级别封顶后冷却时长可能相同,但级别仍在增长,
  // 漏判会让级别不落盘,退避重新从低级别开始。
  if (key.health === verdict.health
    && (key.cooldownUntil ?? 0) === verdict.cooldownUntil
    && (key.cooldownLevel ?? 0) === verdict.level) {
    return { changed: false, health: verdict.health }
  }
  key.health = verdict.health
  key.cooldownUntil = verdict.cooldownUntil
  key.cooldownLevel = verdict.level
  return { changed: true, health: verdict.health }
}

/* ---------------------- 调用失败兜底判定 ---------------------- */

/**
 * 额度类失败的固定冷却时长。
 *
 * 余额窗口耗尽、探测判定的透支、调用兜底判定的欠费共用同一个值:额度是
 * 账户级状态,短时间内换回来也没意义;但不该像 invalid 那样永久拉黑——
 * 池内其他密钥可能属于别的账户。冷却到期后 isSelectable 会重新放行。
 */
export const QUOTA_COOLDOWN_MS = 10 * 60_000

/**
 * 额度/欠费类措辞。
 *
 * 厂商把「账户欠费」放在完全不同的层级:OpenAI 是 429 + `insufficient_quota`,
 * 智谱是 429 + 中文「账户已欠费」,DashScope 是 403 + `Arrearage`,
 * OpenRouter 是 402 + `payment_required`,Anthropic 是 402 + `billing_error`,
 * Kimi 是 429 + `exceeded_current_quota_error` 且消息形如
 * "Account balance is insufficient"(词序与英文惯用式相反);
 * 智谱无套餐账号是「当前用户不存在 coding plan」——资格缺失与欠费同级,
 * 换到池内其他密钥仍可能成功,不该当密钥无效拉黑;
 * MiniMax 无订阅是「no active token plan subscription」,无资格账号走
 * 会话鉴权报「cookie is missing, log in again」,同级处理。措辞集与
 * 上方 NO_PLAN_TEXT 保持一致:探测判"无套餐"的错误,真实调用也应换钥。
 * DSH 归一化后只有部分厂商落到 QUOTA,因此必须按措辞再兜一层。
 */
const QUOTA_FAILURE_TEXT = /insufficient[\s_-]?(?:quota|balance|credits?|funds)|exceeded_current_quota|credit[_-]?balance[_-]?exhausted|spend[\s_-]?limit|budget[\s_-]?(?:exceeded|exhausted|limit)|total[\s_-]?budget|key[\s_-]?limit[\s_-]?exceeded|payment[_-]?required|billing_error|arrearage|credit balance is too low|out of credits|(?:quota|balance|credits?)\b[^.]{0,24}(?:insufficient|exhausted|depleted|不足)|余额不足|余额已不足|账户欠费|欠费|额度不足|不存在\s*coding\s*plan|no\s+coding[\s_-]?plan|coding[\s_-]?plan.{0,12}(?:not\s+(?:exist|found|available)|missing)|未开通.{0,6}(?:coding\s*)?套餐|no\s+active[^\n]{0,24}\bplan\b(?:\s+subscription)?|cookie\s+is\s+missing/i

/**
 * 账户/策略类措辞。
 *
 * 出现在 401/403 里说明失败与「这把密钥本身无效」无关:DashScope 欠费给的是
 * 403 Arrearage,Anthropic 组织策略禁止 CORS 也是 401,OpenAI 的组织成员限制
 * 同理。把这些当密钥失效去换钥、标 invalid,会把整池密钥一次请求全部拉黑。
 *
 * 注意 `disabled` 必须绑定到 account/project/organization:厂商也会用
 * "API key is disabled" 表达密钥本身被停用,那种情况恰恰应该换钥。
 */
const ACCOUNT_FAILURE_TEXT = /arrearage|payment|billing|balance|credit|quota|额度|余额|欠费|organi[sz]ation|cors|spend[\s_-]?limit|account\b[^.]{0,40}(?:disabled|suspended|欠费)/i

/** 服务端瞬时故障:401/403 也可能是网关/认证服务抖动,不能据此判废钥。 */
const INFRA_FAILURE_TEXT = /service[\s_-]?unavailable|temporarily|try[\s_-]?again|maintenance|overloaded|网关|超时/i

/** 凭据级失败的措辞;命中即密钥本身的问题(覆盖 400/401/403 各种形态)。 */
const CREDENTIAL_FAILURE_TEXT = /invalid[\s_-]*(?:x-)?api[\s_-]*key|incorrect[\s_-]*(?:x-)?api[\s_-]*key|api[\s_-]*key[^.]{0,16}(?:missing|invalid|incorrect|disabled|revoked|expired|not[\s_-]*valid|缺失|无效|过期|非法)|invalid[_-]*credentials|invalid[_-]*authentication|authentication[\s_-]?fails?|\bauthentication\b|身份验证失败|认证失败|鉴权失败/i

/**
 * 授权范围类措辞:密钥可能是好的,只是没有访问某个模型/资源的权限。
 *
 * Anthropic 的 `permission_error`(无权使用指定模型)是典型例子:换一把钥
 * 未必有用,更不该把它标成永久 invalid——一次模型权限 403 就能打空整池。
 */
const AUTHORIZATION_SCOPE_TEXT = /permission|not[\s_-]?allowed|no[\s_-]?access|does[\s_-]?not[\s_-]?have[\s_-]?access|forbidden|权限/i

/**
 * 判定一次模型调用失败该不该换钥。
 *
 * 顺序很重要:先认额度(欠费可能被厂商塞进 403/AUTH),再用账户/基础设施
 * 措辞否决,然后认凭据措辞,最后才用 DSH 的归一化码兜底。返回 none 时
 * 调用方必须原样透传失败,不能吞错。
 *
 * @param failure DSH 归一化后的失败事实 `{ message, code, status? }`
 * @returns {{action: 'invalid'|'quota'|'none', reason: string}}
 */
export function classifyStreamFailure(failure) {
  if (failure === null || typeof failure !== 'object') return { action: 'none', reason: 'empty' }
  const code = typeof failure.code === 'string' ? failure.code : ''
  const message = typeof failure.message === 'string' ? failure.message : ''
  const status = Number.isInteger(failure.status) ? failure.status : undefined
  if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA' || status === 402 || QUOTA_FAILURE_TEXT.test(message)) {
    return { action: 'quota', reason: code === 'QUOTA' || code === 'ACCOUNT_QUOTA' || status === 402 ? 'code' : 'wording' }
  }
  // 账户/策略级失败:即使带着 401/403 也不能当密钥失效。
  if (ACCOUNT_FAILURE_TEXT.test(message)) return { action: 'none', reason: 'account' }
  // 网关/认证服务抖动:短暂失败不该把密钥永久拉黑。
  if (INFRA_FAILURE_TEXT.test(message)) return { action: 'none', reason: 'infra' }
  // 凭据措辞:有些厂商把无效密钥报成 400(如 "API key not valid")。
  if (CREDENTIAL_FAILURE_TEXT.test(message)) return { action: 'invalid', reason: 'wording' }
  // 权限范围问题:换钥未必有用,更不该标 invalid。
  if (AUTHORIZATION_SCOPE_TEXT.test(message)) return { action: 'none', reason: 'scope' }
  // DSH 已归一化为 AUTH/INVALID_CREDENTIAL 的 401/403:厂商可能只回
  // "401 Unauthorized" 或给独立的 status,不能强求措辞。
  if (code === 'AUTH' || code === 'INVALID_CREDENTIAL' || status === 401 || status === 403) {
    return { action: 'invalid', reason: 'code' }
  }
  // 防御:码没归类但消息里带 401/403。
  if (/\b(?:401|403)\b/.test(message)) return { action: 'invalid', reason: 'status' }
  return { action: 'none', reason: 'other' }
}

/**
 * 是「已产出内容」的流块吗。
 *
 * 判零内容重试时不能把元数据块算成内容:pi-ai 适配器的失败流固定先发
 * 一个 `usage` 块再发错误终止块,把它当内容会让兜底对所有 pi-ai 供应商失效。
 *
 * @param chunk 尚未送出的流块
 * @returns 是否代表调用方已经看到了模型输出
 */
export function isStreamContentChunk(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false
  return chunk.type !== 'usage' && chunk.type !== 'finish'
}

/**
 * 是否是「适配器失败」的终止块。
 *
 * DSH 不会把适配器异常抛给 llm/stream 监听器,而是转成终止块下发:
 * `{ type:'finish', reason:{ kind:'error', failure:{...} } }`。
 * 只有这种块允许触发兜底;正常结束、中断、消费方错误都不行。
 */
export function isFallbackFailureChunk(chunk) {
  return chunk !== null
    && typeof chunk === 'object'
    && chunk.type === 'finish'
    && chunk.reason !== null
    && typeof chunk.reason === 'object'
    && chunk.reason.kind === 'error'
    && chunk.reason.failure !== null
    && typeof chunk.reason.failure === 'object'
}

/**
 * 轮换候选判定:无效密钥跳过;限流密钥在冷却期内跳过(到期自动恢复参选)。
 *
 * 注意 valueMissing 只存在于**视图投影**(projectProvider 产出),
 * 池内原始记录没有这个字段——轮换路径上"值已被外部删除"的密钥由
 * activate 失败兜底(标记为 invalid 后继续找下一把)。
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
