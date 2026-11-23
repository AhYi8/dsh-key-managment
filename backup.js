/**
 * WebDAV 备份/恢复的核心纯逻辑。
 *
 * 职责:
 * - 备份快照的构建:密钥池(含每把密钥的明文值)与当前生效指针,
 *   不含探测间隔、兜底开关等本机运行偏好(不同机器合理地不同);
 * - 快照加密:AES-256-GCM,密钥由用户配置的加密密钥经 scrypt 派生;
 *   解密失败(多端密钥不一致 / 文件损坏)必须显式抛错,调用方据此
 *   中止恢复、绝不覆盖本地数据;
 * - 文件名与轮转:`<设备名>-<YYYYMMDDHHmmss>.kpool.bak`,同一远程目录
 *   按设备名前缀过滤,每设备各保留 N 份;
 * - 恢复计划:由快照与当前状态推导出凭据写入/清理清单与新的
 *   providers 状态,宿主只负责执行,保证核心逻辑可单测。
 *
 * 该模块不依赖宿主运行时(Node API 仅用 node:crypto),与 core.js 同一套约定。
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { promisify } from 'node:util'
import { normalizeRotation, STATE_VERSION, hitValue, BALANCE_COOLDOWN_REASON } from './core.js'

const scryptAsync = promisify(scrypt)

/** 备份文件魔数与格式版本:用于快速识别文件类型与不兼容格式。 */
export const BACKUP_MAGIC = Buffer.from('KMBKV1\n', 'utf8')
/** 快照 JSON 的结构版本;字段或语义变化时递增。 */
export const SNAPSHOT_VERSION = 1
/** 备份文件扩展名:远程目录里按它过滤本插件的文件。 */
export const BACKUP_EXTENSION = '.kpool.bak'

/** scrypt 派生参数(N=16384 默认)。盐固定 16 字节,IV 固定 12 字节,tag 固定 16 字节。 */
const SALT_LENGTH = 16
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32

/** 文件名里的设备名长度上限:避免超长名撑爆目录列表。 */
const MAX_DEVICE_LENGTH = 40

/** 时间戳的本地时间格式:YYYYMMDDHHmmss。 */
function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * 清洗设备名:把路径不安全字符(含斜杠)替换为下划线,超长截断,空值兜底。
 * 保留 Unicode 字母与数字:设备名常是中文(如"联想小新"),ASCII-only 清洗
 * 会把整段名字折空、退化为兜底名 device,失去设备区分意义。
 * 多端设备名必须不同(前缀过滤按它分组),但本模块不负责唯一性。
 */
export function sanitizeDeviceName(raw) {
  const cleaned = String(raw ?? '').trim().replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^[._-]+|[._-]+$/g, '').slice(0, MAX_DEVICE_LENGTH)
  return cleaned.length > 0 ? cleaned : 'device'
}

/** 生成备份文件名:本地时间戳,人眼可读。 */
export function backupFileName(device, date = new Date()) {
  return `${sanitizeDeviceName(device)}-${formatTimestamp(date)}${BACKUP_EXTENSION}`
}

/**
 * 解析备份文件名;不是本插件命名格式的文件返回 null(轮转时忽略,
 * 绝不触碰远程目录里不属于我们的文件)。
 */
export function parseBackupFileName(name) {
  // 含路径分隔符的名字一律拒绝:远程列表里的恶意名字不得借 remotePath 穿越目录。
  if (typeof name !== 'string' || name.length === 0 || /[/\\]/.test(name)) return null
  if (!name.endsWith(BACKUP_EXTENSION)) return null
  const stem = name.slice(0, -BACKUP_EXTENSION.length)
  const separator = stem.lastIndexOf('-')
  if (separator <= 0) return null
  const stamp = stem.slice(separator + 1)
  // 时间戳必须是 14 位数字。
  if (!/^\d{14}$/.test(stamp)) return null
  const year = Number(stamp.slice(0, 4))
  const month = Number(stamp.slice(4, 6))
  const day = Number(stamp.slice(6, 8))
  const hour = Number(stamp.slice(8, 10))
  const minute = Number(stamp.slice(10, 12))
  const second = Number(stamp.slice(12, 14))
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null
  // 直接 new Date(y, m-1, ...) 按本地字段构造,月份从 0 起。
  const timestamp = new Date(year, month - 1, day, hour, minute, second).getTime()
  if (!Number.isFinite(timestamp)) return null
  return { device: sanitizeDeviceName(stem.slice(0, separator)), timestamp, name }
}

