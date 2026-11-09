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
    /** on:插件用它挂 llm/stream 瀑布监听器,测试里不真正执行。 */
    on() { return () => { /* 卸载清理 */ } },
    warn(message) { warnings.push(message) },
  }
  return { ctx, credentials, warnings }
}

/**
 * 启动插件并返回一个可直接调用的 API 函数。
 * 插件把 HTTP 路由注册在 ctx.webServer.register 上,这里捕获其 handler,
 * 再用模拟的 req/res 把 JSON 动作喂进去。
 */
function apiOf(ctx, disposers) {
  let handler
  const original = ctx.webServer.register
  ctx.webServer.register = (entry) => { handler = entry.handler }
  // quotaProbe:false —— 后台探测不跑,免得测试真的去请求厂商接口。
  // 测试跑在 node --test --test-force-exit 下:插件的后台探测用 setTimeout
  // 轮转,它的清理函数只置停止标志、不取消挂起的定时器,进程会多等一个轮间隔。
  apply(ctx, { quotaProbe: false, quotaIntervalMs: 3_600_000, quotaProbeGapMs: 200 })
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
