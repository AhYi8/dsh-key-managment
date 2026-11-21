/**
 * index.js 编排层的单测(node --test)。
 *
 * 为什么需要它:core.js 是纯逻辑,测起来轻松;但真正会出 bug 的地方
 * 在编排层——"定时同步整体替换 state.providers"让跨 await 持有的
 * record/key 引用变成孤儿,写在上面的字段随落盘丢失。本文件用一套
 * mock 宿主(ctx)把插件跑起来,验证写回落在活对象上。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './index.js'

/**
 * 插件的状态文件路径取自 DSH_PROFILE_DIR / DSH_HOME,默认会落到真实
 * profile 目录——测试若直接跑,会用 mock 的凭据把真实状态文件冲掉
 * (曾把 62 把密钥的 health 全写成 invalid)。因此每个用例先切到临时目录。
 *
 * 临时目录由用例自己创建,只含测试产物,结束后按回收站语义清理。
 */
async function withTempProfile(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-key-test-'))
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = dir
  const disposers = []
  try {
    return await fn(dir, disposers)
  } finally {
    // 插件注册了定时器与监听器:不清理的话进程不会退出,
    // 定时器还会往临时目录里写文件,导致目录删不掉。
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* 尽力清理 */ }
    }
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
    // 定时器可能刚写完文件,重试几次再放弃。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true })
        break
      } catch {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
  }
}

/**
 * 造一套最小可用的宿主 ctx。
 * 插件用到:credentials / llm / webServer / settings / effect / inject / on。
 */
function mockCtx(disposers) {
  const credentials = new Map()
  const warnings = []
  /** llm/stream 的处理器:测试里手动触发瀑布的第二段。 */
  const handlers = new Map()
  const ctx = {
    credentials: {
      async resolve(ref) {
        return credentials.has(ref) ? { value: credentials.get(ref), source: 'file' } : undefined
      },
      async set(ref, value) { credentials.set(ref, value) },
      async unset(ref) { credentials.delete(ref) },
    },
    llm: {
      async listConfigurableProviders() { return [] },
    },
    webServer: { register() { /* 宿主 API 路由 */ } },
    settings: { describe() { return [] } },
    configEditor: undefined,
    /** effect:执行回调并登记清理函数(插件用它注册定时器与监听器)。 */
    effect(fn) {
      const dispose = fn()
      disposers.push(() => { if (typeof dispose === 'function') dispose() })
      return () => { if (typeof dispose === 'function') dispose() }
    },
    /** inject:插件用它取 settings/configEditor,这里直接回调一次。 */
    inject(names, callback) {
      return callback({ settings: ctx.settings, configEditor: undefined })
    },
    /** on:捕获 llm/stream 处理器,供兜底用例手动驱动瀑布。 */
    on(event, handler) {
      handlers.set(event, handler)
      return () => { handlers.delete(event) }
    },
    /** 宿主内置日志器:插件必须走 ctx.logger,不能直接取 ctx.warn。 */
    logger: {
      warn(message) { warnings.push(message) },
    },
  }
  // 复刻宿主真实行为:读取未声明的 ctx 属性会直接抛错。
  // 保留这个陷阱,防止再写出 ctx.warn?.(...) 这类"可选链挡不住 getter"的代码。
  Object.defineProperty(ctx, 'warn', {
    get() { throw new Error('cannot get property "warn" without inject') },
  })
  return { ctx, credentials, warnings, handlers }
}

/**
 * 启动插件并返回一个可直接调用的 API 函数。
 * 插件把 HTTP 路由注册在 ctx.webServer.register 上,这里捕获其 handler,
 * 再用模拟的 req/res 把 JSON 动作喂进去。
 */
