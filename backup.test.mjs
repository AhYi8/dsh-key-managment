/** backup.js 的单测,使用 Node 内置 test runner(node --test)。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKUP_EXTENSION,
  backupFileName,
  backupsToDelete,
  buildSnapshot,
  decryptSnapshot,
  deriveKey,
  encryptSnapshot,
  listBackups,
  normalizeRestoredSnapshot,
  parseBackupFileName,
  planRestore,
  sanitizeDeviceName,
  validateBackupConfig,
} from './backup.js'
import { newPoolRef, normalizeState } from './core.js'

test('sanitizeDeviceName 只保留文件名安全字符', () => {
  // 保留 Unicode 字母:中文设备名是常见输入,折叠为空会退化成兜底名 device。
  assert.equal(sanitizeDeviceName('联想小新'), '联想小新')
  // 路径分隔符等不安全字符替换为下划线。
  assert.equal(sanitizeDeviceName('PC/01\\dev'), 'PC_01_dev')
  assert.equal(sanitizeDeviceName('  laptop.dev  '), 'laptop.dev')
  assert.equal(sanitizeDeviceName('///'), 'device')
  assert.equal(sanitizeDeviceName('。。。'), 'device')
  assert.equal(sanitizeDeviceName(undefined), 'device')
  assert.ok(sanitizeDeviceName('x'.repeat(100)).length <= 40)
})

test('backupFileName 与 parseBackupFileName 往返一致', () => {
  const date = new Date(2026, 10, 15, 13, 42, 30) // 本地时间 20261115134230
  const name = backupFileName('desktop', date)
  assert.equal(name, `desktop-20261115134230${BACKUP_EXTENSION}`)
  const parsed = parseBackupFileName(name)
  assert.notEqual(parsed, null)
  assert.equal(parsed.device, 'desktop')
  assert.equal(parsed.timestamp, date.getTime())
})

test('parseBackupFileName 拒绝非本插件命名与非法时间戳', () => {
  assert.equal(parseBackupFileName('random-file.txt'), null)
  assert.equal(parseBackupFileName(`desktop-99999999999999${BACKUP_EXTENSION}`), null)
  assert.equal(parseBackupFileName(`desktop-20261301120000${BACKUP_EXTENSION}`), null)
  // 路径穿越:带分隔符的名字不是合法备份名。
  assert.equal(parseBackupFileName(`../evil-20261115134230${BACKUP_EXTENSION}`), null)
})

test('listBackups 按新到旧排序并保留无法识别的条目', () => {
  const { backups, unrecognised } = listBackups([
    `a-20261115090000${BACKUP_EXTENSION}`,
    'other.txt',
    `a-20261115100000${BACKUP_EXTENSION}`,
    `b-20261115080000${BACKUP_EXTENSION}`,
  ])
  assert.deepEqual(backups.map(entry => entry.device), ['a', 'a', 'b'])
  assert.deepEqual(backups.map(entry => entry.timestamp), [
    new Date(2026, 10, 15, 10).getTime(),
    new Date(2026, 10, 15, 9).getTime(),
    new Date(2026, 10, 15, 8).getTime(),
  ])
  assert.deepEqual(unrecognised, ['other.txt'])
})

test('backupsToDelete 每设备保留 N 份、删最旧、不碰其它设备', () => {
  const names = [
    `desktop-20261115090000${BACKUP_EXTENSION}`,
    `desktop-20261115100000${BACKUP_EXTENSION}`,
    `desktop-20261115110000${BACKUP_EXTENSION}`,
    `laptop-20261115070000${BACKUP_EXTENSION}`,
  ]
  const victims = backupsToDelete(names, 'desktop', 2)
  assert.deepEqual(victims, [`desktop-20261115090000${BACKUP_EXTENSION}`])
  assert.deepEqual(backupsToDelete(names, 'laptop', 2), [])
  assert.deepEqual(backupsToDelete(names, 'missing', 2), [])
})

test('deriveKey 与加密密钥校验:空密钥被拒绝', async () => {
  await assert.rejects(() => deriveKey('', Buffer.alloc(16)), /未配置备份加密密钥/)
})

test('encryptSnapshot 与 decryptSnapshot 往返一致', async () => {
  const snapshot = { hello: 'world', nested: { count: 3 } }
  const buffer = await encryptSnapshot(snapshot, '共享密钥')
  const restored = await decryptSnapshot(buffer, '共享密钥')
  assert.deepEqual(restored, snapshot)
})

test('decryptSnapshot 拒绝错误密钥且不产出内容', async () => {
  const buffer = await encryptSnapshot({ secret: 1 }, '密钥A')
  await assert.rejects(() => decryptSnapshot(buffer, '密钥B'), /加密密钥与备份不一致/)
})

test('decryptSnapshot 拒绝损坏与非本插件格式', async () => {
  const buffer = await encryptSnapshot({ ok: 1 }, 'k')
  await assert.rejects(() => decryptSnapshot(buffer.subarray(1), 'k'))
  await assert.rejects(() => decryptSnapshot(Buffer.from('not a backup'), 'k'))
})

test('buildSnapshot 备份池明文与指针,不含全局设置,跳过不可读密钥', async () => {
  const state = normalizeState({
    providers: {
      deepseek: {
        provider: 'deepseek',
        displayName: 'DeepSeek',
        settingsNs: 'llm-deepseek',
        keyRef: 'DEEPSEEK_API_KEY',
        activeKeyId: 'k1',
        keys: [
          { id: 'k1', alias: 'Key_1', ref: 'REF_A', createdAt: 1, lastUsedAt: 2, health: 'ok' },
          { id: 'k2', alias: 'Key_2', ref: 'REF_LOST', createdAt: 3, lastUsedAt: 0, health: 'unknown' },
        ],
      },
    },
  })
  const snapshot = await buildSnapshot(state, async (ref) => (ref === 'REF_A' ? 'sk-value' : undefined))
  assert.deepEqual(Object.keys(snapshot.providers), ['deepseek'])
  const record = snapshot.providers.deepseek
  assert.equal(record.keys.length, 1)
  assert.equal(record.keys[0].value, 'sk-value')
  assert.equal(record.keyRefValue, null) // 原引用不可读:留 null,恢复时不覆盖
  assert.equal(record.activeKeyId, 'k1')
  // 全局偏好(探测配置)绝不出现在快照里。
  assert.equal(JSON.stringify(snapshot).includes('quotaProbe'), false)
  assert.equal(JSON.stringify(snapshot).includes('fallbackOnFailure'), false)
})

test('buildSnapshot 兼容宿主 { value, source } 形态的解析结果', async () => {
  const state = normalizeState({
    providers: {
      p1: {
        provider: 'p1',
        displayName: 'P1',
        settingsNs: 'ns',
        keyRef: 'P1_KEY',
        activeKeyId: 'k1',
        keys: [{ id: 'k1', alias: 'Key_1', ref: 'REF_A', createdAt: 1, lastUsedAt: 0 }],
      },
    },
  })
  // 宿主的 safeResolve 返回 { value, source } 对象而非裸字符串:
  // 不做 hitValue 提取会让快照全部空池(曾因此产出残缺备份并导致恢复丢数据)。
  const snapshot = await buildSnapshot(state, async (ref) => ({ value: 'sk-hit', source: 'test' }))
  assert.equal(snapshot.providers.p1.keys.length, 1)
  assert.equal(snapshot.providers.p1.keys[0].value, 'sk-hit')
  assert.equal(snapshot.providers.p1.keyRefValue, 'sk-hit')
})

test('normalizeRestoredSnapshot 清洗非法条目并拒绝坏结构', () => {
  assert.equal(normalizeRestoredSnapshot(null), null)
  assert.equal(normalizeRestoredSnapshot({ version: 99, providers: {} }), null)
  assert.equal(normalizeRestoredSnapshot({ version: 1 }), null)
  const cleaned = normalizeRestoredSnapshot({
    version: 1,
    providers: {
      p1: {
        provider: 'p1',
        keyRef: 'P1_KEY',
        keyRefValue: 'sk-origin',
        activeKeyId: 'k1',
        keys: [
          { id: 'k1', alias: 'Key_1', value: 'sk-1' },
          { id: 'bad', value: '' }, // 空值剔除
          null,
        ],
      },
      broken: { provider: '', keyRef: '' }, // 无效记录剔除
    },
  })
  assert.notEqual(cleaned, null)
  assert.deepEqual(Object.keys(cleaned.providers), ['p1'])
  assert.equal(cleaned.providers.p1.keys.length, 1)
  assert.equal(cleaned.providers.p1.keys[0].value, 'sk-1')
})

test('backup:快照往返保留 balance 原因标记并清洗非法值', async () => {
  // 备份侧:buildSnapshot 保留 balance 标记,非法值回落为空串。
  const state = normalizeState({
    providers: {
      p1: {
        provider: 'p1', keyRef: 'P1_KEY', activeKeyId: 'k1',
        keys: [
          { id: 'k1', alias: 'Key_1', ref: 'REF_A', health: 'limited', cooldownUntil: 1000, cooldownReason: 'balance' },
          { id: 'k2', alias: 'Key_2', ref: 'REF_B', health: 'limited', cooldownUntil: 1000, cooldownReason: 'hacked' },
        ],
      },
    },
  })
  const snapshot = await buildSnapshot(state, async (ref) => `sk-${ref}`)
  assert.equal(snapshot.providers.p1.keys[0].cooldownReason, 'balance')
  assert.equal(snapshot.providers.p1.keys[1].cooldownReason, '')

  // 恢复侧:normalizeRestoredSnapshot 只认 balance,缺失/非法都回落为空。
  const restored = normalizeRestoredSnapshot({
    version: 1,
    providers: {
      p1: {
        provider: 'p1', keyRef: 'P1_KEY', keyRefValue: 'sk-origin', activeKeyId: 'k1',
        keys: [
          { id: 'k1', alias: 'Key_1', value: 'sk-1', health: 'limited', cooldownUntil: 1000, cooldownReason: 'balance' },
          { id: 'k2', alias: 'Key_2', value: 'sk-2', health: 'limited', cooldownUntil: 1000, cooldownReason: 42 },
        ],
      },
    },
  })
  assert.equal(restored.providers.p1.keys[0].cooldownReason, 'balance')
  assert.equal(restored.providers.p1.keys[1].cooldownReason, '')

  // 计划侧:旧版本快照缺 cooldownReason 字段时回落为空串(?? '' 回退分支)。
  const legacy = normalizeRestoredSnapshot({
    version: 1,
    providers: {
      p1: {
        provider: 'p1', keyRef: 'P1_KEY', keyRefValue: 'sk-origin', activeKeyId: 'k1',
        keys: [{ id: 'k1', alias: 'Key_1', value: 'sk-1', health: 'limited', cooldownUntil: 1000 }],
      },
    },
  })
  const plan = planRestore(legacy, {}, provider => newPoolRef(provider))
  assert.equal(plan.providers.p1.keys[0].cooldownReason, '')
})

test('planRestore 生成新引用、覆盖原引用、清理被移除供应商', () => {
  const snapshot = normalizeRestoredSnapshot({
    version: 1,
    providers: {
      p1: {
        provider: 'p1',
        keyRef: 'P1_KEY',
        keyRefValue: 'sk-origin',
        activeKeyId: 'k1',
        keys: [{ id: 'k1', alias: 'Key_1', value: 'sk-1' }],
      },
    },
  })
  const current = normalizeState({
    providers: {
      p1: { provider: 'p1', keyRef: 'P1_KEY', activeKeyId: 'k1', keys: [{ id: 'k1', alias: 'Key_1', ref: 'OLD_REF' }] },
      p2: { provider: 'p2', keyRef: 'P2_KEY', activeKeyId: null, keys: [{ id: 'k9', alias: 'Key_1', ref: 'ORPHAN_REF' }] },
    },
  }).providers
  const plan = planRestore(snapshot, current, provider => newPoolRef(provider))
  // 池内新引用 + 原引用覆盖,共两处写入。
  assert.equal(plan.refsToSet.length, 2)
  const refs = plan.refsToSet.map(entry => entry.ref)
  assert.ok(refs.includes('P1_KEY'))
  assert.ok(refs.every(ref => ref !== 'OLD_REF'))
  assert.equal(plan.refsToSet.find(entry => entry.ref === 'P1_KEY').value, 'sk-origin')
  // 被恢复供应商(p1)的旧池引用与被移除供应商(p2)的池内引用都清理;
  // 原始引用不在清理之列。
  assert.ok(plan.refsToUnset.includes('OLD_REF'))
  assert.ok(plan.refsToUnset.includes('ORPHAN_REF'))
  assert.ok(!plan.refsToUnset.includes('P1_KEY'))
  assert.equal(plan.providers.p1.keys[0].ref, refs.find(ref => ref !== 'P1_KEY'))
  assert.deepEqual(plan.warnings, [])
})

test('planRestore 生效指针回退并告警;空池供应商跳过', () => {
  const snapshot = normalizeRestoredSnapshot({
    version: 1,
    providers: {
      p1: {
        provider: 'p1',
        keyRef: 'P1_KEY',
        keyRefValue: 'sk-origin',
        activeKeyId: 'k_missing',
        keys: [{ id: 'k1', alias: 'Key_1', value: 'sk-1' }],
      },
      p_empty: {
        provider: 'p_empty',
        keyRef: 'PE_KEY',
        keyRefValue: null,
        activeKeyId: null,
        keys: [],
      },
    },
  })
  const plan = planRestore(snapshot, {}, provider => newPoolRef(provider))
  assert.equal(plan.providers.p1.activeKeyId, 'k1')
  assert.ok(plan.warnings.some(line => line.includes('p1')))
  assert.equal(plan.providers.p_empty, undefined)
  assert.ok(plan.warnings.some(line => line.includes('p_empty')))
})

test('validateBackupConfig 校验类型、URL 与数值范围', () => {
  assert.equal(validateBackupConfig({}), null)
  assert.equal(validateBackupConfig({ webdavEnabled: true, webdavKeep: 5 }), null)
  assert.notEqual(validateBackupConfig({ webdavEnabled: 'yes' }), null)
  assert.notEqual(validateBackupConfig({ webdavUrl: 'ftp://x' }), null)
  assert.equal(validateBackupConfig({ webdavUrl: 'https://dav.example.com' }), null)
  assert.equal(validateBackupConfig({ webdavUrl: '' }), null) // 留空允许(未配置态)
  assert.notEqual(validateBackupConfig({ webdavIntervalMin: 1 }), null)
  assert.equal(validateBackupConfig({ webdavIntervalMin: 5 }), null)
  assert.notEqual(validateBackupConfig({ webdavKeep: 0 }), null)
  assert.notEqual(validateBackupConfig({ webdavKeep: 2.5 }), null)
  // webdavDir 拒绝路径不安全内容。
  assert.equal(validateBackupConfig({ webdavDir: 'backup/dsh-keys' }), null)
  assert.notEqual(validateBackupConfig({ webdavDir: 'a\\b' }), null)
  assert.notEqual(validateBackupConfig({ webdavDir: 'a/../b' }), null)
  assert.notEqual(validateBackupConfig({ webdavDir: 'a//b' }), null)
  assert.notEqual(validateBackupConfig({ webdavDir: './b' }), null)
})
