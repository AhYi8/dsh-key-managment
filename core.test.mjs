/** core.js 的单测,使用 Node 内置 test runner(node --test)。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyStreamFailure,
  digestOf,
  findKeyByDigest,
  healthFromQuota,
  hitValue,
  isFallbackFailureChunk,
  isStreamContentChunk,
  mergeRuntimeState,
  newProviderRecord,
  nextAlias,
  normalizeState,
  parseAction,
  probeRoundDelay,
  projectProvider,
  QUOTA_COOLDOWN_MS,
  redactSecret,
  settleKeyHealth,
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

test('healthFromQuota:账号无 coding 套餐 → 限流一天', async () => {
  const { healthFromQuota, NO_PLAN_COOLDOWN_MS } = await import('./core.js')
  const now = 1_000_000
  // 智谱实机措辞:账号没订阅 coding 套餐。订阅前这把密钥必然不可用,
  // 按"限流一天"冷却,而不是永远停在未知。
  const verdict = healthFromQuota(
    { status: 'error', error: { kind: 'parse', message: 'API error: 当前用户不存在 coding plan' } },
    'unknown', 0, now)
  assert.equal(verdict.health, 'limited')
  assert.equal(verdict.cooldownUntil, now + NO_PLAN_COOLDOWN_MS)
  // 其它 coding plan 供应商的英文措辞同样覆盖。
  assert.equal(healthFromQuota(
    { status: 'error', error: { kind: 'http', message: 'no coding plan for this user' } },
    'unknown', 0, now).health, 'limited')
  // 冷却到期后的下一轮探测重新判定,不因级别残留而延长。
  const again = healthFromQuota(
    { status: 'error', error: { kind: 'parse', message: '当前用户不存在 coding plan' } },
    'limited', 5, now, now + NO_PLAN_COOLDOWN_MS)
  assert.equal(again.health, 'limited')
  assert.equal(again.cooldownUntil, now + NO_PLAN_COOLDOWN_MS)
  assert.equal(again.level, 0)
  // MiniMax 的两种无套餐/无资格措辞:直接文案,与会话 cookie 缺失。
  for (const message of ['no active token plan subscription', 'cookie is missing, log in again']) {
    const minimax = healthFromQuota(
      { status: 'error', error: { kind: 'parse', message } },
      'unknown', 0, now)
    assert.equal(minimax.health, 'limited')
    assert.equal(minimax.cooldownUntil, now + NO_PLAN_COOLDOWN_MS)
  }
})

test('healthFromQuota:余额型窗口按官方可用性与余额判定', async () => {
  const { healthFromQuota } = await import('./core.js')
  const now = 1_000_000
  // 余额充足 → 有效。
  assert.equal(healthFromQuota(
    { status: 'ok', windows: [{ tier: 'balance', remainingValue: 12.34, available: true }] },
    'ok', 0, now).health, 'ok')
  // 余额 0 → 限流,固定 10 分钟冷却(余额窗口没有重置时间)。
  const empty = healthFromQuota(
    { status: 'ok', windows: [{ tier: 'balance', remainingValue: 0, available: false }] },
    'ok', 0, now)
  assert.equal(empty.health, 'limited')
  assert.equal(empty.cooldownUntil, now + 600_000)
  // 透支余额是负数,同样不可用。
  assert.equal(healthFromQuota(
    { status: 'ok', windows: [{ tier: 'balance', remainingValue: -0.01, available: false }] },
    'ok', 0, now).health, 'limited')
  // 官方 is_available=false 是权威判断:即使余额为正也不可用。
  assert.equal(healthFromQuota(
    { status: 'ok', windows: [{ tier: 'balance', remainingValue: 5, available: false }] },
    'ok', 0, now).health, 'limited')
  // 旧快照没有 available 字段:仍然按余额判定,不能因为缺字段就放行。
  assert.equal(healthFromQuota(
    { status: 'ok', windows: [{ tier: 'balance', remainingValue: 0 }] },
    'ok', 0, now).health, 'limited')
  assert.equal(healthFromQuota(
    { status: 'ok', windows: [{ tier: 'balance', remainingValue: 3 }] },
    'ok', 0, now).health, 'ok')
  // 百分比窗口即使意外带 available 字段,也不能被当成余额窗口。
  assert.equal(healthFromQuota(
    { status: 'ok', windows: [{ tier: 'five_hour', usedPercent: 50, available: false }] },
    'ok', 0, now).health, 'ok')
})

test('healthFromQuota:探测失败时保留原冷却时间与退避级别', async () => {
  const { healthFromQuota } = await import('./core.js')
  const now = 1_000_000
  // 限流中的密钥遇到一次网络抖动:健康状态与冷却截止时间都应原样保留,
  // 否则一次探测失败就把仍在冷却中的密钥立刻放回可选池,退避形同虚设。
  for (const kind of ['parse', 'network']) {
    const kept = healthFromQuota(
      { status: 'error', error: { kind, message: 'boom' } },
      'limited', 2, now, now + 300_000)
    assert.equal(kept.health, 'limited')
    assert.equal(kept.cooldownUntil, now + 300_000)
    assert.equal(kept.level, 2)
  }
  // payload 为空同样保持原状。
  const empty = healthFromQuota(undefined, 'limited', 2, now, now + 300_000)
  assert.equal(empty.health, 'limited')
  assert.equal(empty.cooldownUntil, now + 300_000)
  // 不传冷却参数时默认 0(向后兼容旧调用)。
  assert.equal(healthFromQuota(undefined, 'limited', 2, now).cooldownUntil, 0)
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

test('mergeRuntimeState 保留内存计数与健康判定,轮换配置仍以磁盘为准', () => {
  // 内存里给一个与磁盘冲突的轮换配置,验证合并后确实以磁盘为准。
  const memory = {
    p1: { requestCount: 12, rotation: { mode: 'off', intervalMs: 60_000, requests: 999 } },
    p2: { requestCount: 3 },
  }
  const fresh = normalizeState({
    providers: {
      p1: { keyRef: 'P1_KEY', requestCount: 0, rotation: { mode: 'calls', requests: 50 } },
      p2: { keyRef: 'P2_KEY', requestCount: 9 },
    },
  })
  const merged = mergeRuntimeState(memory, fresh.providers)
  // 内存计数更大:保留内存值(否则定时同步会把计数清零,按次数轮换永远触发不了)。
  assert.equal(merged.p1.requestCount, 12)
  // 磁盘计数更大:以磁盘为准。
  assert.equal(merged.p2.requestCount, 9)
  // 轮换配置只认磁盘:内存给的是 mode:'off',磁盘是 'calls',合并后必须是磁盘的。
  assert.equal(merged.p1.rotation.mode, 'calls')
  assert.equal(merged.p1.rotation.requests, 50)
})

test('mergeRuntimeState 保留内存里的健康判定,不被磁盘旧快照覆盖', () => {
  // 磁盘上是上一轮的快照(键还判为有效),内存里是本轮探测出的限流结论。
  const memory = {
    p1: {
      keys: [
        { id: 'k1', health: 'limited', cooldownUntil: 999, cooldownLevel: 3 },
        { id: 'k2', health: 'unknown', cooldownUntil: 0, cooldownLevel: 0 },
      ],
    },
  }
  const fresh = normalizeState({
    providers: {
      p1: {
        keyRef: 'P1_KEY',
        keys: [
          { id: 'k1', ref: 'R1', health: 'ok', cooldownUntil: 0 },
          { id: 'k2', ref: 'R2', health: 'limited', cooldownUntil: 555 },
        ],
      },
    },
  })
  const merged = mergeRuntimeState(memory, fresh.providers)
  // 内存给出了明确结论 → 覆盖磁盘旧快照(否则"额度已用尽"会被判回有效)。
  assert.equal(merged.p1.keys[0].health, 'limited')
  assert.equal(merged.p1.keys[0].cooldownUntil, 999)
  // 退避级别也要带过去:否则连续限流的惩罚会在每次同步后从头开始。
  assert.equal(merged.p1.keys[0].cooldownLevel, 3)
  // 内存仍是 unknown(尚未探测)→ 不覆盖磁盘上已有的结论。
  assert.equal(merged.p1.keys[1].health, 'limited')
  assert.equal(merged.p1.keys[1].cooldownUntil, 555)
})

test('mergeRuntimeState 内存判为有效时覆盖磁盘上的限流旧值', () => {
  // 额度已恢复(内存 ok),磁盘上还是上一轮的 limited。
  // 合并必须让内存的 ok 生效,否则一次"额度恢复"的结论会被
  // 下次定时同步打回限流,密钥再也回不到可选池。
  const memory = {
    p1: { keys: [{ id: 'k1', health: 'ok', cooldownUntil: 0, cooldownLevel: 0 }] },
  }
  const fresh = normalizeState({
    providers: {
      p1: { keyRef: 'P1_KEY', keys: [{ id: 'k1', ref: 'R1', health: 'limited', cooldownUntil: 999 }] },
    },
  })
  const merged = mergeRuntimeState(memory, fresh.providers)
  assert.equal(merged.p1.keys[0].health, 'ok')
  assert.equal(merged.p1.keys[0].cooldownUntil, 0)
})

test('mergeRuntimeState 内存密钥 id 与磁盘对不上时不覆盖磁盘结论', () => {
  const memory = { p1: { keys: [{ id: 'kX', health: 'limited', cooldownUntil: 999, cooldownLevel: 1 }] } }
  const fresh = normalizeState({
    providers: { p1: { keyRef: 'P1_KEY', keys: [{ id: 'k1', ref: 'R1', health: 'ok' }] } },
  })
  const merged = mergeRuntimeState(memory, fresh.providers)
  // id 匹配不上 → 不覆盖磁盘结论,也不凭空多出密钥。
  assert.equal(merged.p1.keys.length, 1)
  assert.equal(merged.p1.keys[0].id, 'k1')
  assert.equal(merged.p1.keys[0].health, 'ok')
})

test('mergeRuntimeState 保留磁盘上没有的供应商(刚纳管未落盘)', () => {
  // p2 只存在于内存里:刚纳管、还没落盘。同步不能把它丢掉——
  // 凭据已写进凭据库,丢了就留下一把无主明文密钥,池子也会凭空消失。
  const memory = {
    p1: { requestCount: 5, keys: [{ id: 'k1', health: 'limited', cooldownUntil: 999 }] },
    p2: { requestCount: 0, keys: [{ id: 'k2', health: 'ok', cooldownUntil: 0 }] },
  }
  const fresh = normalizeState({
    providers: { p1: { keyRef: 'P1_KEY', keys: [{ id: 'k1', ref: 'R1', health: 'limited', cooldownUntil: 999 }] } },
  })
  const merged = mergeRuntimeState(memory, fresh.providers)
  assert.equal('p2' in merged, true)
  assert.equal(merged.p2.keys.length, 1)
  // 磁盘独有的供应商同样要保留。
  const fresh2 = normalizeState({
    providers: {
      p1: { keyRef: 'P1_KEY', keys: [] },
      p3: { keyRef: 'P3_KEY', keys: [{ id: 'k3', ref: 'R3', health: 'ok' }] },
    },
  })
  const merged2 = mergeRuntimeState({ p1: { requestCount: 0, keys: [] } }, fresh2.providers)
  assert.equal('p3' in merged2, true)
})

test('settleKeyHealth 按 id 写回活对象,不被中途替换的状态引用带偏', async () => {
  const { settleKeyHealth } = await import('./core.js')
  const now = 1_000_000
  const providers = {
    p1: {
      keys: [
        { id: 'k1', alias: 'Key_1', ref: 'R1', health: 'ok', cooldownUntil: 0, cooldownLevel: 0 },
      ],
    },
  }
  // 额度用尽的窗口 → 限流,冷却到窗口重置时间。
  const settled = settleKeyHealth(
    providers, 'p1', 'k1',
    { status: 'ok', windows: [{ usedPercent: 100, resetAt: now + 300_000 }] },
    now)
  assert.equal(settled.changed, true)
  assert.equal(settled.health, 'limited')
  assert.equal(providers.p1.keys[0].health, 'limited')
  assert.equal(providers.p1.keys[0].cooldownUntil, now + 300_000)

  // 结论不变时不报变更(避免无意义的落盘)。
  const again = settleKeyHealth(
    providers, 'p1', 'k1',
    { status: 'ok', windows: [{ usedPercent: 100, resetAt: now + 300_000 }] },
    now)
  assert.equal(again.changed, false)

  // 未知密钥 id 不报错、不改动任何状态。
  const missing = settleKeyHealth(providers, 'p1', 'nope', { status: 'ok', windows: [] }, now)
  assert.equal(missing.changed, false)
})

test('settleKeyHealth 探测失败时不清掉限流冷却', async () => {
  const { settleKeyHealth } = await import('./core.js')
  const now = 1_000_000
  const providers = {
    p1: {
      keys: [{ id: 'k1', ref: 'R1', health: 'limited', cooldownUntil: now + 300_000, cooldownLevel: 2 }],
    },
  }
  // 网络抖动不该把仍在冷却中的密钥放回可选池。
  const settled = settleKeyHealth(
    providers, 'p1', 'k1',
    { status: 'error', error: { kind: 'network', message: 'timeout' } }, now)
  assert.equal(settled.changed, false)
  assert.equal(settled.health, 'limited')
  assert.equal(providers.p1.keys[0].cooldownUntil, now + 300_000)
  assert.equal(providers.p1.keys[0].cooldownLevel, 2)
})

test('settleKeyHealth 退避级别变化时也判定为变更', async () => {
  const { settleKeyHealth } = await import('./core.js')
  const now = 1_000_000
  // 连续限流:级别从 2 升到 3。冷却时长随之变长,早退条件必须把
  // cooldownLevel 也算进去,否则"仅级别变化"的结论会被静默丢弃。
  const providers = {
    p1: {
      keys: [{ id: 'k1', ref: 'R1', health: 'limited', cooldownUntil: now + 240_000, cooldownLevel: 2 }],
    },
  }
  const settled = settleKeyHealth(
    providers, 'p1', 'k1',
    { status: 'error', error: { kind: 'rate', message: '429' } }, now)
  assert.equal(settled.changed, true)
  assert.equal(providers.p1.keys[0].cooldownLevel, 3)
})

test('settleKeyHealth 冷却封顶后仅退避级别变化也判定为变更', async () => {
  const { settleKeyHealth } = await import('./core.js')
  const now = 1_000_000
  // 冷却已封顶(60s × 2^9 = 30.7 分钟 > 30 分钟上限,两次都是 30 分钟),
  // 只有退避级别在涨(9 → 10)。这才能隔离出"只比 health 与 cooldownUntil"
  // 的实现漏洞——前一个用例里冷却时长也在变,比不比 cooldownLevel 都能判出变更。
  const providers = {
    p1: {
      keys: [{ id: 'k1', ref: 'R1', health: 'limited', cooldownUntil: now + 30 * 60_000, cooldownLevel: 9 }],
    },
  }
  const settled = settleKeyHealth(
    providers, 'p1', 'k1',
    { status: 'error', error: { kind: 'rate', message: '429' } }, now)
  assert.equal(settled.changed, true)
  assert.equal(providers.p1.keys[0].cooldownLevel, 10)
  // 冷却时长封顶不变。
  assert.equal(providers.p1.keys[0].cooldownUntil, now + 30 * 60_000)
})

test('连续限流按指数退避累加级别,冷却时长同步翻倍', async () => {
  const { settleKeyHealth } = await import('./core.js')
  const now = 1_000_000
  const providers = {
    p1: {
      keys: [{ id: 'k1', ref: 'R1', health: 'unknown', cooldownUntil: 0, cooldownLevel: 0 }],
    },
  }
  const rate = { status: 'error', error: { kind: 'rate', message: '429' } }
  settleKeyHealth(providers, 'p1', 'k1', rate, now)
  assert.equal(providers.p1.keys[0].cooldownLevel, 1)
  const firstMs = providers.p1.keys[0].cooldownUntil - now
  settleKeyHealth(providers, 'p1', 'k1', rate, now)
  assert.equal(providers.p1.keys[0].cooldownLevel, 2)
  assert.equal(providers.p1.keys[0].cooldownUntil - now, firstMs * 2)
  // 级别封顶后冷却不超过 30 分钟。
  const capped = {
    p1: {
      keys: [{ id: 'k1', ref: 'R1', health: 'limited', cooldownUntil: 0, cooldownLevel: 30 }],
    },
  }
  settleKeyHealth(capped, 'p1', 'k1', rate, now)
  assert.equal(capped.p1.keys[0].cooldownUntil - now, 30 * 60_000)
})

test('settleKeyHealth 冷却到期后恢复为有效', async () => {
  const { settleKeyHealth } = await import('./core.js')
  const now = 1_000_000
  const providers = {
    p1: {
      keys: [{ id: 'k1', ref: 'R1', health: 'limited', cooldownUntil: now - 1, cooldownLevel: 2 }],
    },
  }
  const settled = settleKeyHealth(
    providers, 'p1', 'k1',
    { status: 'ok', windows: [{ usedPercent: 40 }] }, now)
  assert.equal(settled.changed, true)
  assert.equal(settled.health, 'ok')
  assert.equal(providers.p1.keys[0].health, 'ok')
  assert.equal(providers.p1.keys[0].cooldownUntil, 0)
  assert.equal(providers.p1.keys[0].cooldownLevel, 0)
})

test('settleKeyHealth 冷却延长时也算状态变化', async () => {
  const { settleKeyHealth } = await import('./core.js')
  const now = 1_000_000
  const providers = {
    p1: {
      keys: [{ id: 'k1', ref: 'R1', health: 'limited', cooldownUntil: now + 60_000, cooldownLevel: 0 }],
    },
  }
  // 健康状态相同、只有冷却时间变了:changed 必须为 true,
  // 否则冷却延长的结论不会落盘。
  const settled = settleKeyHealth(
    providers, 'p1', 'k1',
    { status: 'ok', windows: [{ usedPercent: 100, resetAt: now + 300_000 }] }, now)
  assert.equal(settled.changed, true)
  assert.equal(settled.health, 'limited')
  assert.equal(providers.p1.keys[0].cooldownUntil, now + 300_000)
})

test('settleKeyHealth 供应商或密钥不存在时不报错也不改状态', async () => {
  const { settleKeyHealth } = await import('./core.js')
  const now = 1_000_000
  const empty = { status: 'ok', windows: [] }
  assert.deepEqual(settleKeyHealth({ p1: { keys: [] } }, 'nope', 'k1', empty, now), { changed: false, health: 'unknown' })
  assert.deepEqual(settleKeyHealth(undefined, 'p1', 'k1', empty, now), { changed: false, health: 'unknown' })
  assert.deepEqual(settleKeyHealth({ p1: { keys: 'x' } }, 'p1', 'k1', empty, now), { changed: false, health: 'unknown' })
})

test('settleKeyHealth 在状态被整体替换后仍写到活对象上', async () => {
  const { settleKeyHealth } = await import('./core.js')
  const now = 1_000_000
  // 模拟后台轮:手里拿着探测前取的旧引用,期间定时同步把 providers 换成了新对象。
  const stale = { p1: { keys: [{ id: 'k1', ref: 'R1', health: 'ok', cooldownUntil: 0, cooldownLevel: 0 }] } }
  const live = { p1: { keys: [{ id: 'k1', ref: 'R1', health: 'ok', cooldownUntil: 0, cooldownLevel: 0 }] } }
  const settled = settleKeyHealth(
    live, 'p1', 'k1',
    { status: 'ok', windows: [{ usedPercent: 100, resetAt: now + 300_000 }] },
    now)
  assert.equal(settled.changed, true)
  // 结论必须落在替换后的新对象上——旧对象上的写入会随落盘丢失。
  assert.equal(live.p1.keys[0].health, 'limited')
  assert.equal(live.p1.keys[0].cooldownUntil, now + 300_000)
  // 旧引用没被写:它已成孤儿,写上去也落不了盘。
  assert.equal(stale.p1.keys[0].health, 'ok')
})

test('回归:探测结论经定时同步整体替换 providers 后仍保留', async () => {
  const { mergeRuntimeState, normalizeState, settleKeyHealth } = await import('./core.js')
  const now = 1_000_000
  const state = {
    providers: {
      p1: { keyRef: 'P1_KEY', keys: [{ id: 'k1', ref: 'R1', health: 'ok', cooldownUntil: 0, cooldownLevel: 0 }] },
    },
  }
  // ① 后台探测:额度用尽 → 限流。
  const settled = settleKeyHealth(state.providers, 'p1', 'k1',
    { status: 'ok', windows: [{ usedPercent: 100, resetAt: now + 300_000 }] }, now)
  assert.equal(settled.changed, true)
  // ② 定时同步:以磁盘为准整体替换 providers(磁盘快照仍是旧结论)。
  const fresh = normalizeState({
    providers: { p1: { keyRef: 'P1_KEY', keys: [{ id: 'k1', ref: 'R1', health: 'ok', cooldownUntil: 0 }] } },
  })
  state.providers = mergeRuntimeState(state.providers, fresh.providers)
  // ③ 结论必须还在——否则就是"额度已用尽,状态却一直不变"。
  assert.equal(state.providers.p1.keys[0].health, 'limited')
  assert.equal(state.providers.p1.keys[0].cooldownUntil, now + 300_000)
})

test('settleKeyHealth 按 id 命中,不会写到池里的第一把密钥', async () => {
  const { settleKeyHealth } = await import('./core.js')
  const now = 1_000_000
  const providers = {
    p1: {
      keys: [
        { id: 'k1', ref: 'R1', health: 'ok', cooldownUntil: 0, cooldownLevel: 0 },
        { id: 'k2', ref: 'R2', health: 'ok', cooldownUntil: 0, cooldownLevel: 0 },
      ],
    },
  }
  const settled = settleKeyHealth(providers, 'p1', 'k2',
    { status: 'ok', windows: [{ usedPercent: 100, resetAt: now + 300_000 }] }, now)
  assert.equal(settled.changed, true)
  // 命中的是第二把。
  assert.equal(providers.p1.keys[1].health, 'limited')
  // 第一把不该被动过。
  assert.equal(providers.p1.keys[0].health, 'ok')
})

test('isSelectable 跳过值已缺失的密钥', async () => {
  const { isSelectable } = await import('./core.js')
  const now = 1_000_000
  assert.equal(isSelectable({ health: 'ok', valueMissing: true }, now), false)
  assert.equal(isSelectable({ health: 'ok', valueMissing: false }, now), true)
})

/**
 * 调用失败兜底判定。
 *
 * 这些用例的措辞都来自厂商官方错误码文档:同一类「额度不足」在不同厂商
 * 落在 401/402/403/429 四个不同状态码上,只看归一化码必然漏判或误判。
 */