/**
 * 解析远程目录里的备份文件列表(已按新到旧排序)。
 * 无法解析的条目原样保留在 unrecognised 里,轮转与恢复都不碰它们。
 */
export function listBackups(names) {
  const backups = []
  const unrecognised = []
  for (const name of names ?? []) {
    const parsed = parseBackupFileName(name)
    if (parsed === null) unrecognised.push(name)
    else backups.push(parsed)
  }
  backups.sort((a, b) => b.timestamp - a.timestamp)
  return { backups, unrecognised }
}

/**
 * 按设备名前缀计算轮转删除清单:同一设备只保留最新的 keep 份。
 * 返回超限的旧文件名数组(新到旧排序后的尾部)。
 */
export function backupsToDelete(names, device, keep) {
  const limit = Math.max(1, Math.round(Number(keep) || 1))
  const wanted = sanitizeDeviceName(device)
  const mine = listBackups(names).backups.filter(entry => entry.device === wanted)
  return mine.slice(limit).map(entry => entry.name)
}

/* ------------------------------ 加解密 ------------------------------ */

/**
 * 用 scrypt 派生密钥;password 为空时抛错——没有加密密钥就不允许备份,
 * 这是防止"忘了填密钥导致云端落了明文"的硬闸门。
 */
export async function deriveKey(password, salt) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('未配置备份加密密钥')
  }
  return scryptAsync(password, salt, KEY_LENGTH)
}

/**
 * 加密快照对象为二进制备份文件内容:
 * `[magic 8][salt 16][iv 12][tag 16][ciphertext]`。
 */
