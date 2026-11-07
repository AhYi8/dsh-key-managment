/**
 * 密钥余额探测桥:把移植自 @laoyuehanni/dsh-token-usage 的 quota 适配器
 * 接到本插件的密钥池上。
 *
 * 与原插件的差异:凭据不再走"provider → 环境/凭据存储"链,而是直接用
 * 池内每把密钥的值探测;baseURL 读供应商 profile,缺省回退目录目录端点。
 * 带 TTL 缓存 + 串行探测(厂商用量端点按 IP 限流,不能并发扫)。
 */
import { resolveQuotaAdapter } from './quota/registry.js'
import { withCatalogBaseUrl } from './quota/credentials.js'
import { QuotaQueryError } from './quota/types.js'
import { hitValue, redactSecret } from './core.js'

/** ok 结果缓存时长:仅防御手速极快的连续刷新,后台节奏由配置驱动。 */
const CACHE_TTL_MS = 60_000
/** 单次查询超时:额度端点都很小,再慢就是死了。 */
const QUERY_TIMEOUT_MS = 10_000

/** 探测结果负载的公共壳。 */
function payloadOf(status, extra = {}) {
  return { status, fetchedAt: Date.now(), ...extra }
}

/**
 * 探测一把密钥的余额。
 *
 * @param ctx 宿主上下文(用 credentials.resolve 读池内值)
 * @param record 供应商纳管记录
 * @param key 池内密钥记录
 * @param profile 供应商 settings profile({ baseURL? })
 * @param cache Map<cacheKey, payload> 由调用方持有
 * @param inflight Map<cacheKey, Promise> 去重
 * @param force true 时绕过 TTL 缓存强制探测(后台轮与手动刷新用)
 */
export async function probeKey(ctx, record, key, profile, cache, inflight, force = false) {
  const cacheKey = `${record.provider}\u0000${key.id}`
  if (!force) {
    const cached = cache.get(cacheKey)
    if (cached !== undefined && cached.status === 'ok' && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached
    }
  }
  const running = inflight.get(cacheKey)
  if (running !== undefined) return running
  const query = (async () => {
    // apiKey 必须在 try 外声明:catch 里要用它做脱敏,
    // 若只在 try 内用 const 声明,catch 作用域拿不到它,脱敏会静默失效。
    let apiKey
    try {
      apiKey = hitValue(await ctx.credentials.resolve(key.ref))
      if (apiKey === undefined) {
        return payloadOf('error', { provider: record.provider, keyId: key.id, error: { kind: 'no-credential', message: '密钥值不可读' } })
      }
      const resolved = withCatalogBaseUrl(record.provider, {
        ...(typeof profile?.baseURL === 'string' && profile.baseURL !== '' ? { baseUrl: profile.baseURL } : {}),
      })
      const adapter = resolveQuotaAdapter({ provider: record.provider, ...(resolved.baseUrl !== undefined ? { baseUrl: resolved.baseUrl } : {}) })
      if (adapter === undefined) {
        return payloadOf('unsupported', { provider: record.provider, keyId: key.id })
      }
      const result = await adapter.query({
        provider: record.provider,
        ...(resolved.baseUrl !== undefined ? { baseUrl: resolved.baseUrl } : {}),
        apiKey,
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        fetchFn: globalThis.fetch,
      })
      const payload = payloadOf('ok', {
        provider: record.provider,
        keyId: key.id,
        adapterId: adapter.id,
        ...(result.planTier !== undefined ? { planTier: result.planTier } : {}),
        windows: result.windows,
      })
      cache.set(cacheKey, payload)
      return payload
    } catch (error) {
      // 错误消息会进 HTTP 响应与落盘快照:脱掉密钥片段并截断,
      // 不让第三方适配器的原文成为泄露通道(审查 P2-4)。
      const message = redactSecret(error?.message ?? String(error), apiKey).slice(0, 300)
      return payloadOf('error', {
        provider: record.provider,
        keyId: key.id,
        ...(error instanceof QuotaQueryError
          ? { error: { kind: error.kind, message } }
          : { error: { kind: 'parse', message } }),
      })
    }
  })()
  inflight.set(cacheKey, query)
  try {
    return await query
  } finally {
    inflight.delete(cacheKey)
  }
}