function apiOf(ctx, disposers, config = {}) {
  let handler
  const original = ctx.webServer.register
  ctx.webServer.register = (entry) => { handler = entry.handler }
  // quotaProbe:false —— 后台公平调度不探测,免得测试真的去请求厂商接口。
  // 测试跑在 node --test --test-force-exit 下:探测循环的清理函数会取消
  // 挂起的定时器,这里关掉探测只是避免假凭据打出真实网络请求。
  apply(ctx, { quotaProbe: false, fairProbeIntervalSec: 3600, ...config })
  ctx.webServer.register = original

  return async (body) => {
    let payload
    await handler({
      method: 'POST',
      on(event, cb) {
        if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
        if (event === 'end') cb()
      },
      headers: {},
    }, {
      writeHead() { /* 忽略 */ },
      end(data) { payload = JSON.parse(data) },
    })
    return payload
  }
}

/** 让目录里有一个可纳管的供应商(带 API Key 类型凭据)。 */
function withAdoptableProvider(ctx, credentials) {
  credentials.set('MINIMAX_CN_API_KEY', 'sk-original')
  ctx.llm.listConfigurableProviders = async () => [{
    provider: 'minimax-cn',
    displayName: 'MiniMax CN',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'minimax-cn'],
  }]
  ctx.settings.describe = () => [{
    ns: 'llm-pi-ai',
    value: { providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY' } } },
  }]
}

test('index.js:纳管后可添加密钥,切换后原引用值随之替换', async () => {
  await withTempProfile(async (dir, disposers) => {
    const { ctx, credentials } = mockCtx(disposers)
    withAdoptableProvider(ctx, credentials)
    const api = apiOf(ctx, disposers)

    const adopted = await api({ action: 'adoptProvider', provider: 'minimax-cn' })
    assert.equal(adopted.ok, true)
    assert.equal(adopted.providers.length, 1)
    assert.equal(adopted.providers[0].keyCount, 1)

    const added = await api({ action: 'addKey', provider: 'minimax-cn', value: 'sk-second' })
    assert.equal(added.ok, true)
    assert.equal(added.providers[0].keyCount, 2)

    // 切到第二把:原引用值应被字面替换成新密钥。
    const second = added.providers[0].keys.find(k => k.alias === 'Key_2')
    const switched = await api({ action: 'activateKey', provider: 'minimax-cn', keyId: second.id })
    assert.equal(switched.ok, true)
    assert.equal(credentials.get('MINIMAX_CN_API_KEY'), 'sk-second')
    assert.equal(switched.providers[0].activeKeyId, second.id)
  })
})

test('index.js:probeStatus 返回空闲与队列剩余数(探测关闭时无在探目标)', async () => {
  await withTempProfile(async (dir, disposers) => {
    const { ctx, credentials } = mockCtx(disposers)
    withAdoptableProvider(ctx, credentials)
    // apiOf 默认 quotaProbe:false:后台调度不跑,probeStatus 必然是空闲。
    const api = apiOf(ctx, disposers)
    await api({ action: 'adoptProvider', provider: 'minimax-cn' })
    await api({ action: 'addKey', provider: 'minimax-cn', value: 'sk-second' })

    const status = await api({ action: 'probeStatus' })
    assert.equal(status.ok, true)
    assert.equal(status.probing, null)
    // 队列在启动时按状态文件顺序重建:池内两把 → 剩余 2。
    assert.equal(status.queued, 2)
    // 探测关闭:下一把未排程(空),倒计时基准为 0;now 供客户端抵消时钟偏差。
    assert.equal(status.next, null)
    assert.equal(status.nextAt, 0)
    assert.equal(status.enabled, false)
    assert.equal(typeof status.now, 'number')
  })
})

