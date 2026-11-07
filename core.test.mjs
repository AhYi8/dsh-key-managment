/** core.js 的单测,使用 Node 内置 test runner(node --test)。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  digestOf,
  findKeyByDigest,
  hitValue,
  mergeRequestCounts,
  newProviderRecord,
  nextAlias,
  normalizeState,
  parseAction,
  probeRoundDelay,
  projectProvider,
  redactSecret,
  tailOf,
  validateAlias,
  validateKeyValue,
  validateProbeConfig,
} from './core.js'

test('validateKeyValue 拒绝空值与超长值', () => {
  assert.notEqual(validateKeyValue('  '), null)
  assert.notEqual(validateKeyValue(undefined), null)
  assert.notEqual(validateKeyValue(123), null)
  assert.equal(validateKeyValue('sk-abc'), null)
  assert.notEqual(validateKeyValue('x'.repeat(5000)), null)
})

test('validateAlias 只拒绝非法类型与超长', () => {
  assert.equal(validateAlias(undefined), null)
  assert.equal(validateAlias(''), null)
  assert.equal(validateAlias('我的主力 Key'), null)
  assert.notEqual(validateAlias(42), null)
  assert.notEqual(validateAlias('x'.repeat(81)), null)
})

test('nextAlias 基于历史最大编号自增,不受中间删除影响', () => {
  assert.equal(nextAlias([]), 'Key_1')
  assert.equal(nextAlias([{ alias: 'Key_1' }, { alias: 'Key_3' }]), 'Key_4')
  assert.equal(nextAlias([{ alias: '我的别名' }]), 'Key_1')
})

test('tailOf 只保留末 4 位', () => {
  assert.equal(tailOf('sk-abcdef'), 'cdef')
  assert.equal(tailOf('abc'), 'abc')
})

test('findKeyByDigest 按值摘要定位池内密钥', () => {
  const record = newProviderRecord('sub2api', 'Sub2API', 'llm-pi-ai', 'SUB2API_API_KEY')
  record.keys = [
    { id: 'k1', alias: 'Key_1', ref: 'REF_A', createdAt: 1, lastUsedAt: 0 },
    { id: 'k2', alias: 'Key_2', ref: 'REF_B', createdAt: 2, lastUsedAt: 0 },
  ]
  const digests = new Map([
    ['REF_A', digestOf('aaa')],
    ['REF_B', digestOf('bbb')],
  ])
  assert.equal(findKeyByDigest(record, digests, digestOf('bbb'))?.id, 'k2')
  assert.equal(findKeyByDigest(record, digests, digestOf('ccc')), undefined)
  assert.equal(findKeyByDigest(record, digests, undefined), undefined)
})

test('projectProvider 标注生效密钥、未知密钥与值缺失', () => {
  const record = newProviderRecord('temp', 'Temp', 'llm-pi-ai', 'TEMP_API_KEY')
  record.keys = [
    { id: 'k1', alias: 'Key_1', ref: 'REF_A', createdAt: 1, lastUsedAt: 0 },
    { id: 'k2', alias: 'Key_2', ref: 'REF_B', createdAt: 2, lastUsedAt: 0 },
  ]
  const digests = new Map([['REF_A', digestOf('aaa')]])
  // 原引用值与 Key_1 一致 → 生效密钥是 k1;REF_B 读不到 → 值缺失。
  let view = projectProvider(record, digests, { digest: digestOf('aaa'), tail: tailOf('aaa') })
  assert.equal(view.activeKeyId, 'k1')
  assert.equal(view.unknown, null)
  assert.equal(view.keys[1].valueMissing, true)

  // 原引用值不在池内 → unknown 带尾号,供一键纳管。
  view = projectProvider(record, digests, { digest: digestOf('zzz'), tail: tailOf('zzz') })
  assert.equal(view.unknown.tail, tailOf('zzz'))

  // 原引用无值 → 不标记未知。
  view = projectProvider(record, digests, null)
  assert.equal(view.unknown, null)
})

test('normalizeState 修复残缺状态文件', () => {
  const state = normalizeState({
    version: 999,
    providers: {
      good: {
        provider: 'good',
        displayName: 'Good',
        keyRef: 'GOOD_API_KEY',
        activeKeyId: 'k1',
        keys: [
          { id: 'k1', ref: 'REF_A' },
          null,
          { ref: 'NO_ID' },
          { id: 'k2', ref: 'REF_B', alias: '', createdAt: 'bad' },
        ],
      },
      bad: { displayName: '没有 keyRef' },
      broken: null,
    },
    extra: 'ignored',
  })
  assert.equal(state.version, 1)
  assert.equal(Object.keys(state.providers).length, 1)
  const good = state.providers.good
  assert.equal(good.displayName, 'Good')
  assert.equal(good.keys.length, 2)
  assert.equal(good.keys[1].alias, 'Key_1')
  assert.equal(good.keys[1].createdAt, 0)
})

test('parseBatchEntries 逐行解析,支持「名称|密钥」与注释行', async () => {
  const { parseBatchEntries } = await import('./core.js')
  const { entries, failures } = parseBatchEntries([
    'sk-one',
    '我的主力|sk-two',
    '',
    '# 这是注释',
    '   ',
  ].join('\n'))
  assert.equal(entries.length, 2)
  assert.equal(entries[0].value, 'sk-one')
  assert.equal(entries[0].alias, undefined)
  assert.equal(entries[1].value, 'sk-two')
  assert.equal(entries[1].alias, '我的主力')
  assert.equal(failures.length, 0)
})

test('parseBatchEntries 报告非法行号且不影响其它行', async () => {
  const { parseBatchEntries } = await import('./core.js')
  const { entries, failures } = parseBatchEntries('sk-ok\n\nsk-also-ok')
  assert.equal(entries.length, 2)
  assert.equal(failures.length, 0)

  // 名称后缺少密钥:明确报错,不当成密钥存进去。
  const bad = parseBatchEntries('sk-good\n名称|')
  assert.equal(bad.entries.length, 1)
  assert.equal(bad.failures.length, 1)
  assert.equal(bad.failures[0].line, 2)

  // 名称过长时整行按密钥处理,不会误判成名称。
  const long = parseBatchEntries(`${'x'.repeat(81)}|sk-value`)
  assert.equal(long.entries.length, 1)
  assert.equal(long.entries[0].value, `${'x'.repeat(81)}|sk-value`)
})

test('healthFromQuota:按探测结果推导有效/限流/无效', async () => {
  const { healthFromQuota } = await import('./core.js')
  const now = 1_000_000
  // ok 且窗口未耗尽 → 有效
  assert.equal(healthFromQuota({ status: 'ok', windows: [{ usedPercent: 66 }] }, 'unknown', 0, now).health, 'ok')
  // ok 但窗口 100% → 限流,冷却到重置时间
  const limited = healthFromQuota(
    { status: 'ok', windows: [{ usedPercent: 100, resetAt: now + 300_000 }] },
    'ok', 0, now)
  assert.equal(limited.health, 'limited')
  assert.equal(limited.cooldownUntil, now + 300_000)
  // 错误 kind=rate → 限流,指数退避(60s 起步)
  const rate = healthFromQuota({ status: 'error', error: { kind: 'rate', message: '429' } }, 'limited', 0, now)
  assert.equal(rate.health, 'limited')
  assert.ok(rate.cooldownUntil > now)
  // 错误 kind=auth → 无效
  assert.equal(healthFromQuota({ status: 'error', error: { kind: 'auth', message: '401' } }, 'ok', 0, now).health, 'invalid')
  // parse 类错误不改判
  assert.equal(healthFromQuota({ status: 'error', error: { kind: 'parse', message: 'x' } }, 'ok', 0, now).health, 'ok')
})

test('pickNextKeyId 跳过无效与冷却中的限流密钥', async () => {
  const { newProviderRecord, pickNextKeyId } = await import('./core.js')
  const now = 1_000_000
  const record = newProviderRecord('temp', 'Temp', 'llm-pi-ai', 'TEMP_API_KEY')
  record.activeKeyId = 'k1'
  record.keys = [
    { id: 'k1', alias: 'Key_1', ref: 'A', createdAt: 1, lastUsedAt: 0, health: 'ok', cooldownUntil: 0, valueMissing: false },
    { id: 'k2', alias: 'Key_2', ref: 'B', createdAt: 2, lastUsedAt: 0, health: 'invalid', cooldownUntil: 0, valueMissing: false },
    { id: 'k3', alias: 'Key_3', ref: 'C', createdAt: 3, lastUsedAt: 0, health: 'limited', cooldownUntil: now + 60_000, valueMissing: false },
    { id: 'k4', alias: 'Key_4', ref: 'D', createdAt: 4, lastUsedAt: 0, health: 'limited', cooldownUntil: now - 1, valueMissing: false },
  ]
  // k2 无效、k3 冷却中 → 跳过,选中冷却已过期的 k4。
  assert.equal(pickNextKeyId(record, now, 'k1'), 'k4')
  // 全部不可选时返回 undefined。
  record.keys[3].health = 'limited'
  record.keys[3].cooldownUntil = now + 60_000
  assert.equal(pickNextKeyId(record, now, 'k1'), undefined)
})

test('shouldRotateCalls 与 shouldRotateInterval 判定', async () => {
  const { shouldRotateCalls, shouldRotateInterval } = await import('./core.js')
  const calls = { mode: 'calls', requests: 10 }
  assert.equal(shouldRotateCalls(calls, 10), true)
  assert.equal(shouldRotateCalls(calls, 9), false)
  assert.equal(shouldRotateCalls({ mode: 'off', requests: 10 }, 99), false)
  const interval = { mode: 'interval', intervalMs: 600_000 }
  // 从未轮换过:以当前时间为基准,立即不轮,等满一个周期。
  assert.equal(shouldRotateInterval(interval, 0, 1_000_000), false)
  assert.equal(shouldRotateInterval(interval, 1_000_000, 1_000_000 + 599_999), false)
  assert.equal(shouldRotateInterval(interval, 1_000_000, 1_000_000 + 600_000), true)
})

test('probeRoundDelay:首轮立即,之后按间隔且不低于 1 分钟', () => {
  // 第 0 轮(启动首探)不等待,间隔写坏也不能挡住启动首探。
  assert.equal(probeRoundDelay(0, 1_800_000), 0)
  assert.equal(probeRoundDelay(0, 0), 0)
  assert.equal(probeRoundDelay(0, Number.NaN), 0)
  assert.equal(probeRoundDelay(-1, 1_800_000), 0)
  assert.equal(probeRoundDelay(Number.NaN, 1_800_000), 0)
  // 之后每轮等待配置的间隔。
  assert.equal(probeRoundDelay(1, 1_800_000), 1_800_000)
  assert.equal(probeRoundDelay(3, 300_000), 300_000)
  assert.equal(probeRoundDelay(2, 86_400_000), 86_400_000)
  // 间隔被写坏时钳回 1 分钟下限,避免打成轮询风暴。
  assert.equal(probeRoundDelay(1, 1), 60_000)
  assert.equal(probeRoundDelay(1, 0), 60_000)
  assert.equal(probeRoundDelay(1, -5), 60_000)
  assert.equal(probeRoundDelay(1, Number.NaN), 60_000)
  assert.equal(probeRoundDelay(1, Number.POSITIVE_INFINITY), 60_000)
})

test('validateProbeConfig 按区间与步长校验探测配置', () => {
  // 合法值通过。
  assert.equal(validateProbeConfig({}), null)
  assert.equal(validateProbeConfig({ quotaProbe: true }), null)
  assert.equal(validateProbeConfig({ quotaIntervalMs: 60_000 }), null)
  assert.equal(validateProbeConfig({ quotaIntervalMs: 1_800_000 }), null)
  assert.equal(validateProbeConfig({ quotaProbeGapMs: 5_000 }), null)
  // 类型错误。
  assert.equal(validateProbeConfig({ quotaProbe: 'yes' }), 'quotaProbe 必须是布尔值')
  assert.notEqual(validateProbeConfig({ quotaIntervalMs: '60000' }), null)
  // 越界。
  assert.equal(validateProbeConfig({ quotaIntervalMs: 59_999 }), 'quotaIntervalMs 必须是 60000-86400000 之间的数字')
  assert.equal(validateProbeConfig({ quotaIntervalMs: 86_400_001 }), 'quotaIntervalMs 必须是 60000-86400000 之间的数字')
  assert.equal(validateProbeConfig({ quotaProbeGapMs: 199 }), 'quotaProbeGapMs 必须是 200-60000 之间的数字')
  assert.equal(validateProbeConfig({ quotaProbeGapMs: 60_001 }), 'quotaProbeGapMs 必须是 200-60000 之间的数字')
  // 步长:不合规时宿主会抛英文原文错误,这里先给中文提示。
  assert.equal(validateProbeConfig({ quotaIntervalMs: 90_000 }), 'quotaIntervalMs 必须是 60000 的倍数(整分钟)')
  assert.equal(validateProbeConfig({ quotaProbeGapMs: 250 }), 'quotaProbeGapMs 必须是 100 的倍数')
  // 补丁本身必须是对象。
  assert.notEqual(validateProbeConfig(null), null)
})

test('parseAction 校验请求体', () => {
  assert.notEqual(parseAction(null).error, undefined)
  assert.notEqual(parseAction({}).error, undefined)
  const ok = parseAction({ action: 'activateKey', provider: 'temp', keyId: 'k1', alias: ' x ', value: 'v' })
  assert.equal(ok.action, 'activateKey')
  assert.equal(ok.provider, 'temp')
  assert.equal(ok.keyId, 'k1')
})

test('hitValue 兼容宿主凭据的返回形状', () => {
  // 宿主实现返回 { value, source }。
  assert.equal(hitValue({ value: 'sk-1', source: 'file' }), 'sk-1')
  assert.equal(hitValue('sk-2'), 'sk-2')
  assert.equal(hitValue({ secret: 'sk-3' }), 'sk-3')
  // 空串与缺失都按"没有值"处理。
  assert.equal(hitValue({ value: '' }), undefined)
  assert.equal(hitValue(undefined), undefined)
  assert.equal(hitValue(null), undefined)
})

test('redactSecret 把错误消息里的密钥明文抹掉', () => {
  assert.equal(redactSecret('key sk-abc is invalid', 'sk-abc'), 'key *** is invalid')
  assert.equal(redactSecret('sk-abc sk-abc', 'sk-abc'), '*** ***')
  // 没有密钥或消息为空时不改变内容。
  assert.equal(redactSecret('no secret here', ''), 'no secret here')
  assert.equal(redactSecret(undefined, 'sk-abc'), '')
})

test('mergeRequestCounts 保留内存计数,轮换配置仍以磁盘为准', () => {
  const memory = { p1: { requestCount: 12 }, p2: { requestCount: 3 } }
  const fresh = normalizeState({
    providers: {
      p1: { keyRef: 'P1_KEY', requestCount: 0, rotation: { mode: 'calls', requests: 50 } },
      p2: { keyRef: 'P2_KEY', requestCount: 9 },
    },
  })
  const merged = mergeRequestCounts(memory, fresh.providers)
  // 内存计数更大:保留内存值(否则定时同步会把计数清零,按次数轮换永远触发不了)。
  assert.equal(merged.p1.requestCount, 12)
  // 磁盘计数更大:以磁盘为准。
  assert.equal(merged.p2.requestCount, 9)
  // 轮换配置只认磁盘。
  assert.equal(merged.p1.rotation.mode, 'calls')
  assert.equal(merged.p1.rotation.requests, 50)
})

test('isSelectable 跳过值已缺失的密钥', async () => {
  const { isSelectable } = await import('./core.js')
  const now = 1_000_000
  assert.equal(isSelectable({ health: 'ok', valueMissing: true }, now), false)
  assert.equal(isSelectable({ health: 'ok', valueMissing: false }, now), true)
})