test('classifyStreamFailure:凭据级失败判 invalid(含厂商原生形态)', () => {
  const cases = [
    // 消息里带状态码的常见形态
    { code: 'AUTH', message: '401: {"error":{"message":"Incorrect API key provided"}}' },
    { code: 'AUTH', message: '401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' },
    { code: 'AUTH', message: '401: {"error":{"code":"1000","message":"身份验证失败"}}' },
    { code: 'AUTH', message: '401: {"code":"InvalidApiKey","message":"Invalid API-key provided."}' },
    // DSH 原生形态:message 只是厂商文案,没有状态码前缀
    { code: 'AUTH', message: 'Authentication Fails' },
    { code: 'AUTH', message: 'Unauthorized' },
    { code: 'AUTH', message: '认证失败' },
    // 有些厂商把无效密钥报成 400 / 403
    { code: 'INVALID_REQUEST', message: '400: {"error":{"message":"API key not valid. Please pass a valid API key."}}' },
    { code: 'AUTH', message: '403: The API key is disabled' },
    { code: 'AUTH', message: '403: {"error":{"message":"该密钥已被停用"}}' },
    // OpenRouter / DSH 本地判定的独立码
    { code: 'PI_AI_ERROR', message: '401: {"error":{"code":401,"message":"Invalid credentials"}}' },
    { code: 'INVALID_CREDENTIAL', message: '' },
    // 只有 status 没有措辞
    { code: 'PI_AI_ERROR', status: 401, message: 'unauthorized' },
  ]
  for (const failure of cases) {
    assert.equal(classifyStreamFailure(failure).action, 'invalid', JSON.stringify(failure))
  }
})

