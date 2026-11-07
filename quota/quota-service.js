/**
 * Quota orchestration service (node half): resolve the current provider,
 * route it through the adapter registry, resolve credentials, and serve
 * normalized {@link QuotaPayload}s with a per-provider TTL cache and
 * in-flight dedupe so N open sessions polling never hammer a provider's
 * quota endpoint.
 *
 * Cache policy: ok results cache per provider for `cacheTtlMs` (default
 * 45s — under the client's poll cadence, so a poll usually hits memory).
 * Error results do not cache, so the panel's retry / open-to-refresh
 * actually re-queries; in-flight callers still collapse into one outbound
 * request. `no-provider` / `unsupported` resolutions are pure settings
 * reads and never cache. A provider CHANGE invalidates by key (cache is
 * keyed by route), so switching providers serves fresh at once.
 *
 * @module token-usage/quota/quota-service
 */
import { resolveQuotaAdapter } from "./registry.js";
import { magpieAdapter, MagpieDetector } from "./adapters/magpie.js";
import { QuotaQueryError } from "./types.js";
import { withCatalogBaseUrl } from "./credentials.js";
/** Default cache lifetime of one provider's ok result. */
const DEFAULT_CACHE_TTL_MS = 45_000;
/** Per-query deadline: quota endpoints are small; anything slower is dead. */
const QUERY_TIMEOUT_MS = 10_000;
/** The gateway probe's own deadline — a hello that takes longer than this
 * is a dead route, not a magpie. */
const PROBE_TIMEOUT_MS = 5_000;
/** Map any thrown adapter failure onto the wire's error vocabulary. */
function toQuotaFailure(provider, providerName, adapter, error, intervalSec, now) {
    const normalized = error instanceof QuotaQueryError
        ? { kind: error.kind, message: error.message }
        : { kind: 'parse', message: error instanceof Error ? error.message : String(error) };
    return {
        status: 'error',
        provider,
        ...(providerName !== undefined ? { providerName } : {}),
        adapterId: adapter.id,
        fetchedAt: now,
        intervalSec,
        error: normalized,
    };
}
/**
 * The display name for a resolved adapter: the route's own name when the
 * route key is one of the adapter's catalog routes; a host-matched custom
 * route keeps its user-chosen alias but qualified by the adapter's family
 * label — the quota belongs to the family, and an alias like "OpenAI"
 * must not claim OpenCode Go windows as its own.
 */