test('index.js:手动使用后游标同步,轮换从生效密钥的下一把开始', async () => {
  await withTempProfile(async (dir, disposers) => {
    const { ctx, credentials } = mockCtx(disposers)
    withAdoptableProvider(ctx, credentials)
    const api = apiOf(ctx, disposers)

    // 桩掉 fetch:未知健康状态的候选会触发一次余额探测,不能真连 MiniMax;
    // 固定回一个可解析的余额响应,探测结论为 ok,候选保持可选。
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        base_resp: { status_code: 0 },
        model_remains: [{ model_name: 'general', current_interval_remaining_percent: 50 }],
      }),
    })
    try {
      await api({ action: 'adoptProvider', provider: 'minimax-cn' })
      await api({ action: 'addKey', provider: 'minimax-cn', value: 'sk-second' })
      const added = await api({ action: 'addKey', provider: 'minimax-cn', value: 'sk-third' })
      const keys = added.providers[0].keys
      assert.equal(keys.length, 3)

      // 手动使用 Key_3(池尾):游标必须跟上生效密钥。
      const third = keys.find(k => k.alias === 'Key_3')
      const switched = await api({ action: 'activateKey', provider: 'minimax-cn', keyId: third.id })
      assert.equal(switched.ok, true)
      assert.equal(switched.providers[0].activeKeyId, third.id)

      // 立即轮换:应从 Key_3 的下一把(Key_1)开始,而不是从旧游标(Key_2 之后)开始。
      const rotated = await api({ action: 'rotateNow', provider: 'minimax-cn' })
      assert.equal(rotated.ok, true)
      assert.equal(rotated.providers[0].activeKeyId, keys.find(k => k.alias === 'Key_1').id)
      // 再次轮换:按游标顺序推进到 Key_2。
      const rotatedAgain = await api({ action: 'rotateNow', provider: 'minimax-cn' })
      assert.equal(rotatedAgain.ok, true)
      assert.equal(rotatedAgain.providers[0].activeKeyId, keys.find(k => k.alias === 'Key_2').id)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

test('index.js:删除密钥后池子里不再有它', async () => {
  await withTempProfile(async (dir, disposers) => {
    const { ctx, credentials } = mockCtx(disposers)
    withAdoptableProvider(ctx, credentials)
    const api = apiOf(ctx, disposers)

    // 先纳管,再添加第二把:待删的是第二把(第一把是生效中的,不能删)。
    await api({ action: 'adoptProvider', provider: 'minimax-cn' })
    const added = await api({ action: 'addKey', provider: 'minimax-cn', value: 'sk-second' })
    assert.equal(added.ok, true)
    const second = added.providers[0].keys.find(k => k.alias === 'Key_2')
    assert.notEqual(second, undefined)

    const deleted = await api({ action: 'deleteKey', provider: 'minimax-cn', keyId: second.id })
    assert.equal(deleted.ok, true)
    // 池子里只剩一把,被删的那把不在了。
    assert.equal(deleted.providers[0].keyCount, 1)
    assert.equal(deleted.providers[0].keys.some(k => k.id === second.id), false)
  })
})

test('index.js:生效中的密钥不允许删除', async () => {
  await withTempProfile(async (dir, disposers) => {
    const { ctx, credentials } = mockCtx(disposers)
    withAdoptableProvider(ctx, credentials)
    const api = apiOf(ctx, disposers)

    const adopted = await api({ action: 'adoptProvider', provider: 'minimax-cn' })
    const active = adopted.providers[0].keys[0]
    const rejected = await api({ action: 'deleteKey', provider: 'minimax-cn', keyId: active.id })
    // 删除生效中的密钥必须被拒绝:它还在为实际请求服务。
    assert.notEqual(rejected.ok, true)
    assert.match(rejected.error, /生效中的密钥不能删除/)
  })
})

test('index.js:重复的密钥值被拒绝', async () => {
  await withTempProfile(async (dir, disposers) => {
    const { ctx, credentials } = mockCtx(disposers)
    withAdoptableProvider(ctx, credentials)
    const api = apiOf(ctx, disposers)

    await api({ action: 'adoptProvider', provider: 'minimax-cn' })
    // 再加一把与原引用相同的值:应被判定为已在池内。
    const dup = await api({ action: 'addKey', provider: 'minimax-cn', value: 'sk-original' })
    assert.notEqual(dup.ok, true)
    assert.match(dup.error, /已在池内/)
  })
})

test('index.js:测试不会写进真实 profile 目录', async () => {
  // 回归护栏:状态文件路径必须落在临时目录,否则会用 mock 凭据
  // 冲掉真实 profile 里的密钥健康状态。
  const realProfile = process.env.DSH_PROFILE_DIR
  await withTempProfile(async (dir, disposers) => {
    assert.equal(process.env.DSH_PROFILE_DIR, dir)
    assert.notEqual(dir, realProfile)
  })
})

/* ---------------------- 调用失败自动换钥兜底 ---------------------- */

/** 把一串块包成上游迭代器;每次调用模拟一次新的模型请求。 */
function streamOf(chunks) {
  return (async function* () {
    for (const chunk of chunks) yield chunk
  })()
}

/** 构造 DSH 的终止失败块(适配器失败不会被抛出,而是以块下发)。 */
function failureChunk(failure) {
  return { type: 'finish', reason: { kind: 'error', failure } }
}

/** 建一个两把密钥的池子,并把常用句柄交给用例。 */
async function withTwoKeys(fn, config) {
  await withTempProfile(async (dir, disposers) => {
    const { ctx, credentials, warnings, handlers } = mockCtx(disposers)
    withAdoptableProvider(ctx, credentials)
    const api = apiOf(ctx, disposers, config)
    await api({ action: 'adoptProvider', provider: 'minimax-cn' })
    const added = await api({ action: 'addKey', provider: 'minimax-cn', value: 'sk-second' })
    const first = added.providers[0].keys.find(key => key.alias === 'Key_1')
    await fn({ api, credentials, warnings, handlers, first, dir })
  })
}

/** 跑一次 llm/stream 观察者,返回下游看到的块。 */
async function observe(listener, provider, signal, chunks) {
  const seen = []
  for await (const chunk of listener({ provider, signal }, () => streamOf(chunks))) seen.push(chunk)
  return seen
}

/** 恢复点的 next 用哨兵值证明「没有拦下这次失败」。 */
const NEXT = Symbol('next')
async function recoverAt(handler, payload) {
  let nextCalled = 0
  const action = await handler(payload, () => {
    nextCalled += 1
    return Promise.resolve(NEXT)
  })
  return { action, nextCalled }
}

test('index.js:密钥失效在恢复点换钥并要求重试', async () => {
  await withTwoKeys(async ({ api, credentials, warnings, handlers, first }) => {
    const signal = { aborted: false }
    const failure = { code: 'AUTH', message: '401: {"error":{"message":"Incorrect API key provided"}}' }
    // ① llm/stream 只观察:失败块原样透传(cordis 的 next() 单次守卫不允许在这里重放)。
    const seen = await observe(handlers.get('llm/stream'), 'minimax-cn', signal, [failureChunk(failure)])
    assert.deepEqual(seen, [failureChunk(failure)])
    // ② 恢复点:换钥并回答 retry,agent loop 会用新凭据重新 prepareRequest 再派发。
    const { action, nextCalled } = await recoverAt(handlers.get('agent/request-error'),
      { provider: 'minimax-cn', failure, signal, turn: 1, step: 0 })
    assert.deepEqual(action, { kind: 'retry' })
    assert.equal(nextCalled, 0)
    assert.equal(credentials.get('MINIMAX_CN_API_KEY'), 'sk-second')
    // ③ 兜底必须留痕(走 ctx.logger;历史上这里误用 ctx.warn 把整个 turn 打断了)。
    assert.equal(warnings.some(line => line.includes('已自动换到下一把密钥')), true)
    const state = await api({ action: 'getState' })
    assert.equal(state.providers[0].keys.find(key => key.id === first.id).health, 'invalid')
  })
})

test('index.js:额度/欠费失败标 limited 并冷却,不拉黑密钥', async () => {
  await withTwoKeys(async ({ api, credentials, handlers, first }) => {
    const signal = { aborted: false }
    // DashScope 欠费在 DSH 里被归一化成 AUTH:这里验证兜底不会误标 invalid。
    const failure = { code: 'AUTH', message: '403: {"code":"Arrearage","message":"Access denied"}' }
    await observe(handlers.get('llm/stream'), 'minimax-cn', signal, [failureChunk(failure)])
    const { action } = await recoverAt(handlers.get('agent/request-error'),
      { provider: 'minimax-cn', failure, signal })
    assert.deepEqual(action, { kind: 'retry' })
    assert.equal(credentials.get('MINIMAX_CN_API_KEY'), 'sk-second')
    const state = await api({ action: 'getState' })
    const failed = state.providers[0].keys.find(key => key.id === first.id)
    assert.equal(failed.health, 'limited')
    assert.equal(failed.limited, true)
    assert.ok(failed.cooldownUntil > Date.now())
  })
})

test('index.js:已经产出内容后失败不重试', async () => {
  await withTwoKeys(async ({ credentials, handlers }) => {
    const signal = { aborted: false }
    const failure = { code: 'AUTH', message: '401 Incorrect API key' }
    const seen = await observe(handlers.get('llm/stream'), 'minimax-cn', signal, [
      { type: 'text-delta', index: 0, text: 'partial' },
      failureChunk(failure),
    ])
    assert.deepEqual(seen.map(chunk => chunk.type), ['text-delta', 'finish'])
    const { action, nextCalled } = await recoverAt(handlers.get('agent/request-error'),
      { provider: 'minimax-cn', failure, signal })
    // 重发会让调用方看到重复文本,所以放行原失败。
    assert.equal(action, NEXT)
    assert.equal(nextCalled, 1)
    assert.equal(credentials.get('MINIMAX_CN_API_KEY'), 'sk-original')
  })
})

test('index.js:池内没有可换的密钥时放行原失败', async () => {
  await withTempProfile(async (dir, disposers) => {
    const { ctx, credentials, handlers } = mockCtx(disposers)
    withAdoptableProvider(ctx, credentials)
    const api = apiOf(ctx, disposers)
    await api({ action: 'adoptProvider', provider: 'minimax-cn' })
    const signal = { aborted: false }
    const failure = { code: 'AUTH', message: '401 Incorrect API key' }
    await observe(handlers.get('llm/stream'), 'minimax-cn', signal, [failureChunk(failure)])
    const { action, nextCalled } = await recoverAt(handlers.get('agent/request-error'),
      { provider: 'minimax-cn', failure, signal })
    assert.equal(action, NEXT)
    assert.equal(nextCalled, 1)
    const state = await api({ action: 'getState' })
    // 单钥池:标记之后确实没有可选钥,不能虚空轮换。
    assert.equal(state.providers[0].keys[0].health, 'invalid')
  })
})

test('index.js:关闭兜底后不重试、不改健康状态', async () => {
  await withTwoKeys(async ({ api, credentials, handlers }) => {
    const signal = { aborted: false }
    const failure = { code: 'AUTH', message: '401 Incorrect API key' }
    await observe(handlers.get('llm/stream'), 'minimax-cn', signal, [failureChunk(failure)])
    const { action, nextCalled } = await recoverAt(handlers.get('agent/request-error'),
      { provider: 'minimax-cn', failure, signal })
    assert.equal(action, NEXT)
    assert.equal(nextCalled, 1)
    assert.equal(credentials.get('MINIMAX_CN_API_KEY'), 'sk-original')
    const state = await api({ action: 'getState' })
    assert.equal(state.providers[0].keys.every(key => key.health !== 'invalid'), true)
  }, { fallbackOnFailure: false })
})

test('index.js:调用已中断时不重试', async () => {
  await withTwoKeys(async ({ credentials, handlers }) => {
    const signal = { aborted: true }
    const failure = { code: 'AUTH', message: '401 Incorrect API key' }
    await observe(handlers.get('llm/stream'), 'minimax-cn', signal, [failureChunk(failure)])
    const { action } = await recoverAt(handlers.get('agent/request-error'),
      { provider: 'minimax-cn', failure, signal })
    assert.equal(action, NEXT)
    assert.equal(credentials.get('MINIMAX_CN_API_KEY'), 'sk-original')
  })
})

test('index.js:兜底重发不重复计入调用次数', async () => {
  await withTwoKeys(async ({ api, handlers }) => {
    const listener = handlers.get('llm/stream')
    const signal = { aborted: false }
    const success = [{ type: 'finish', reason: { kind: 'stop' } }]
    await observe(listener, 'minimax-cn', signal, success)
    let state = await api({ action: 'getState' })
    assert.equal(state.providers[0].requestCount, 1)
    // 失败一次(计数 +1),恢复点换钥会把计数清零。
    const failure = { code: 'AUTH', message: '401 Incorrect API key' }
    await observe(listener, 'minimax-cn', signal, [failureChunk(failure)])
    const { action } = await recoverAt(handlers.get('agent/request-error'),
      { provider: 'minimax-cn', failure, signal })
    assert.deepEqual(action, { kind: 'retry' })
    state = await api({ action: 'getState' })
    assert.equal(state.providers[0].requestCount, 0)
    // 同一 signal 上的兜底重发不再计数。
    await observe(listener, 'minimax-cn', signal, success)
    state = await api({ action: 'getState' })
    assert.equal(state.providers[0].requestCount, 0)
    // 同一 signal 上的下一次普通请求恢复计数。
    await observe(listener, 'minimax-cn', signal, success)
    state = await api({ action: 'getState' })
    assert.equal(state.providers[0].requestCount, 1)
  })
})

test('index.js:外部改过生效密钥时不做兜底', async () => {
  // 请求途中用户可能在设置页把密钥改了:这时 activeKeyId 与实际在用的值对不上,
  // 按 activeKeyId 标记会把失败记到没参与请求的密钥头上,只能放弃兜底。
  await withTwoKeys(async ({ credentials, handlers, first, api }) => {
    credentials.set('MINIMAX_CN_API_KEY', 'sk-typed-by-user')
    const signal = { aborted: false }
    const failure = { code: 'AUTH', message: '401 Incorrect API key' }
    await observe(handlers.get('llm/stream'), 'minimax-cn', signal, [failureChunk(failure)])
    const { action, nextCalled } = await recoverAt(handlers.get('agent/request-error'),
      { provider: 'minimax-cn', failure, signal })
    assert.equal(action, NEXT)
    assert.equal(nextCalled, 1)
    const state = await api({ action: 'getState' })
    const failed = state.providers[0].keys.find(key => key.id === first.id)
    // 没有证据表明是这把钥失效,不能动它的健康状态。
    assert.equal(failed.health, 'unknown')
  })
})

test('index.js:未纳管的供应商不参与兜底', async () => {
  await withTwoKeys(async ({ handlers }) => {
    const signal = { aborted: false }
    const seen = await observe(handlers.get('llm/stream'), 'not-managed', signal,
      [failureChunk({ code: 'AUTH', message: '401 Incorrect API key' })])
    assert.equal(seen.length, 1)
    const { action, nextCalled } = await recoverAt(handlers.get('agent/request-error'),
      { provider: 'not-managed', failure: { code: 'AUTH' }, signal })
    assert.equal(action, NEXT)
    assert.equal(nextCalled, 1)
  })
})

test('index.js:恢复点没有对应请求快照时直接放行', async () => {
  await withTwoKeys(async ({ handlers }) => {
    const { action, nextCalled } = await recoverAt(handlers.get('agent/request-error'),
      { provider: 'minimax-cn', failure: { code: 'AUTH' }, signal: { aborted: false } })
    assert.equal(action, NEXT)
    assert.equal(nextCalled, 1)
  })
})

test('index.js:pi-ai 的 usage 元数据块不影响兜底判定', async () => {
  // 回归护栏:pi-ai 适配器在 error 事件时固定先发 usage 再发失败 finish。
  // 曾经把 usage 当"已产出内容",导致除 DeepSeek 官方外的供应商兜底永不触发。
  await withTwoKeys(async ({ api, credentials, handlers, first }) => {
    const signal = { aborted: false }
    const failure = { code: 'AUTH', message: '401: {"error":{"message":"Incorrect API key provided"}}' }
    await observe(handlers.get('llm/stream'), 'minimax-cn', signal, [
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
      failureChunk(failure),
    ])
    const { action } = await recoverAt(handlers.get('agent/request-error'),
      { provider: 'minimax-cn', failure, signal })
    assert.deepEqual(action, { kind: 'retry' })
    assert.equal(credentials.get('MINIMAX_CN_API_KEY'), 'sk-second')
    const state = await api({ action: 'getState' })
    assert.equal(state.providers[0].keys.find(key => key.id === first.id).health, 'invalid')
  })
})

test('index.js:403 权限类失败不换钥也不拉黑密钥', async () => {
  // Anthropic 的 permission_error 表示"这把钥无权使用该模型",与钥是否有效无关。
  // 曾经会把它判成 invalid,一次权限 403 就能逐把打空整池。
  await withTwoKeys(async ({ api, credentials, handlers, first }) => {
    const signal = { aborted: false }
    const failure = {
      code: 'AUTH',
      message: '403: {"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use the specified model"}}',
    }
    await observe(handlers.get('llm/stream'), 'minimax-cn', signal, [failureChunk(failure)])
    const { action, nextCalled } = await recoverAt(handlers.get('agent/request-error'),
      { provider: 'minimax-cn', failure, signal })
    assert.equal(action, NEXT)
    assert.equal(nextCalled, 1)
    assert.equal(credentials.get('MINIMAX_CN_API_KEY'), 'sk-original')
    const state = await api({ action: 'getState' })
    assert.equal(state.providers[0].keys.find(key => key.id === first.id).health, 'unknown')
  })
})

test('index.js:同一 turn 的额度失败只换一次钥', async () => {
  // 额度是账户级状态:同 turn 连续两把都欠费时,继续逐把试只是放大请求量。
  // 用三把钥,才能把「按 turn 收敛」与「池子恰好耗尽」区分开。
  await withTwoKeys(async ({ api, credentials, handlers }) => {
    await api({ action: 'addKey', provider: 'minimax-cn', value: 'sk-third' })
    const signal = { aborted: false }
    const failure = { code: 'QUOTA', message: '402: Insufficient Balance' }
    await observe(handlers.get('llm/stream'), 'minimax-cn', signal, [failureChunk(failure)])
    const firstAttempt = await recoverAt(handlers.get('agent/request-error'),
      { provider: 'minimax-cn', failure, signal })
    assert.deepEqual(firstAttempt.action, { kind: 'retry' })
    assert.equal(credentials.get('MINIMAX_CN_API_KEY'), 'sk-second')
    // 重发又因欠费失败:这次应按 turn 上限放行,不再换第三把。
    await observe(handlers.get('llm/stream'), 'minimax-cn', signal, [
      { type: 'usage', usage: {} },
      failureChunk(failure),
    ])
    const secondAttempt = await recoverAt(handlers.get('agent/request-error'),
      { provider: 'minimax-cn', failure, signal })
    assert.equal(secondAttempt.action, NEXT)
    assert.equal(secondAttempt.nextCalled, 1)
    assert.equal(credentials.get('MINIMAX_CN_API_KEY'), 'sk-second')
    const state = await api({ action: 'getState' })
    const third = state.providers[0].keys.find(key => key.alias === 'Key_3')
    assert.equal(third.health, 'unknown')
  })
})

test('index.js:并发请求撞同一把密钥只换一次', async () => {
  await withTwoKeys(async ({ api, credentials, handlers, first }) => {
    const failure = { code: 'AUTH', message: '401 Incorrect API key' }
    const signalA = { aborted: false }
    const signalB = { aborted: false }
    await observe(handlers.get('llm/stream'), 'minimax-cn', signalA, [failureChunk(failure)])
    await observe(handlers.get('llm/stream'), 'minimax-cn', signalB, [failureChunk(failure)])
    const [a, b] = await Promise.all([
      recoverAt(handlers.get('agent/request-error'), { provider: 'minimax-cn', failure, signal: signalA }),
      recoverAt(handlers.get('agent/request-error'), { provider: 'minimax-cn', failure, signal: signalB }),
    ])
    // 两个请求都允许重发,但池子只往前走了把,没有连跳两把。
    assert.deepEqual(a.action, { kind: 'retry' })
    assert.deepEqual(b.action, { kind: 'retry' })
    assert.equal(credentials.get('MINIMAX_CN_API_KEY'), 'sk-second')
    const state = await api({ action: 'getState' })
    const keys = state.providers[0].keys
    assert.equal(keys.find(key => key.id === first.id).health, 'invalid')
    assert.equal(keys.find(key => key.id !== first.id).health, 'unknown')
  })
})