export async function encryptSnapshot(snapshot, password) {
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const key = await deriveKey(password, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(snapshot), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([BACKUP_MAGIC, salt, iv, cipher.getAuthTag(), ciphertext])
}

/**
 * 解密备份文件内容为快照对象。
 *
 * - 魔数不符 / 长度不足:文件不是本插件格式或已截断;
 * - GCM auth tag 校验失败:密码不一致(多端密钥不同步)或密文被篡改。
 * 两种情况都直接抛错,由调用方决定如何呈现——核心原则是失败即中止,
 * 绝不向调用方返回部分内容。
 */
export async function decryptSnapshot(buffer, password) {
  if (!Buffer.isBuffer(buffer) || buffer.length < BACKUP_MAGIC.length + SALT_LENGTH + IV_LENGTH + TAG_LENGTH) {
    throw new Error('备份文件格式无效或已损坏')
  }
  if (!buffer.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
    throw new Error('备份文件格式无效或已损坏')
  }
  let offset = BACKUP_MAGIC.length
  const salt = buffer.subarray(offset, offset + SALT_LENGTH)
  offset += SALT_LENGTH
  const iv = buffer.subarray(offset, offset + IV_LENGTH)
  offset += IV_LENGTH
  const tag = buffer.subarray(offset, offset + TAG_LENGTH)
  offset += TAG_LENGTH
  const ciphertext = buffer.subarray(offset)
  const key = await deriveKey(password, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  let plaintext
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    // GCM final() 在 tag 不符时抛错:最可能是多端加密密钥不一致。
    throw new Error('解密失败:加密密钥与备份不一致')
  }
  try {
    return JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new Error('备份内容不是合法 JSON')
  }
}

/** 备份间隔下限(分钟):备份是秒级操作,下限防误配出轮询风暴,不做额外并发哨兵。 */
export const BACKUP_INTERVAL_MIN_MINUTES = 5

/**
 * 校验备份配置补丁;返回错误消息(null 表示通过)。
 * 与 validateProbeConfig 同一约定:界面与宿主共用一份规则。
 */
export function validateBackupConfig(patch) {
  if (patch === null || typeof patch !== 'object') return '配置补丁必须是对象'
  if (patch.webdavEnabled !== undefined && typeof patch.webdavEnabled !== 'boolean') {
    return 'webdavEnabled 必须是布尔值'
  }
  for (const field of ['webdavUrl', 'webdavUsername', 'webdavPassword', 'webdavEncryptKey', 'webdavDevice']) {
    if (patch[field] !== undefined && typeof patch[field] !== 'string') {
      return `${field} 必须是字符串`
    }
  }
  if (patch.webdavDir !== undefined) {
    if (typeof patch.webdavDir !== 'string') return 'webdavDir 必须是字符串'
    // 目录段拒绝路径不安全内容:反斜杠/..段/空段会让 remotePath 拼接
    // 与逐级建目录行为不可预期(部分服务端把 \ 当分隔符)。
    if (/[\\]/.test(patch.webdavDir) || patch.webdavDir.split('/').some(part => part === '' || part === '.' || part === '..')) {
      return 'webdavDir 不能包含反斜杠、空段或 .. 路径段'
    }
  }
  if (patch.webdavUrl !== undefined && patch.webdavUrl !== ''
    && !/^https?:\/\//i.test(patch.webdavUrl.trim())) {
    return 'webdavUrl 必须以 http(s):// 开头'
  }
  const interval = patch.webdavIntervalMin
  if (interval !== undefined
    && (typeof interval !== 'number' || !Number.isFinite(interval)
      || interval < BACKUP_INTERVAL_MIN_MINUTES || interval > 1440)) {
    return `webdavIntervalMin 必须是 ${BACKUP_INTERVAL_MIN_MINUTES}-1440 之间的数字`
  }
  const keep = patch.webdavKeep
  if (keep !== undefined
    && (typeof keep !== 'number' || !Number.isInteger(keep) || keep < 1 || keep > 50)) {
    return 'webdavKeep 必须是 1-50 之间的整数'
  }
  return null
}

/* ---------------------------- 快照构建 ---------------------------- */

/**
 * 构建备份快照。
 *
 * - 密钥池含每把密钥的明文值:状态文件里只有凭据引用,不解析明文的
 *   备份恢复到另一台机器后无从写入凭据存储;
 * - 当前生效指针(keyRef 与 activeKeyId)一并备份:恢复即接管运行状态;
 * - 轮换配置随池走(它是池语义的一部分),探测间隔等全局偏好不进来;
 * - 值不可读的密钥(凭据被外部删除)跳过:备份一把无法恢复的空引用没有意义。
 *
 * @param state 规范化后的插件状态(normalizeState 产物)
 * @param resolveValue async (ref) => string | { value } | undefined 凭据解析函数;
 *   兼容裸字符串与宿主的 { value, source } 形态(经 hitValue 统一提取)。
 */
export async function buildSnapshot(state, resolveValue) {
  const providers = {}
  for (const record of Object.values(state?.providers ?? {})) {
    const keys = []
    for (const key of record.keys ?? []) {
      const value = hitValue(await resolveValue(key.ref))
      if (typeof value !== 'string' || value.length === 0) continue
      keys.push({
        id: key.id,
        alias: key.alias,
        createdAt: key.createdAt ?? 0,
        lastUsedAt: key.lastUsedAt ?? 0,
        health: key.health ?? 'unknown',
        cooldownUntil: key.cooldownUntil ?? 0,
        cooldownLevel: key.cooldownLevel ?? 0,
        // 限流原因标记随快照保留,恢复后余额不足密钥仍能继续参与探测调度。
        cooldownReason: key.cooldownReason === BALANCE_COOLDOWN_REASON ? BALANCE_COOLDOWN_REASON : '',
        value,
      })
    }
    // 原始引用的当前值:恢复时写回它,使该供应商立即以备份时的生效钥服务。
    const keyRefValue = hitValue(await resolveValue(record.keyRef))
    providers[record.provider] = {
      provider: record.provider,
      displayName: record.displayName,
      settingsNs: record.settingsNs,
      keyRef: record.keyRef,
      keyRefValue: typeof keyRefValue === 'string' ? keyRefValue : null,
      activeKeyId: record.activeKeyId ?? null,
      rotation: normalizeRotation(record.rotation),
      cursor: record.cursor ?? 0,
      requestCount: record.requestCount ?? 0,
      lastRotatedAt: record.lastRotatedAt ?? 0,
      keys,
    }
  }
  return {
    version: SNAPSHOT_VERSION,
    stateVersion: STATE_VERSION,
    createdAt: Date.now(),
    providers,
  }
}

/**
 * 规范化解密后的快照;结构不符合预期时返回 null(调用方报错中止,
 * 不允许"半信半疑"的数据覆盖本地)。
 */
export function normalizeRestoredSnapshot(raw) {
  if (raw === null || typeof raw !== 'object') return null
  if (raw.version !== SNAPSHOT_VERSION) return null
  const input = raw.providers
  if (input === null || typeof input !== 'object') return null
  const providers = {}
  for (const [provider, record] of Object.entries(input)) {
    if (record === null || typeof record !== 'object') continue
    if (typeof record.provider !== 'string' || record.provider.length === 0) continue
    if (typeof record.keyRef !== 'string' || record.keyRef.length === 0) continue
    const keys = Array.isArray(record.keys) ? record.keys : []
    // 密钥 id 在池内必须唯一:快照若含重复 id,按 id 的查找与生效指针
    // 会命中任意一把。这里只保留每个 id 的首次出现,防畸形备份。
    const seenIds = new Set()
    const cleanedKeys = []
    for (const key of keys) {
      if (key === null || typeof key !== 'object') continue
      if (typeof key.id !== 'string' || key.id.length === 0) continue
      if (typeof key.value !== 'string' || key.value.length === 0) continue
      if (seenIds.has(key.id)) continue
      seenIds.add(key.id)
      cleanedKeys.push({
        id: key.id,
        alias: typeof key.alias === 'string' && key.alias.length > 0 ? key.alias : 'Key_1',
        createdAt: typeof key.createdAt === 'number' ? key.createdAt : 0,
        lastUsedAt: typeof key.lastUsedAt === 'number' ? key.lastUsedAt : 0,
        health: key.health === 'ok' || key.health === 'limited' || key.health === 'invalid' ? key.health : 'unknown',
        cooldownUntil: typeof key.cooldownUntil === 'number' && key.cooldownUntil > 0 ? key.cooldownUntil : 0,
        cooldownLevel: typeof key.cooldownLevel === 'number' && key.cooldownLevel > 0 ? Math.round(key.cooldownLevel) : 0,
        cooldownReason: key.cooldownReason === BALANCE_COOLDOWN_REASON ? BALANCE_COOLDOWN_REASON : '',
        value: key.value,
      })
    }
    providers[provider] = {
      provider: record.provider,
      displayName: typeof record.displayName === 'string' ? record.displayName : record.provider,
      settingsNs: typeof record.settingsNs === 'string' ? record.settingsNs : '',
      keyRef: record.keyRef,
      keyRefValue: typeof record.keyRefValue === 'string' && record.keyRefValue.length > 0 ? record.keyRefValue : null,
      activeKeyId: typeof record.activeKeyId === 'string' ? record.activeKeyId : null,
      rotation: normalizeRotation(record.rotation),
      cursor: typeof record.cursor === 'number' ? record.cursor : 0,
      requestCount: typeof record.requestCount === 'number' && record.requestCount > 0 ? record.requestCount : 0,
      lastRotatedAt: typeof record.lastRotatedAt === 'number' ? record.lastRotatedAt : 0,
      keys: cleanedKeys,
    }
  }
  return { providers }
}

/* ---------------------------- 恢复计划 ---------------------------- */

/**
 * 由规范化快照与当前状态推导恢复计划。
 *
 * 覆盖语义:
 * - 每把池内密钥在本机生成**新的**凭据引用并写入值:不复用备份里的
 *   引用名,避免与本地既有引用冲突;
 * - 原始引用(keyRef)的值直接覆盖写:恢复后该供应商立即以备份时的
 *   生效钥服务;keyRef 值缺失时只写池、不覆盖原引用;
 * - 生效指针指向的密钥不在池内时(理论上不该发生,防御性处理),
 *   回退到第一把密钥并记录告警;
 * - 本地有而备份里没有的供应商:整池移除,其池内凭据引用一并清理
 *   (原始引用属于设置页命名空间,不在清理之列)。
 *
 * @param snapshot normalizeRestoredSnapshot 产物
 * @param currentProviders 当前 state.providers
 * @param newRef (provider) => string 凭据引用生成函数(宿主注入 core.newPoolRef)
 * @returns { refsToSet, refsToUnset, providers, warnings }
 */
export function planRestore(snapshot, currentProviders, newRef) {
  const refsToSet = []
  const warnings = []
  const providers = {}
  for (const record of Object.values(snapshot.providers)) {
    const keys = []
    let activeKeyId = record.activeKeyId
    for (const key of record.keys) {
      const ref = newRef(record.provider)
      refsToSet.push({ ref, value: key.value })
      keys.push({
        id: key.id,
        alias: key.alias,
        ref,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
        health: key.health,
        cooldownUntil: key.cooldownUntil,
        cooldownLevel: key.cooldownLevel,
        cooldownReason: key.cooldownReason ?? '',
      })
    }
    if (keys.length > 0 && !keys.some(key => key.id === activeKeyId)) {
      activeKeyId = keys[0].id
      warnings.push(`${record.provider}: 生效指针指向的密钥不在备份池内,已回退到第一把`)
    }
    if (keys.length === 0) {
      warnings.push(`${record.provider}: 备份池为空(所有密钥值均不可读),跳过该供应商`)
      continue
    }
    // 原始引用的值一并覆盖:keyRefValue 为空说明备份时原引用就无值,
    // 保持现状比写入空值更安全。
    if (record.keyRefValue !== null) {
      refsToSet.push({ ref: record.keyRef, value: record.keyRefValue })
    }
    providers[record.provider] = {
      provider: record.provider,
      displayName: record.displayName,
      settingsNs: record.settingsNs,
      keyRef: record.keyRef,
      activeKeyId,
      rotation: record.rotation,
      cursor: record.cursor,
      requestCount: record.requestCount,
      lastRotatedAt: record.lastRotatedAt,
      keys,
    }
  }
  // 清理旧池凭据引用:
  // - 被恢复供应商的旧池引用:池已整体换新引用,旧引用成为孤儿明文,
  //   不清理会随恢复次数在凭据存储里无限积累(安全卫生问题);
  // - 备份里没有的供应商:整池移除,其池内凭据引用一并清理;
  // - 原始引用属于设置页命名空间,保留不动。
  const refsToUnset = []
  for (const record of Object.values(currentProviders ?? {})) {
    for (const key of record.keys ?? []) {
      if (typeof key.ref !== 'string' || key.ref.length === 0) continue
      // 恢复执行顺序是先写新引用再清理旧引用,这里统一收集是安全的。
      if (snapshot.providers[record.provider] !== undefined || providers[record.provider] === undefined) {
        refsToUnset.push(key.ref)
      }
    }
  }
  return { refsToSet, refsToUnset, providers, warnings }
}