test('classifyStreamFailure:额度/欠费不论落在哪个状态码都判为额度级', () => {
  const cases = [
    // DeepSeek 官方 402
    { code: 'QUOTA', message: '402: Insufficient Balance' },
    // DashScope 欠费:HTTP 403,DSH 会把它归一化成 AUTH —— 最大的误判陷阱
    { code: 'AUTH', message: '403: {"code":"Arrearage","message":"Access denied, please make sure your account is in good standing."}' },
    // OpenAI 账单类 429:归一化码可能是 RATE_LIMIT
    { code: 'RATE_LIMIT', message: '429: {"error":{"type":"insufficient_quota","code":"insufficient_quota"}}' },
    { code: 'AUTH', message: '429: credit_balance_exhausted' },
    // Kimi 账户欠费:429 + exceeded_current_quota_error,消息语序与英文惯用式相反
    { code: 'RATE_LIMIT', message: '429: {"error":{"type":"exceeded_current_quota_error","message":"Account balance is insufficient"}}' },
    // 智谱 1113:中文欠费,英文正则命中不了
    { code: 'RATE_LIMIT', message: '429: {"error":{"code":"1113","message":"您的账户已欠费,请充值后重试"}}' },
    // OpenRouter 402 / Anthropic 402 billing_error / 400 spend limit / 403 预算耗尽
    { code: 'PI_AI_ERROR', message: '402: {"error":{"metadata":{"error_type":"payment_required"}}}' },
    { code: 'PI_AI_ERROR', message: '402: {"type":"error","error":{"type":"billing_error","message":"Your credit balance is too low"}}' },
    { code: 'INVALID_REQUEST', message: '400: You have reached your spend limit' },
    { code: 'AUTH', message: '403: {"error":{"message":"Key limit exceeded (total budget)"}}' },
    // DSH 的独立额度码与裸 status
    { code: 'ACCOUNT_QUOTA', message: '' },
    { code: 'QUOTA', message: '' },
    { code: 'PI_AI_ERROR', status: 402, message: '' },
  ]
  for (const failure of cases) {
    assert.equal(classifyStreamFailure(failure).action, 'quota', JSON.stringify(failure))
  }
})