function displayNameOf(provider, credentials, adapter) {
    if (adapter.routes === undefined || adapter.routes.includes(provider))
        return credentials.displayName;
    return `${credentials.displayName ?? provider} · ${adapter.label}`;
}
/** The quota orchestration service. */
export class QuotaService {
    #deps;
    #cache = new Map();
    #inflight = new Map();
    #magpieDetector;
    constructor(deps) {
        this.#deps = deps;
        this.#magpieDetector = deps.magpieDetector ?? new MagpieDetector(deps.now ?? Date.now);
    }
    /** The poll cadence every payload carries. */
    get intervalSec() {
        return this.#deps.intervalSec ?? 60;
    }
    /**
     * The payload for one asking session: hidden variants short-circuit
     * without any network; a supported provider serves its cached window
     * set or queries it (deduped per provider while in flight).
     * @param sessionId - the asking conversation session ('' / undefined
     * when the caller has no session context).
     * @param providerHint - the provider the session's model chip currently
     * selects (the host-reported NEXT selection), when the browser could read
     * one. It wins over the request tracker: the chip is the user's live
     * intent.
     * @param modelHint - that chip selection's model, paired with the live
     * provider. Without a provider hint, only the tracker's model is trusted.
     */
    async snapshot(sessionId, providerHint, modelHint) {
        const sighting = this.#deps.resolveSighting(sessionId);
        const hintLive = providerHint !== undefined && providerHint !== '';
        const provider = hintLive ? providerHint : sighting?.provider;
        if (provider === undefined) {
            return { status: 'no-provider', intervalSec: this.intervalSec };
        }
        const model = hintLive && modelHint !== undefined && modelHint !== ''
            ? modelHint
            : sighting !== undefined && sighting.provider === provider ? sighting.model : undefined;
        const credentials = withCatalogBaseUrl(provider, await this.#deps.resolveCredentials(provider));
        let adapter = resolveQuotaAdapter({
            provider,
            ...(credentials.baseUrl !== undefined ? { baseUrl: credentials.baseUrl } : {}),
        });
        if (adapter === undefined && credentials.baseUrl !== undefined) {
            // A route no table knows, pointing at a base URL: ask the magpie
            // hello — a user-declared gateway profile is exactly the shape the
            // host table cannot enumerate. The detector caches both verdicts,
            // so this stays off the hot path.
            const hit = await this.#magpieDetector.detect({
                baseUrl: credentials.baseUrl,
                ...(credentials.apiKey !== undefined ? { apiKey: credentials.apiKey } : {}),
                fetchFn: this.#deps.fetchFn ?? globalThis.fetch,
                signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            });
            if (hit)
                adapter = magpieAdapter;
        }
        if (adapter === undefined) {
            return {
                status: 'unsupported',
                provider,
                ...(credentials.displayName !== undefined ? { providerName: credentials.displayName } : {}),
                intervalSec: this.intervalSec,
            };
        }
        const providerName = displayNameOf(provider, credentials, adapter);
        if (adapter.usesApiKey !== false && credentials.apiKey === undefined) {
            return {
                status: 'error',
                provider,
                ...(providerName !== undefined ? { providerName } : {}),
                adapterId: adapter.id,
                fetchedAt: this.#now(),
                intervalSec: this.intervalSec,
                error: {
                    kind: 'no-credential',
                    message: credentials.apiKeyEnv ?? provider,
                },
            };
        }
        // The cache key includes the model: a gateway adapter's windows are a
        // function of both (the model scopes the cards), so two sessions on
        // the same route but different models keep their own snapshots.
        const cacheKey = `${provider}\u0000${model ?? ''}`;
        const cached = this.#cached(cacheKey);
        if (cached !== undefined)
            return cached;
        const running = this.#inflight.get(cacheKey);
        if (running !== undefined)
            return running;
        const query = this.#query(provider, model, providerName, credentials, adapter);
        this.#inflight.set(cacheKey, query);
        try {
            return await query;
        }
        finally {
            this.#inflight.delete(cacheKey);
        }
    }
    /** The fresh-or-cached ok result, or a live error, of one provider query. */
    async #query(provider, model, providerName, credentials, adapter) {
        try {
            const result = await adapter.query({
                provider,
                ...(credentials.baseUrl !== undefined ? { baseUrl: credentials.baseUrl } : {}),
                apiKey: credentials.apiKey ?? '',
                ...(model !== undefined && model !== '' ? { model } : {}),
                signal: AbortSignal.timeout(adapter.queryTimeoutMs ?? QUERY_TIMEOUT_MS),
                ...(this.#deps.fetchFn !== undefined ? { fetchFn: this.#deps.fetchFn } : { fetchFn: globalThis.fetch }),
                ...(this.#deps.readAccountBalance !== undefined ? { readAccountBalance: this.#deps.readAccountBalance } : {}),
            });
            const payload = {
                status: 'ok',
                provider,
                ...(providerName !== undefined ? { providerName } : {}),
                adapterId: adapter.id,
                fetchedAt: this.#now(),
                intervalSec: this.intervalSec,
                ...(result.planTier !== undefined ? { planTier: result.planTier } : {}),
                windows: result.windows,
            };
            this.#cache.set(`${provider}\u0000${model ?? ''}`, { at: this.#now(), payload });
            return payload;
        }
        catch (error) {
            // Errors do not cache: the panel's retry must actually re-query.
            this.#cache.delete(`${provider}\u0000${model ?? ''}`);
            return toQuotaFailure(provider, providerName, adapter, error, this.intervalSec, this.#now());
        }
    }
    /** The unexpired ok cache entry of a provider, if one exists. */
    #cached(provider) {
        const entry = this.#cache.get(provider);
        if (entry === undefined)
            return undefined;
        const ttl = this.#deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
        if (this.#now() - entry.at >= ttl) {
            this.#cache.delete(provider);
            return undefined;
        }
        return entry.payload;
    }
    /** The service clock. */
    #now() {
        return this.#deps.now?.() ?? Date.now();
    }
}
//# sourceMappingURL=quota-service.js.map