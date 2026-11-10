/**
 * quota/ 适配器的单测(node --test)。
 *
 * 适配器是额度判定的上游:它把厂商响应翻译成统一的窗口数组,
 * 形状猜错就会静默画错图——MiniMax 的"剩余百分比"若忘了取反,
 * 用尽的密钥会报成 0% 已用,症状与"额度用尽却不改状态"完全一致。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { healthFromQuota } from './core.js'
import { deepseekBalanceAdapter } from './quota/adapters/deepseek-balance.js'
import { minimaxAdapter } from './quota/adapters/minimax.js'
import { zhipuAdapter } from './quota/adapters/zhipu.js'

/** 构造一个可控的 fetch:返回指定 JSON,并记录请求参数。 */
function stubFetch(body, { status = 200 } = {}) {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }
  }
  return { fetchFn, calls }
}

/** MiniMax 的一条 general 记录。 */
function generalLane(overrides = {}) {
  return {
    model_name: 'general',
    current_interval_status: 1,
    current_interval_remaining_percent: 82,
    end_time: 1_800_000_000,
    current_weekly_status: 1,
    current_weekly_remaining_percent: 90,
    weekly_end_time: 1_800_000_000,
    ...overrides,
  }
}

test('minimax 适配器把剩余百分比取反成已用百分比', async () => {
  const body = {
    base_resp: { status_code: 0, status_msg: 'success' },
    model_remains: [generalLane()],
  }
  const { fetchFn, calls } = stubFetch(body)
  const result = await minimaxAdapter.query({
    provider: 'minimax-cn',
    baseUrl: 'https://api.minimaxi.com/v1',
    apiKey: 'sk-test',
    fetchFn,
  })
  // 国内站走 api.minimaxi.com。
  assert.equal(calls[0].url, 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains')
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test')
  const fiveHour = result.windows.find(w => w.tier === 'five_hour')
  const weekly = result.windows.find(w => w.tier === 'weekly')
  // 剩余 82% → 已用 18%;剩余 90% → 已用 10%。
  assert.equal(fiveHour.usedPercent, 18)
  assert.equal(weekly.usedPercent, 10)
})

test('minimax 适配器:额度用尽即已用 100%,健康判定为限流', async () => {
  // 真实响应用尽的形状:status 2 + 剩余 0%。
  const body = {
    base_resp: { status_code: 0, status_msg: 'success' },
    model_remains: [generalLane({
      current_interval_status: 2,
      current_interval_remaining_percent: 0,
    })],
  }
  const { fetchFn } = stubFetch(body)
  const result = await minimaxAdapter.query({
    provider: 'minimax-cn',
    baseUrl: 'https://api.minimaxi.com/v1',
    apiKey: 'sk-test',
    fetchFn,
  })
  const fiveHour = result.windows.find(w => w.tier === 'five_hour')
  // 剩余 0% → 已用 100%。这是整个判定的关键一步。
  assert.equal(fiveHour.usedPercent, 100)
  // 端到端:这个形状必须判成限流,否则就是"额度用尽却不改状态"。
  assert.equal(healthFromQuota({ status: 'ok', windows: result.windows }, 'ok', 0, 1_000_000).health, 'limited')
})

test('minimax 适配器:status 3 的占位 lane 不画窗口', async () => {
  const body = {
    base_resp: { status_code: 0, status_msg: 'success' },
    model_remains: [
      // general 的周窗口是占位(status 3 + 100% 剩余)→ 不该画出来,
      // 只剩 5 小时窗口这一个。
      generalLane({
        current_interval_remaining_percent: 50,
        current_weekly_status: 3,
        current_weekly_remaining_percent: 100,
      }),
      // 非 general 的计费口(视频)不参与。
      { model_name: 'video', current_interval_status: 3, current_interval_remaining_percent: 100 },
    ],
  }
  const { fetchFn } = stubFetch(body)
  const result = await minimaxAdapter.query({
    provider: 'minimax-cn',
    baseUrl: 'https://api.minimaxi.com/v1',
    apiKey: 'sk-test',
    fetchFn,
  })
  // 占位的周窗口不画,只剩 5 小时窗口。
  assert.equal(result.windows.length, 1)
  assert.equal(result.windows[0].tier, 'five_hour')
  assert.equal(result.windows[0].usedPercent, 50)
})

test('minimax 适配器:业务错误 status_code 非 0 时报错', async () => {
  const body = { base_resp: { status_code: 1004, status_msg: 'invalid api key' } }
  const { fetchFn } = stubFetch(body)
  await assert.rejects(
    () => minimaxAdapter.query({
      provider: 'minimax-cn',
      baseUrl: 'https://api.minimaxi.com/v1',
      apiKey: 'sk-test',
      fetchFn,
    }),
    /invalid api key/)
})

test('minimax 适配器:国际站走 api.minimax.io', async () => {
  const body = {
    base_resp: { status_code: 0, status_msg: 'success' },
    model_remains: [generalLane()],
  }
  const { fetchFn, calls } = stubFetch(body)
  await minimaxAdapter.query({
    provider: 'minimax',
    baseUrl: 'https://api.minimax.io/v1',
    apiKey: 'sk-test',
    fetchFn,
  })
  assert.equal(calls[0].url, 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains')
})

test('minimax 适配器:status 3 但百分比非 100 的 lane 要保留', async () => {
  const body = {
    base_resp: { status_code: 0, status_msg: 'success' },
    model_remains: [
      // status 3 搭配真实百分比(非占位形状):这档是真的有额度,
      // 不能当成"服务端无权益占位"抹掉——抹掉就少画一个窗口。
      generalLane({
        current_interval_status: 3,
        current_interval_remaining_percent: 40,
      }),
    ],
  }
  const { fetchFn } = stubFetch(body)
  const result = await minimaxAdapter.query({
    provider: 'minimax-cn',
    baseUrl: 'https://api.minimaxi.com/v1',
    apiKey: 'sk-test',
    fetchFn,
  })
  assert.equal(result.windows.length, 2)
  const fiveHour = result.windows.find(w => w.tier === 'five_hour')
  // 剩余 40% → 已用 60%。
  assert.equal(fiveHour.usedPercent, 60)
})

test('适配器遇到 HTTP 401 时归为 auth,健康判定为无效', async () => {
  const { healthFromQuota } = await import('./core.js')
  // fetchJson 把 401/403 归为 kind:'auth' —— healthFromQuota 据此判 invalid。
  const quotaError = new (await import('./quota/types.js')).QuotaQueryError('auth', 'HTTP 401')
  const verdict = healthFromQuota(
    { status: 'error', error: { kind: quotaError.kind, message: quotaError.message } },
    'ok', 0, 1_000_000)
  assert.equal(verdict.health, 'invalid')
})

test('zhipu 适配器:用量比例按额度算术得出,用尽即为 100%', async () => {
  const body = {
    success: true,
    data: {
      limits: [
        {
          type: 'CREDIT_LIMIT',
          unit: 3,
          number: 5,
          usage: 1000,
          remaining: 0,
          currentValue: 1000,
          nextResetTime: 1_800_000_000_000,
        },
      ],
    },
  }
  const { fetchFn, calls } = stubFetch(body)
  const result = await zhipuAdapter.query({
    provider: 'zai-coding-cn',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    apiKey: 'sk-test',
    fetchFn,
  })
  // 智谱的 Authorization 不带 Bearer 前缀。
  assert.equal(calls[0].init.headers.authorization, 'sk-test')
  assert.equal(calls[0].url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit')
  // 用尽 → 已用 100% → 限流。
  assert.equal(result.windows[0].usedPercent, 100)
  assert.equal(healthFromQuota({ status: 'ok', windows: result.windows }, 'ok', 0, 1_000_000).health, 'limited')
})

/* ---------------------- DeepSeek 官方余额(/user/balance) ---------------------- */

test('deepseek-balance 适配器:走官方 /user/balance,CNY 优先并带上 is_available', async () => {
  const body = {
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '5.00' },
      { currency: 'CNY', total_balance: '110.00' },
    ],
  }
  const { fetchFn, calls } = stubFetch(body)
  const result = await deepseekBalanceAdapter.query({
    provider: 'deepseek-official',
    apiKey: 'sk-test',
    fetchFn,
  })
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance')
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test')
  // 余额随响应带出,供健康判定采信官方结论。
  assert.deepEqual(result.windows[0], {
    tier: 'balance',
    remainingValue: 110,
    unit: 'cny',
    available: true,
  })
})

test('deepseek-balance 适配器:baseURL 末尾的 /v1 要剥掉', async () => {
  const body = { balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }
  const { fetchFn, calls } = stubFetch(body)
  await deepseekBalanceAdapter.query({
    provider: 'deepseek-official',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test',
    fetchFn,
  })
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance')
})

test('deepseek-balance 适配器:Messages 根(/anthropic)也要回到平台根', async () => {
  // DSH 的 deepseek-official 推理根是 https://api.deepseek.com/anthropic;
  // 显式配置 baseURL 时不能把 /anthropic 带进余额端点,否则会 404。
  const body = { balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }
  const { fetchFn, calls } = stubFetch(body)
  await deepseekBalanceAdapter.query({
    provider: 'deepseek-official',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKey: 'sk-test',
    fetchFn,
  })
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance')
})

test('deepseek-balance 适配器:透支余额保留负号,健康判定为限流', async () => {
  const body = {
    is_available: false,
    balance_infos: [{ currency: 'CNY', total_balance: '-0.01' }],
  }
  const { fetchFn } = stubFetch(body)
  const result = await deepseekBalanceAdapter.query({
    provider: 'deepseek-official',
    apiKey: 'sk-test',
    fetchFn,
  })
  // 金额在响应里是字符串;负数是透支的真实形状,不能被截成 0。
  assert.equal(result.windows[0].remainingValue, -0.01)
  assert.equal(result.windows[0].available, false)
  assert.equal(healthFromQuota({ status: 'ok', windows: result.windows }, 'ok', 0, 1_000_000).health, 'limited')
})

test('deepseek-balance 适配器:没有 CNY 时回退到 USD', async () => {
  const body = { balance_infos: [{ currency: 'USD', total_balance: '8.50' }] }
  const { fetchFn } = stubFetch(body)
  const result = await deepseekBalanceAdapter.query({
    provider: 'deepseek-official',
    apiKey: 'sk-test',
    fetchFn,
  })
  assert.deepEqual(result.windows[0], {
    tier: 'balance',
    remainingValue: 8.5,
    unit: 'usd',
  })
})

test('deepseek-balance 适配器:响应形状不对时归为 parse 错误', async () => {
  const malformed = [
    null,
    {},
    { balance_infos: [] },
    { balance_infos: [{ currency: 'CNY', total_balance: 'abc' }] },
  ]
  for (const body of malformed) {
    const { fetchFn } = stubFetch(body)
    await assert.rejects(
      () => deepseekBalanceAdapter.query({
        provider: 'deepseek-official',
        apiKey: 'sk-test',
        fetchFn,
      }),
      error => error?.kind === 'parse')
  }
})

test('deepseek-balance 适配器:401 归为 auth,健康判定为无效', async () => {
  const { fetchFn } = stubFetch({}, { status: 401 })
  await assert.rejects(
    () => deepseekBalanceAdapter.query({
      provider: 'deepseek-official',
      apiKey: 'sk-test',
      fetchFn,
    }),
    error => error?.kind === 'auth')
})