test('classifyStreamFailure:账户/策略/权限/基础设施类失败不换钥', () => {
  const cases = [
    // 组织策略
    { code: 'AUTH', message: '401: {"error":{"message":"CORS requests are not allowed for this Organization"}}' },
    { code: 'AUTH', message: '401: {"error":{"message":"You must be a member of an organization to use the API"}}' },
    // 密钥有效但没有该模型/资源的权限:换钥未必有用,更不能标 invalid
    { code: 'AUTH', message: '403: {"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use the specified model"}}' },
    { code: 'AUTH', message: '403: {"error":{"message":"Authentication service unavailable"}}' },
    // 账户被停用属于账户状态,不是这把钥的问题
    { code: 'AUTH', message: '401: Your account has been disabled' },
    // 同时命中认证与账户措辞时按账户处理(排除分支的用例)
    { code: 'AUTH', message: '401: invalid api key for organization acme' },
  ]
  for (const failure of cases) {
    assert.equal(classifyStreamFailure(failure).action, 'none', JSON.stringify(failure))
  }
})

test('classifyStreamFailure:普通限流、上下文与无关错误不动密钥', () => {
  assert.equal(classifyStreamFailure({ code: 'RATE_LIMIT', message: '429 Too Many Requests' }).action, 'none')
  assert.equal(classifyStreamFailure({ code: 'RATE_LIMIT', message: '429: {"error":{"type":"rate_limit_reached_error"}}' }).action, 'none')
  assert.equal(classifyStreamFailure({ code: 'SERVER', message: '503 Service Unavailable' }).action, 'none')
  assert.equal(classifyStreamFailure({ code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context length exceeded' }).action, 'none')
  assert.equal(classifyStreamFailure(undefined).action, 'none')
  assert.equal(classifyStreamFailure(null).action, 'none')
})

test('isStreamContentChunk:usage 与 finish 不算已产出内容', () => {
  // pi-ai 失败流固定先发 usage 再发错误 finish,把 usage 当内容会让兜底失效。
  assert.equal(isStreamContentChunk({ type: 'usage', usage: {} }), false)
  assert.equal(isStreamContentChunk({ type: 'finish', reason: { kind: 'stop' } }), false)
  assert.equal(isStreamContentChunk({ type: 'text-delta', text: 'x' }), true)
  assert.equal(isStreamContentChunk({ type: 'block-start', blockType: 'text' }), true)
  assert.equal(isStreamContentChunk(null), false)
})

test('isFallbackFailureChunk 只认终止失败块', () => {
  assert.equal(isFallbackFailureChunk({ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } }), true)
  assert.equal(isFallbackFailureChunk({ type: 'finish', reason: { kind: 'stop' } }), false)
  assert.equal(isFallbackFailureChunk({ type: 'finish', reason: { kind: 'aborted', failure: {} } }), false)
  assert.equal(isFallbackFailureChunk({ type: 'text-delta', text: 'x' }), false)
  assert.equal(isFallbackFailureChunk(null), false)
  assert.equal(isFallbackFailureChunk({ type: 'finish', reason: null }), false)
})

test('额度冷却常量被余额窗口判定复用', () => {
  // 不再断言常量本身(恒真),而是断言判定结果真的用了它。
  const now = 1_000_000
  const verdict = healthFromQuota({ status: 'ok', windows: [{ tier: 'balance', remainingValue: 0 }] }, 'ok', 0, now)
  assert.equal(verdict.health, 'limited')
  assert.equal(verdict.cooldownUntil, now + QUOTA_COOLDOWN_MS)
})

test('validateProbeConfig 拒绝非布尔的 fallbackOnFailure', () => {
  assert.equal(validateProbeConfig({ fallbackOnFailure: false }), null)
  assert.equal(validateProbeConfig({ fallbackOnFailure: true }), null)
  assert.notEqual(validateProbeConfig({ fallbackOnFailure: 'false' }), null)
})
