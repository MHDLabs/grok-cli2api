// ============================================================
//  Grok CLI → OpenAI Compatible Proxy
//  ------------------------------------------------------------
//  A single-file Cloudflare Worker that turns Grok CLI into a
//  fully OpenAI-compatible API with:
//    • Dark, modern admin panel (Grok-like theme)
//    • OAuth 2.0 Device Code Flow for Grok CLI login
//    • Multi-account support with automatic Round-Robin
//    • Dedicated API keys with usage tracking
//    • KV storage with a one-time deployment secret for safe first-run setup
//    • Full /v1/chat/completions and /v1/models endpoints
//
//  Repository: https://github.com/MHDLabs/grok-cli2api
//  License:    MIT
//  Author:     MHDLabs
// ============================================================

const SESSION_TTL = 86400; // 24h
const GROK_UPSTREAM = 'https://cli-chat-proxy.grok.com';
const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const GROK_SCOPE = 'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write';
const OIDC_DISCOVERY = 'https://auth.x.ai/.well-known/openid-configuration';

// ---------- Grok Client Identity (required by upstream) ----------
const GROK_CLIENT_VERSION = '1.0.44';
const GROK_CLIENT_IDENTIFIER = 'grok-shell';
const GROK_USER_AGENT = 'grok-shell/1.0.44 (linux; x86_64)';

// ---------- Dynamic model discovery ----------
const MODEL_CACHE_TTL = 5 * 60 * 1000;
const MODEL_STALE_TTL = 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 10000;

// ============================================================
//  Utilities
// ============================================================
function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    let diff = a.length ^ b.length;
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i++) {
        diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0);
    }
    return diff === 0;
}

function randomHex(len = 32) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        },
    });
}

function html(content, status = 200) {
    return new Response(content, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

function grokHeaders(accessToken, extra = {}) {
    return {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + accessToken,
        'User-Agent': GROK_USER_AGENT,
        'X-XAI-Token-Auth': 'xai-grok-cli',
        'x-grok-client-version': GROK_CLIENT_VERSION,
        'x-grok-client-identifier': GROK_CLIENT_IDENTIFIER,
        ...extra,
    };
}

// ============================================================
//  KV Helpers
// ============================================================
async function kvGet(env, key, fallback = null) {
    try {
        const val = await env.GROK_KV.get(key);
        return val ? JSON.parse(val) : fallback;
    } catch {
        return fallback;
    }
}

async function kvPut(env, key, value) {
    await env.GROK_KV.put(key, JSON.stringify(value));
}

async function kvDel(env, key) {
    await env.GROK_KV.delete(key);
}

// ============================================================
//  Sessions
// ============================================================
async function createSession(env) {
    const token = randomHex(32);
    await kvPut(env, `session:${token}`, { createdAt: Date.now() });
    return token;
}

async function verifySession(env, token) {
    if (!token) return false;
    const sess = await kvGet(env, `session:${token}`);
    if (!sess) return false;
    if (Date.now() - sess.createdAt > SESSION_TTL * 1000) {
        await kvDel(env, `session:${token}`);
        return false;
    }
    return true;
}

function getCookie(request, name) {
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? match[1] : null;
}

async function requireAdmin(request, env) {
    const token = getCookie(request, 'grok_session');
    return verifySession(env, token);
}

// ============================================================
//  API Keys
// ============================================================
async function generateApiKey(env, label = 'default') {
    const key = 'gk_' + randomHex(24);
    const keys = await kvGet(env, 'apikeys:list', []);
    keys.push({ key, label, createdAt: Date.now(), active: true, usage: 0 });
    await kvPut(env, 'apikeys:list', keys);
    return key;
}

async function validateApiKey(env, authHeader) {
    if (!authHeader) return false;
    const key = authHeader.replace(/^Bearer\s+/i, '');
    const keys = await kvGet(env, 'apikeys:list', []);
    return keys.some(k => k.key === key && k.active);
}

// ============================================================
//  Account Selection (Round-Robin)
// ============================================================
async function pickAccount(env) {
    const accounts = await kvGet(env, 'accounts:list', []);
    const active = accounts.filter(a => a.active);
    if (!active.length) return null;
    active.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    const chosen = active[0];
    chosen.lastUsed = Date.now();
    await kvPut(env, 'accounts:list', accounts);
    return chosen;
}

// ============================================================
//  OIDC Discovery (cached for 1h)
// ============================================================
async function getOidcEndpoints(env) {
    const cached = await kvGet(env, 'oauth:endpoints');
    if (cached && Date.now() - cached.ts < 3600000) return cached;

    const res = await fetch(OIDC_DISCOVERY, {
        headers: { 'Accept': 'application/json', 'User-Agent': GROK_USER_AGENT },
    });
    if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
    const data = await res.json();

    const endpoints = {
        device_endpoint: data.device_authorization_endpoint || 'https://auth.x.ai/oauth2/device/code',
        token_endpoint: data.token_endpoint || 'https://auth.x.ai/oauth2/token',
        verification_uri: 'https://accounts.x.ai/oauth2/device',
        ts: Date.now(),
    };
    await kvPut(env, 'oauth:endpoints', endpoints);
    return endpoints;
}

// ============================================================
//  OAuth Device Flow
// ============================================================
async function oauthDeviceStart(env) {
    try {
        const ep = await getOidcEndpoints(env);

        const res = await fetch(ep.device_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'Accept': 'application/json',
                'User-Agent': GROK_USER_AGENT,
                'x-grok-client-version': GROK_CLIENT_VERSION,
                'x-grok-client-identifier': GROK_CLIENT_IDENTIFIER,
            },
            body: `client_id=${encodeURIComponent(GROK_CLIENT_ID)}&scope=${encodeURIComponent(GROK_SCOPE)}&referrer=grok-build`,
        });

        const text = await res.text();
        

        if (!res.ok) {
            return { error: 'device_code_request_failed', status: res.status };
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch {
            return { error: 'invalid_json', status: res.status };
        }

        if (data.user_code && !data.verification_uri_complete) {
            data.verification_uri = data.verification_uri || ep.verification_uri;
            data.verification_uri_complete = `${data.verification_uri}?user_code=${encodeURIComponent(data.user_code)}`;
        }

        return data;
    } catch (e) {
        return { error: 'exception', message: String(e) };
    }
}

async function oauthDevicePoll(env, deviceCode) {
    try {
        const ep = await getOidcEndpoints(env);

        const res = await fetch(ep.token_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'Accept': 'application/json',
                'User-Agent': GROK_USER_AGENT,
                'x-grok-client-version': GROK_CLIENT_VERSION,
                'x-grok-client-identifier': GROK_CLIENT_IDENTIFIER,
            },
            body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:device_code')}&device_code=${encodeURIComponent(deviceCode)}&client_id=${encodeURIComponent(GROK_CLIENT_ID)}`,
        });

        const text = await res.text();
        

        try {
            return JSON.parse(text);
        } catch {
            return { error: 'invalid_json', status: res.status };
        }
    } catch (e) {
        return { error: 'exception', message: String(e) };
    }
}


function decodeJwtClaims(token) {
    try {
        const part = String(token || '').split('.')[1];
        if (!part) return {};
        const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
        return JSON.parse(atob(padded));
    } catch {
        return {};
    }
}

function accountUserId(account) {
    if (account && account.user_id) return String(account.user_id);
    const claims = decodeJwtClaims(account && account.access_token);
    const candidate = claims.xai_user_id || claims.user_id || claims.userId || claims.uid || claims.sub;
    return typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : '';
}

function normalizeModelPayload(payload) {
    const raw = Array.isArray(payload) ? payload :
        (Array.isArray(payload && payload.data) ? payload.data :
        (Array.isArray(payload && payload.models) ? payload.models : []));
    const seen = new Set();
    return raw.filter(model => model && [model.id, model.model, model.modelId]
        .some(value => typeof value === 'string' && value.trim()))
        .map(model => ({
            ...model,
            id: String(model.id || model.model || model.modelId).trim(),
            object: model.object || 'model',
            owned_by: model.owned_by || model.ownedBy || 'xai',
            capabilities: Array.isArray(model.capabilities) ? model.capabilities : [],
        }))
        .filter(model => {
            if (!model.id || seen.has(model.id)) return false;
            seen.add(model.id);
            return true;
        });
}

function isApiModelSelectable(model) {
    const meta = model && model._meta && typeof model._meta === 'object' ? model._meta : {};
    const hidden = model.hidden === true || meta.hidden === true;
    const supported = model.supportedInApi ?? model.supported_in_api ??
        meta.supportedInApi ?? meta.supported_in_api;
    return !hidden && supported !== false;
}

function subscriptionTierStatus(profile) {
    const tier = profile && (profile.subscriptionTier ?? profile.subscription_tier);
    // The upstream omits subscriptionTier for a personal Free account.
    if (tier === undefined || tier === null || (typeof tier === 'string' && !tier.trim())) {
        return { isFreeTier: true, tier: 'Free', tierReported: false };
    }
    if (typeof tier !== 'string') {
        return { isFreeTier: false, tier: 'unknown', tierReported: true };
    }
    const normalized = tier.trim();
    return { isFreeTier: normalized.toLowerCase() === 'free', tier: normalized, tierReported: true };
}

function explicitFreeState(model) {
    const flags = [
        'is_free', 'isFree', 'free', 'free_tier', 'freeTier',
        'included', 'is_included', 'included_in_plan', 'includedInPlan',
    ];
    for (const key of flags) {
        if (typeof model[key] === 'boolean') return model[key];
    }
    const fields = [
        model.billing_tier, model.billingTier, model.pricing_tier,
        model.pricingTier, model.access_tier, model.accessTier, model.plan,
        model.tier, model.billing, model.pricing_type, model.pricingType,
    ];
    const label = fields.filter(v => typeof v === 'string').join(' ').toLowerCase();
    if (/\b(free|included|complimentary)\b/.test(label)) return true;
    if (/\b(paid|premium|pro|upgrade|required subscription)\b/.test(label)) return false;
    const pricing = model.pricing || model.price;
    if (pricing && typeof pricing === 'object') {
        const amounts = [];
        for (const key of ['input', 'output', 'prompt', 'completion', 'input_price', 'output_price']) {
            const value = pricing[key];
            if (typeof value === 'number') amounts.push(value);
            else if (value && typeof value === 'object') {
                for (const nested of ['price', 'amount', 'per_token', 'per_1m_tokens']) {
                    if (typeof value[nested] === 'number') amounts.push(value[nested]);
                }
            }
        }
        if (amounts.length && amounts.every(value => value === 0)) return true;
        if (amounts.some(value => value > 0)) return false;
    }
    return null;
}

async function shortTokenFingerprint(token) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token || '')));
    return Array.from(new Uint8Array(digest).slice(0, 12), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('upstream timeout'), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function refreshAccountToken(env, account) {
    if (!account || !account.refresh_token) return null;
    try {
        const endpoints = await getOidcEndpoints(env);
        const response = await fetchWithTimeout(endpoints.token_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'Accept': 'application/json',
                'User-Agent': GROK_USER_AGENT,
                'x-grok-client-version': GROK_CLIENT_VERSION,
                'x-grok-client-identifier': GROK_CLIENT_IDENTIFIER,
            },
            body: 'grant_type=refresh_token&refresh_token=' +
                encodeURIComponent(account.refresh_token) + '&client_id=' + encodeURIComponent(GROK_CLIENT_ID),
        });
        if (!response.ok) return null;
        const data = await response.json();
        if (!data || !data.access_token) return null;
        const updated = {
            ...account,
            access_token: data.access_token,
            refresh_token: data.refresh_token || account.refresh_token,
            expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : account.expires_at,
        };
        const accounts = await kvGet(env, 'accounts:list', []);
        const index = accounts.findIndex(item =>
            item.access_token === account.access_token ||
            (item.email === account.email && item.createdAt === account.createdAt));
        if (index >= 0) {
            accounts[index] = { ...accounts[index], ...updated };
            await kvPut(env, 'accounts:list', accounts);
        }
        return updated;
    } catch {
        return null;
    }
}

async function fetchAccountRequest(env, account, url, init = {}) {
    let currentAccount = account;
    const send = token => {
        const identityHeaders = url.startsWith(GROK_UPSTREAM + '/') ? {
            ...(accountUserId(currentAccount) ? { 'x-userid': accountUserId(currentAccount) } : {}),
            ...(currentAccount.email ? { 'x-email': String(currentAccount.email) } : {}),
        } : {};
        return fetchWithTimeout(url, {
            ...init,
            headers: { ...grokHeaders(token), ...identityHeaders, ...(init.headers || {}) },
        });
    };
    let response = await send(currentAccount.access_token);
    if (response.status === 401 && currentAccount.refresh_token) {
        const refreshed = await refreshAccountToken(env, currentAccount);
        if (refreshed) {
            currentAccount = refreshed;
            response = await send(currentAccount.access_token);
        }
    }
    return { response, account: currentAccount };
}

async function fetchFreeModelsForAccount(env, account, force = false) {
    let cacheKey = 'models:free:' + await shortTokenFingerprint(account.access_token);
    const cached = await kvGet(env, cacheKey);
    if (!force && cached && cached.verified === true &&
        Date.now() - Number(cached.fetchedAt || 0) < MODEL_CACHE_TTL) {
        return { ...cached, fromCache: true };
    }

    let freeTierConfirmed = false;
    try {
        const userId = accountUserId(account);
        const userResult = await fetchAccountRequest(env, account, GROK_UPSTREAM + '/v1/user?include=subscription', {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                ...(userId ? { 'x-userid': userId } : {}),
                ...(account.email ? { 'x-email': String(account.email) } : {}),
            },
        });
        account = userResult.account;
        cacheKey = 'models:free:' + await shortTokenFingerprint(account.access_token);
        if (!userResult.response.ok) {
            throw new Error('Upstream subscription endpoint returned HTTP ' + userResult.response.status);
        }
        const profile = await userResult.response.json();
        const tier = subscriptionTierStatus(profile);
        freeTierConfirmed = tier.isFreeTier;

        const modelResult = await fetchAccountRequest(env, account, GROK_UPSTREAM + '/v1/models', {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                ...(userId ? { 'x-userid': userId } : {}),
                ...(account.email ? { 'x-email': String(account.email) } : {}),
            },
        });
        account = modelResult.account;
        if (!modelResult.response.ok) {
            throw new Error('Upstream model endpoint returned HTTP ' + modelResult.response.status);
        }

        const upstreamModels = normalizeModelPayload(await modelResult.response.json())
            .filter(isApiModelSelectable);
        if (!upstreamModels.length) {
            throw new Error('The upstream returned no API-supported models.');
        }

        // On a Free account, the official /v1/models endpoint is tier-aware and returns the catalog
        // available to that tier. For non-Free accounts, expose only models that explicitly
        // self-identify as free/included; never infer their price from names or model families.
        const models = upstreamModels.filter(model => {
            const freeState = explicitFreeState(model);
            if (freeState === false) return false;
            return tier.isFreeTier || freeState === true;
        });

        const entry = {
            models,
            fetchedAt: Date.now(),
            source: tier.isFreeTier
                ? 'cli-chat-proxy /v1/user?include=subscription + tier-specific /v1/models'
                : 'cli-chat-proxy /v1/user?include=subscription + explicit free metadata from /v1/models',
            verified: true,
            isFreeTier: tier.isFreeTier,
            accountTier: tier.tier,
            tierReported: tier.tierReported,
            error: models.length ? null : (tier.isFreeTier
                ? 'The upstream returned no API-supported models for this Free account.'
                : 'This account is not on the Free tier and the model catalogue has no explicit free/included metadata.'),
        };
        await kvPut(env, cacheKey, entry);
        return { ...entry, fromCache: false };
    } catch (error) {
        // Stale model data may be reused only after this request confirms the account is still Free.
        if (freeTierConfirmed && cached && cached.isFreeTier === true &&
            Array.isArray(cached.models) && Date.now() - Number(cached.fetchedAt || 0) < MODEL_STALE_TTL) {
            return {
                ...cached,
                fromCache: true,
                stale: true,
                error: 'Live model refresh failed; serving the last verified Free-tier catalogue temporarily.',
            };
        }
        return {
            models: [],
            fetchedAt: null,
            source: null,
            verified: false,
            isFreeTier: freeTierConfirmed,
            accountTier: null,
            tierReported: false,
            fromCache: false,
            error: String(error && error.message || 'Unable to verify account tier and model catalogue'),
        };
    }
}

async function getFreeModelCatalog(env, force = false) {
    const accounts = await kvGet(env, 'accounts:list', []);
    const active = accounts.filter(account => account && account.active && account.access_token);
    if (!active.length) {
        return { models: [], fetchedAt: null, source: null, verified: false, error: 'No active Grok account configured.' };
    }
    const results = await Promise.all(active.map(account =>
        fetchFreeModelsForAccount(env, account, force).catch(error => ({
            models: [], fetchedAt: null, verified: false, source: null,
            error: String(error && error.message || 'Model discovery failed'),
        }))
    ));
    const byId = new Map();
    for (const result of results) {
        for (const model of result.models || []) {
            if (!byId.has(model.id)) byId.set(model.id, model);
        }
    }
    const models = Array.from(byId.values());
    const timestamps = results.map(result => result.fetchedAt || 0).filter(Boolean);
    const errors = results.map(result => result.error).filter(Boolean);
    const freeTierAccounts = results.filter(result => result.isFreeTier === true).length;
    const nonFreeAccounts = results.filter(result => result.isFreeTier === false).length;
    const excludedAccounts = results.filter(result => !Array.isArray(result.models) || result.models.length === 0).length;
    return {
        models,
        fetchedAt: timestamps.length ? Math.max(...timestamps) : null,
        source: results.find(result => Array.isArray(result.models) && result.models.length && result.source)?.source ||
            results.find(result => result.source)?.source || null,
        verified: results.some(result => result.verified === true),
        stale: results.some(result => result.stale),
        fromCache: results.every(result => result.fromCache),
        error: models.length ? null : (errors[0] || 'No verified free models are available. Configure a Free-tier account or an explicit upstream free-model marker.'),
        accountCount: active.length,
        freeTierAccountCount: freeTierAccounts,
        nonFreeAccountCount: nonFreeAccounts,
        excludedAccountCount: excludedAccounts,
    };
}

async function pickAccountForModel(env, modelId) {
    const accounts = await kvGet(env, 'accounts:list', []);
    const active = accounts.filter(account => account && account.active && account.access_token)
        .sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    for (const account of active) {
        const catalog = await fetchFreeModelsForAccount(env, account, false);
        if (!(catalog.models || []).some(model => model.id === modelId)) continue;
        const current = await kvGet(env, 'accounts:list', []);
        const index = current.findIndex(item =>
            item.access_token === account.access_token ||
            (item.email === account.email && item.createdAt === account.createdAt));
        if (index >= 0) {
            current[index].lastUsed = Date.now();
            await kvPut(env, 'accounts:list', current);
            return current[index];
        }
        return account;
    }
    return null;
}

// ============================================================
//  Admin Panel HTML
// ============================================================
function adminPage() {
    return `<!DOCTYPE html>
    <html lang="en" dir="ltr">
    <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Grok Proxy — Admin</title>
    <style>
    :root {
        --bg: #0a0a0f;
        --surface: #12121a;
        --surface2: #1a1a26;
        --border: #2a2a3a;
        --text: #e8e8f0;
        --muted: #8888a0;
        --accent: #7c6cf0;
        --accent2: #00d4aa;
        --danger: #ff5566;
        --warn: #ffaa33;
        --radius: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        background: var(--bg);
        color: var(--text);
        font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
        min-height: 100vh;
        line-height: 1.6;
    }
    .glow {
        position: fixed; top: -200px; left: 50%; transform: translateX(-50%);
        width: 600px; height: 400px;
        background: radial-gradient(ellipse, rgba(124,108,240,0.15), transparent 70%);
        pointer-events: none; z-index: 0;
    }
    .container { max-width: 900px; margin: 0 auto; padding: 24px; position: relative; z-index: 1; }
    .header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 20px 0; border-bottom: 1px solid var(--border); margin-bottom: 32px;
    }
    .logo { display: flex; align-items: center; gap: 10px; font-size: 20px; font-weight: 700; }
    .logo-icon {
        width: 32px; height: 32px; border-radius: 8px;
        background: linear-gradient(135deg, var(--accent), var(--accent2));
        display: grid; place-items: center; font-size: 16px;
    }
    .logout-btn {
        background: transparent; border: 1px solid var(--border); color: var(--muted);
        padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 13px;
        transition: all .2s;
    }
    .logout-btn:hover { border-color: var(--danger); color: var(--danger); }
    .tabs { display: flex; gap: 4px; margin-bottom: 24px; background: var(--surface); padding: 4px; border-radius: var(--radius); }
    .tab {
        flex: 1; padding: 10px; border: none; background: transparent; color: var(--muted);
        border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all .2s;
    }
    .tab.active { background: var(--surface2); color: var(--text); }
    .card {
        background: var(--surface); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 24px; margin-bottom: 16px;
    }
    .card h3 { font-size: 15px; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    .badge {
        font-size: 11px; padding: 2px 8px; border-radius: 20px; font-weight: 600;
        background: rgba(124,108,240,0.15); color: var(--accent);
    }
    .badge.green { background: rgba(0,212,170,0.15); color: var(--accent2); }
    .badge.red { background: rgba(255,85,102,0.15); color: var(--danger); }
    .badge.warn { background: rgba(255,170,51,0.15); color: var(--warn); }
    input, select {
        width: 100%; padding: 10px 14px; background: var(--bg); border: 1px solid var(--border);
        border-radius: 8px; color: var(--text); font-size: 14px; outline: none; transition: border .2s;
    }
    input:focus { border-color: var(--accent); }
    .btn {
        padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer;
        font-size: 14px; font-weight: 600; transition: all .2s;
    }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover:not(:disabled) { opacity: .85; }
    .btn-danger { background: transparent; border: 1px solid var(--danger); color: var(--danger); }
    .btn-sm { padding: 6px 12px; font-size: 12px; }
    .row { display: flex; gap: 12px; align-items: center; }
    .row > * { flex: 1; }
    .key-display {
        font-family: monospace; font-size: 12px; background: var(--bg);
        padding: 12px; border-radius: 8px; word-break: break-all;
        border: 1px dashed var(--border); color: var(--accent2);
    }
    .empty { text-align: center; padding: 40px; color: var(--muted); font-size: 14px; }
    .toast {
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(100px);
        background: var(--surface2); border: 1px solid var(--border); padding: 12px 24px;
        border-radius: 10px; font-size: 13px; transition: transform .3s; z-index: 100;
    }
    .toast.show { transform: translateX(-50%) translateY(0); }
    .login-wrap { display: grid; place-items: center; min-height: 100vh; padding: 24px; }
    .login-box {
        background: var(--surface); border: 1px solid var(--border);
        border-radius: 16px; padding: 40px; width: 100%; max-width: 380px; text-align: center;
    }
    .login-box h1 { font-size: 22px; margin-bottom: 8px; }
    .login-box p { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
    .error { color: var(--danger); font-size: 13px; margin-top: 12px; }
    .hidden { display: none !important; }
    .error-box {
        background: rgba(255,85,102,0.08); border: 1px solid rgba(255,85,102,0.3);
        border-radius: 8px; padding: 12px 16px; margin-top: 12px;
        font-size: 12px; color: var(--danger); white-space: pre-wrap; word-break: break-all;
    }
    .info-box {
        background: rgba(124,108,240,0.08); border: 1px solid rgba(124,108,240,0.3);
        border-radius: 8px; padding: 12px 16px; margin-top: 12px;
        font-size: 13px; color: var(--text);
    }
    .spinner {
        display: inline-block; width: 14px; height: 14px;
        border: 2px solid rgba(255,255,255,0.2); border-top-color: #fff;
        border-radius: 50%; animation: spin .6s linear infinite;
        margin-right: 8px; vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    a { color: var(--accent2); }
    .models-list { display: grid; gap: 8px; margin-top: 12px; }
    .model-item { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:12px; border:1px solid var(--border); border-radius:8px; background:var(--bg); }
    .model-id { font-family:monospace; overflow-wrap:anywhere; font-size:13px; }
    .model-cap { font-size:11px; border:1px solid var(--border); color:var(--muted); padding:2px 6px; border-radius:14px; }
    button:focus-visible, input:focus-visible, a:focus-visible { outline:2px solid var(--accent2); outline-offset:2px; }
    @media (max-width: 640px) {
      .container { padding:14px; }
      .card { padding:16px; }
      .header { gap:12px; margin-bottom:20px; }
      .tabs { flex-wrap:wrap; }
      .tab { flex:1 1 40%; }
      .row { flex-direction:column; align-items:stretch; }
      .row > * { width:100%; }
      .login-box { padding:24px; }
    }
    </style>
    </head>
    <body>
    <div class="glow"></div>

    <!-- LOGIN -->
    <div id="loginView" class="login-wrap">
    <div class="login-box">
    <div class="logo-icon" style="margin:0 auto 16px;width:48px;height:48px;font-size:22px;">&#9889;</div>
    <h1>Grok Proxy</h1>
    <p>Admin Panel</p>
    <input type="password" id="loginPass" placeholder="Password" onkeydown="if(event.key==='Enter')doLogin()">
    <button class="btn btn-primary" style="width:100%;margin-top:16px;" onclick="doLogin()">Sign in</button>
    <div id="loginError" class="error hidden"></div>
    </div>
    </div>

    <!-- FIRST-RUN SETUP -->
    <div id="setupView" class="login-wrap hidden">
    <div class="login-box">
    <div class="logo-icon" style="margin:0 auto 16px;width:48px;height:48px;font-size:22px;">&#128274;</div>
    <h1>Secure your panel</h1>
    <p>Enter the one-time Cloudflare setup secret, then create an admin password (12+ characters).</p>
    <input type="password" id="setupSecret" autocomplete="off" placeholder="One-time setup secret" style="margin-bottom:10px;">
    <input type="password" id="setupPass" autocomplete="new-password" placeholder="New admin password (12+ chars)">
    <button class="btn btn-primary" style="width:100%;margin-top:16px;" onclick="doSetup()">Set password</button>
    <div id="setupError" class="error hidden"></div>
    </div>
    </div>

    <!-- DASHBOARD -->
    <div id="dashView" class="container hidden">
    <div class="header">
    <div class="logo"><div class="logo-icon">&#9889;</div> Grok Proxy</div>
    <button class="logout-btn" onclick="doLogout()">Logout</button>
    </div>

    <div class="tabs">
    <button class="tab active" data-tab="accounts" onclick="switchTab(this)">Accounts</button>
    <button class="tab" data-tab="apikeys" onclick="switchTab(this)">API Keys</button>
    <button class="tab" data-tab="models" onclick="switchTab(this)">Models</button>
    <button class="tab" data-tab="settings" onclick="switchTab(this)">Settings</button>
    </div>

    <!-- Accounts -->
    <div id="tab-accounts">
    <div class="card">
    <h3>&#128279; Add Grok Account (OAuth)</h3>
    <p style="color:var(--muted);font-size:13px;margin-bottom:16px;">
    Click below to get a device code. The verification page opens automatically in a new tab.
    </p>
    <button class="btn btn-primary" id="oauthBtn" onclick="startOAuth()">Start OAuth</button>

    <div id="oauthBox" class="hidden" style="margin-top:16px;">
    <div class="info-box">
    <div style="margin-bottom:8px;">Your verification code:</div>
    <div style="font-size:22px;font-weight:700;font-family:monospace;text-align:center;letter-spacing:2px;" id="oauthCode"></div>
    </div>
    <p style="font-size:13px;color:var(--muted);margin:12px 0;">
    If the new tab didn't open, <a id="oauthUri" href="#" target="_blank">click here</a>.
    </p>
    <div style="display:flex;align-items:center;gap:12px;">
    <span id="oauthSpinner" class="spinner hidden"></span>
    <span id="oauthStatus" style="font-size:13px;color:var(--muted);"></span>
    </div>
    <div id="oauthError" class="error-box hidden"></div>
    <button class="btn btn-primary btn-sm" style="margin-top:12px;" onclick="pollOAuth()">Check status manually</button>
    </div>
    </div>
    <div class="card">
    <h3>&#128203; Accounts <span class="badge green" id="accountCount">0</span></h3>
    <div id="accountsList"></div>
    </div>
    </div>

    <!-- API Keys -->
    <div id="tab-apikeys" class="hidden">
    <div class="card">
    <h3>&#128273; Create new API Key</h3>
    <div class="row">
    <input id="keyLabel" placeholder="Label (e.g. my-app)">
    <button class="btn btn-primary" onclick="createKey()" style="flex:0;">Create</button>
    </div>
    <div id="newKeyBox" class="hidden" style="margin-top:16px;">
    <div class="key-display" id="newKeyVal"></div>
    </div>
    </div>
    <div class="card">
    <h3>&#128203; API Keys <span class="badge green" id="keyCount">0</span></h3>
    <div id="keysList"></div>
    </div>
    </div>

    <!-- Models -->
    <div id="tab-models" class="hidden">
    <div class="card">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
    <h3 style="margin:0;">&#129302; Live model catalogue <span class="badge green" id="modelsCount">0</span></h3>
    <button class="btn btn-primary btn-sm" id="modelsRefreshBtn" onclick="refreshModels()">Refresh</button>
    </div>
    <p id="modelsMeta" style="font-size:13px;color:var(--muted);margin-top:12px;">Model eligibility is verified against upstream metadata.</p>
    <div id="modelsError" class="error-box hidden"></div>
    <div id="modelsList" class="models-list"><div class="empty">Loading models…</div></div>
    </div>
    </div>

    <!-- Settings -->
    <div id="tab-settings" class="hidden">
    <div class="card">
    <h3>&#128274; Change Password</h3>
    <div class="row" style="margin-bottom:12px;">
    <input type="password" id="oldPass" placeholder="Current password">
    <input type="password" id="newPass" placeholder="New password">
    </div>
    <button class="btn btn-primary" onclick="changePass()">Change password</button>
    <div id="passMsg" class="hidden" style="margin-top:12px;font-size:13px;"></div>
    </div>
    <div class="card">
    <h3>&#8505;&#65039; Proxy Info</h3>
    <div class="key-display" id="proxyUrl"></div>
    <p style="font-size:13px;color:var(--muted);margin-top:12px;">
    Endpoint: <code style="color:var(--accent2);">/v1/chat/completions</code><br>
    Models: <code style="color:var(--accent2);">/v1/models</code>
    </p>
    </div>
    </div>
    </div>

    <div id="toast" class="toast"></div>

    <script>
    let currentTab = 'accounts';
    let deviceCode = null;
    let pollTimer = null;
    let oauthWindow = null;

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>\"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[ch]));
    }

    function toast(msg) {
        const t = document.getElementById('toast');
        t.textContent = msg; t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2500);
    }

    async function api(path, opts = {}) {
        const res = await fetch(path, { credentials: 'same-origin', ...opts });
        const text = await res.text();
        try { return JSON.parse(text); } catch { return { error: 'invalid_json', raw: text, status: res.status }; }
    }

    // --- Auth ---
    async function checkAuth() {
        const r = await api('/admin/api/check');
        if (r.setup_required) showSetup();
        else if (r.ok) { showDash(); loadAll(); }
        else showLogin();
    }

    function showLogin() {
        document.getElementById('loginView').classList.remove('hidden');
        document.getElementById('setupView').classList.add('hidden');
        document.getElementById('dashView').classList.add('hidden');
    }

    function showSetup() {
        document.getElementById('loginView').classList.add('hidden');
        document.getElementById('setupView').classList.remove('hidden');
        document.getElementById('dashView').classList.add('hidden');
    }

    function showDash() {
        document.getElementById('loginView').classList.add('hidden');
        document.getElementById('setupView').classList.add('hidden');
        document.getElementById('dashView').classList.remove('hidden');
        document.getElementById('proxyUrl').textContent = location.origin + '/v1/chat/completions';
    }

    async function doSetup() {
        const password = document.getElementById('setupPass').value;
        const secret = document.getElementById('setupSecret').value;
        const err = document.getElementById('setupError');
        err.classList.add('hidden');
        const r = await api('/admin/api/setup', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password, secret }),
        });
        if (r.ok) { showDash(); loadAll(); }
        else { err.textContent = r.message || r.error || 'Could not set password'; err.classList.remove('hidden'); }
    }

    async function doLogin() {
        const pass = document.getElementById('loginPass').value;
        const r = await api('/admin/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pass }),
        });
        if (r.ok) { showDash(); loadAll(); }
        else {
            document.getElementById('loginError').textContent = 'Invalid password';
            document.getElementById('loginError').classList.remove('hidden');
        }
    }

    async function doLogout() {
        await api('/admin/api/logout', { method: 'POST' });
        showLogin();
    }

    // --- Tabs ---
    function switchTab(el) {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        el.classList.add('active');
        currentTab = el.dataset.tab;
        ['accounts', 'apikeys', 'models', 'settings'].forEach(t => {
            document.getElementById('tab-' + t).classList.toggle('hidden', t !== currentTab);
        });
    }

    // --- Data ---
    async function loadAll() { await loadAccounts(); await loadKeys(); await loadModels(); }

    async function loadAccounts() {
        const r = await api('/admin/api/accounts');
        if (!r.accounts) return;
        const list = document.getElementById('accountsList');
        document.getElementById('accountCount').textContent = r.accounts.length;
        if (!r.accounts.length) {
            list.innerHTML = '<div class="empty">No accounts added yet</div>';
            return;
        }
        list.innerHTML = r.accounts.map((a, i) => \`
        <div class="row" style="padding:10px 0;border-bottom:1px solid var(--border);">
        <div>
        <div style="font-size:14px;font-weight:600;">\${escapeHtml(a.email || 'Account ' + (i+1))}</div>
        <div style="font-size:12px;color:var(--muted);">Added: \${escapeHtml(new Date(a.createdAt).toLocaleString())}</div>
        </div>
        <span class="badge \${a.active ? 'green' : 'red'}">\${a.active ? 'Active' : 'Disabled'}</span>
        <button class="btn btn-danger btn-sm" onclick="delAccount(\${i})" style="flex:0;">Delete</button>
        </div>
        \`).join('');
    }

    async function delAccount(i) {
        await api('/admin/api/accounts/' + i, { method: 'DELETE' });
        toast('Account deleted');
        loadAccounts();
    }

    async function loadKeys() {
        const r = await api('/admin/api/keys');
        if (!r.keys) return;
        const list = document.getElementById('keysList');
        document.getElementById('keyCount').textContent = r.keys.length;
        if (!r.keys.length) {
            list.innerHTML = '<div class="empty">No API keys yet</div>';
            return;
        }
        list.innerHTML = r.keys.map((k, i) => \`
        <div class="row" style="padding:10px 0;border-bottom:1px solid var(--border);">
        <div>
        <div style="font-family:monospace;font-size:12px;">\${escapeHtml(k.masked_key || 'masked')}...</div>
        <div style="font-size:12px;color:var(--muted);">\${escapeHtml(k.label || '')} — usage: \${k.usage || 0}</div>
        </div>
        <span class="badge \${k.active ? 'green' : 'red'}">\${k.active ? 'Active' : 'Disabled'}</span>
        <button class="btn btn-danger btn-sm" onclick="delKey(\${i})" style="flex:0;">Delete</button>
        </div>
        \`).join('');
    }

    async function createKey() {
        const label = document.getElementById('keyLabel').value || 'default';
        const r = await api('/admin/api/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label }),
        });
        if (r.key) {
            document.getElementById('newKeyVal').textContent = r.key;
            document.getElementById('newKeyBox').classList.remove('hidden');
            toast('API key created');
            loadKeys();
        }
    }

    async function delKey(i) {
        await api('/admin/api/keys/' + i, { method: 'DELETE' });
        toast('API key deleted');
        loadKeys();
    }

    // --- Live model catalogue ---
    function renderModels(r) {
        const list = document.getElementById('modelsList');
        const error = document.getElementById('modelsError');
        document.getElementById('modelsCount').textContent = String(r.count || (r.models || []).length || 0);
        const updated = r.fetched_at ? new Date(r.fetched_at).toLocaleString() : 'not yet synced';
        document.getElementById('modelsMeta').textContent =
            'Source: ' + (r.source || 'upstream metadata not verified') +
            ' · Last sync: ' + updated +
            (r.stale ? ' · Showing cached catalogue' : '') +
            ' · Accounts checked: ' + (r.account_count || 0) +
            ' · Free-tier accounts: ' + (r.free_tier_account_count || 0) +
            ' · Non-Free accounts: ' + (r.non_free_account_count || 0) +
            ' · Accounts without verified free models: ' + (r.excluded_account_count || 0);
        if (r.error) {
            error.textContent = r.error;
            error.classList.remove('hidden');
        } else error.classList.add('hidden');
        const models = Array.isArray(r.models) ? r.models : [];
        if (!models.length) {
            list.innerHTML = '';
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'No verified free models are available. Free-tier accounts use the upstream tier-specific catalogue; non-Free accounts need explicit free/included model metadata.';
            list.appendChild(empty);
            return;
        }
        list.innerHTML = models.map(model => {
            const caps = Array.isArray(model.capabilities)
                ? model.capabilities.map(cap => '<span class="model-cap">' + escapeHtml(cap) + '</span>').join('')
                : '';
            return '<div class="model-item"><strong class="model-id">' + escapeHtml(model.id) + '</strong>' + caps + '</div>';
        }).join('');
    }

    async function loadModels() {
        const r = await api('/admin/api/models');
        if (Array.isArray(r.models)) renderModels(r);
        else renderModels({ models: [], error: r.error || 'Could not load the upstream model catalogue.' });
    }

    async function refreshModels() {
        const btn = document.getElementById('modelsRefreshBtn');
        btn.disabled = true;
        btn.textContent = 'Refreshing…';
        try {
            const r = await api('/admin/api/models/refresh', { method: 'POST' });
            renderModels(r);
            toast(r.error ? 'Model refresh completed with warnings' : 'Model catalogue refreshed');
        } catch {
            toast('Could not refresh models');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Refresh';
        }
    }

    // --- OAuth ---
    async function startOAuth() {
        const btn = document.getElementById('oauthBtn');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Requesting device code...';
        document.getElementById('oauthBox').classList.add('hidden');
        document.getElementById('oauthError').classList.add('hidden');
        document.getElementById('oauthStatus').textContent = '';

        try {
            const res = await fetch('/admin/api/oauth/start', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
            });
            const r = await res.json();
            

            if (r.error) {
                const errDiv = document.getElementById('oauthError');
                errDiv.textContent = 'OAuth error: ' + JSON.stringify(r, null, 2);
                errDiv.classList.remove('hidden');
                return;
            }

            if (r.user_code && r.device_code) {
                deviceCode = r.device_code;
                document.getElementById('oauthCode').textContent = r.user_code;

                const uri = r.verification_uri_complete || r.verification_uri || 'https://accounts.x.ai/oauth2/device';
                document.getElementById('oauthUri').href = uri;

                oauthWindow = window.open(uri, '_blank');

                if (!oauthWindow || oauthWindow.closed || typeof oauthWindow.closed === 'undefined') {
                    const errDiv = document.getElementById('oauthError');
                    errDiv.textContent = '\\u26A0\\uFE0F New tab was blocked by the browser. Please click the link above.';
                    errDiv.classList.remove('hidden');
                }

                document.getElementById('oauthBox').classList.remove('hidden');
                document.getElementById('oauthSpinner').classList.remove('hidden');
                document.getElementById('oauthStatus').textContent = 'Waiting for approval in the other tab...';

                startPolling();
            } else {
                const errDiv = document.getElementById('oauthError');
                errDiv.textContent = 'Unexpected response from server:\\n' + JSON.stringify(r, null, 2);
                errDiv.classList.remove('hidden');
            }
        } catch (e) {
            const errDiv = document.getElementById('oauthError');
            errDiv.textContent = 'Network error: ' + e.message;
            errDiv.classList.remove('hidden');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Start OAuth';
        }
    }

    function startPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(pollOAuth, 5000);
    }

    async function pollOAuth() {
        if (!deviceCode) return;
        try {
            const res = await fetch('/admin/api/oauth/poll', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ device_code: deviceCode }),
            });
            const r = await res.json();
            

            if (r.complete) {
                clearInterval(pollTimer); pollTimer = null;
                document.getElementById('oauthSpinner').classList.add('hidden');
                document.getElementById('oauthStatus').textContent = '\\u2705 Account added successfully!';
                toast('Account added successfully!');
                deviceCode = null;
                if (oauthWindow && !oauthWindow.closed) oauthWindow.close();
                loadAccounts();
                setTimeout(() => {
                    document.getElementById('oauthBox').classList.add('hidden');
                    document.getElementById('oauthStatus').textContent = '';
                }, 3000);
            } else if (r.error === 'authorization_pending') {
                document.getElementById('oauthStatus').textContent = 'Waiting for your approval...';
            } else if (r.error === 'slow_down') {
                document.getElementById('oauthStatus').textContent = 'Please wait a moment...';
            } else if (r.error === 'expired_token') {
                clearInterval(pollTimer); pollTimer = null;
                document.getElementById('oauthSpinner').classList.add('hidden');
                document.getElementById('oauthError').textContent = 'Device code expired. Please try again.';
                document.getElementById('oauthError').classList.remove('hidden');
            } else if (r.error) {
                document.getElementById('oauthStatus').textContent = 'Error: ' + (r.error_description || r.error);
            }
        } catch (e) {
            console.error(e);
        }
    }

    // --- Password ---
    async function changePass() {
        const oldP = document.getElementById('oldPass').value;
        const newP = document.getElementById('newPass').value;
        const r = await api('/admin/api/password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ old: oldP, new: newP }),
        });
        const msg = document.getElementById('passMsg');
        if (r.ok) {
            msg.textContent = '\\u2705 Password changed';
            msg.style.color = 'var(--accent2)';
            document.getElementById('oldPass').value = '';
            document.getElementById('newPass').value = '';
        } else {
            msg.textContent = '\\u274C ' + (r.error || 'Error');
            msg.style.color = 'var(--danger)';
        }
        msg.classList.remove('hidden');
    }

    // --- Init ---
    checkAuth();
    </script>
    </body>
    </html>`;
}

// ============================================================
//  Main Handler
// ============================================================
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;

        // Prevent cross-origin cookie-authenticated mutations to the admin API.
        if (path.startsWith('/admin/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
            const origin = request.headers.get('Origin');
            if (origin && origin !== url.origin) return json({ error: 'invalid_origin' }, 403);
        }

        // ---------- CORS preflight ----------
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                },
            });
        }

        // ================= ADMIN PANEL =================
        if (path === '/admin' || path === '/admin/') {
            return html(adminPage());
        }

        // ---------- Admin API: Check ----------
        if (path === '/admin/api/check') {
            const configuredPassword = await kvGet(env, 'auth:password', null);
            if (!configuredPassword) return json({ ok: false, setup_required: true });
            const ok = await requireAdmin(request, env);
            return json({ ok, setup_required: false });
        }

        // ---------- Admin API: Login ----------
        if (path === '/admin/api/login' && request.method === 'POST') {
            const configuredPassword = await kvGet(env, 'auth:password', null);
            if (!configuredPassword) return json({ ok: false, setup_required: true }, 428);
            let payload;
            try { payload = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
            const password = typeof payload.password === 'string' ? payload.password : '';
            const ip = (request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 100);
            const rateKey = 'login:attempts:' + ip;
            const now = Date.now();
            let attempts = await kvGet(env, rateKey, { start: now, count: 0 });
            if (!attempts || now - Number(attempts.start || 0) >= 15 * 60 * 1000) attempts = { start: now, count: 0 };
            if (Number(attempts.count || 0) >= 8) {
                return json({ ok: false, error: 'too_many_attempts', message: 'Too many failed login attempts. Try again later.' }, 429);
            }
            if (password !== configuredPassword) {
                attempts.count = Number(attempts.count || 0) + 1;
                await env.GROK_KV.put(rateKey, JSON.stringify(attempts), { expirationTtl: 900 });
                return json({ ok: false, error: 'invalid_password' }, 401);
            }
            await kvDel(env, rateKey);
            const token = await createSession(env);
            const secure = url.protocol === 'https:' ? '; Secure' : '';
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Set-Cookie': 'grok_session=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + SESSION_TTL + secure,
                },
            });
        }

        // ---------- First-run password setup ----------
        if (path === '/admin/api/setup' && request.method === 'POST') {
            const configuredPassword = await kvGet(env, 'auth:password', null);
            if (configuredPassword) return json({ ok: false, error: 'already_configured' }, 409);
            let payload;
            try { payload = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
            const requiredSecret = typeof env.ADMIN_SETUP_SECRET === 'string' ? env.ADMIN_SETUP_SECRET : '';
            if (requiredSecret.length < 32) {
                return json({ ok: false, error: 'setup_secret_not_configured', message: 'Set the ADMIN_SETUP_SECRET Worker secret to at least 32 characters before initial setup.' }, 503);
            }
            const providedSecret = typeof payload.secret === 'string' ? payload.secret : '';
            if (!constantTimeEqual(providedSecret, requiredSecret)) {
                return json({ ok: false, error: 'invalid_setup_secret', message: 'The one-time setup secret is incorrect.' }, 403);
            }
            const origin = request.headers.get('Origin');
            if (origin && origin !== url.origin) return json({ ok: false, error: 'invalid_origin' }, 403);
            const password = typeof payload.password === 'string' ? payload.password : '';
            if (password.length < 12) {
                return json({ ok: false, error: 'weak_password', message: 'Use a password of at least 12 characters.' }, 400);
            }
            await kvPut(env, 'auth:password', password);
            const token = await createSession(env);
            const secure = url.protocol === 'https:' ? '; Secure' : '';
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Set-Cookie': 'grok_session=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + SESSION_TTL + secure,
                },
            });
        }

        // ---------- Admin API: Logout ----------
        if (path === '/admin/api/logout' && request.method === 'POST') {
            const token = getCookie(request, 'grok_session');
            if (token) await kvDel(env, `session:${token}`);
            const secure = url.protocol === 'https:' ? '; Secure' : '';
            return new Response(JSON.stringify({ ok: true }), {
                headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'grok_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + secure },
            });
        }

        // ---------- Admin API: Authenticated routes ----------
        if (path.startsWith('/admin/api/')) {
            const authed = await requireAdmin(request, env);
            if (!authed) return json({ error: 'unauthorized' }, 401);

            // --- Live Models ---
            if ((path === '/admin/api/models' && request.method === 'GET') || (path === '/admin/api/models/refresh' && request.method === 'POST')) {
                const catalog = await getFreeModelCatalog(env, request.method === 'POST');
                return json({
                    models: (catalog.models || []).map(model => ({
                        id: model.id,
                        name: typeof model.name === 'string' ? model.name : model.id,
                        description: typeof model.description === 'string' ? model.description : null,
                        capabilities: Array.isArray(model.capabilities) ? model.capabilities : [],
                        created: Number.isFinite(model.created) ? model.created : null,
                        owned_by: typeof model.owned_by === 'string' ? model.owned_by : 'xai',
                    })),
                    count: (catalog.models || []).length,
                    fetched_at: catalog.fetchedAt || null,
                    source: catalog.source || null,
                    verified: !!catalog.verified,
                    stale: !!catalog.stale,
                    error: catalog.error || null,
                    account_count: catalog.accountCount || 0,
                    free_tier_account_count: catalog.freeTierAccountCount || 0,
                    non_free_account_count: catalog.nonFreeAccountCount || 0,
                    excluded_account_count: catalog.excludedAccountCount || 0,
                });
            }

            // --- Accounts ---
            if (path === '/admin/api/accounts' && request.method === 'GET') {
                const accounts = await kvGet(env, 'accounts:list', []);
                return json({
                    accounts: accounts.map(a => ({
                        email: a.email,
                        active: a.active,
                        createdAt: a.createdAt,
                    })),
                });
            }

            if (path.startsWith('/admin/api/accounts/') && request.method === 'DELETE') {
                const idx = parseInt(path.split('/').pop());
                const accounts = await kvGet(env, 'accounts:list', []);
                if (idx >= 0 && idx < accounts.length) accounts.splice(idx, 1);
                await kvPut(env, 'accounts:list', accounts);
                return json({ ok: true });
            }

            // --- API Keys ---
            if (path === '/admin/api/keys' && request.method === 'GET') {
                const keys = await kvGet(env, 'apikeys:list', []);
                return json({ keys: keys.map(k => ({ label: k.label, createdAt: k.createdAt, active: !!k.active, usage: k.usage || 0, masked_key: k.key ? k.key.slice(0, 7) + '…' + k.key.slice(-4) : '' })) });
            }

            if (path === '/admin/api/keys' && request.method === 'POST') {
                let payload;
                try { payload = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
                const label = typeof payload.label === 'string' ? payload.label.trim().slice(0, 80) || 'default' : 'default';
                const key = await generateApiKey(env, label);
                return json({ key });
            }

            if (path.startsWith('/admin/api/keys/') && request.method === 'DELETE') {
                const idx = parseInt(path.split('/').pop());
                const keys = await kvGet(env, 'apikeys:list', []);
                if (idx >= 0 && idx < keys.length) keys.splice(idx, 1);
                await kvPut(env, 'apikeys:list', keys);
                return json({ ok: true });
            }

            // --- OAuth ---
            if (path === '/admin/api/oauth/start' && request.method === 'POST') {
                const data = await oauthDeviceStart(env);
                
                return json(data);
            }

            if (path === '/admin/api/oauth/poll' && request.method === 'POST') {
                let payload;
                try { payload = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
                const device_code = typeof payload.device_code === 'string' ? payload.device_code : '';
                if (!device_code || device_code.length > 4096) return json({ error: 'invalid_device_code' }, 400);
                const data = await oauthDevicePoll(env, device_code);

                if (data.access_token) {
                    const accounts = await kvGet(env, 'accounts:list', []);
                    accounts.push({
                        email: data.email || 'grok-' + Date.now(),
                        user_id: data.user_id || data.userId || data.sub || accountUserId({ access_token: data.access_token }) || null,
                        access_token: data.access_token,
                        refresh_token: data.refresh_token || null,
                        expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
                        active: true,
                        createdAt: Date.now(),
                        lastUsed: null,
                    });
                    await kvPut(env, 'accounts:list', accounts);
                    return json({ ok: true, complete: true });
                }
                return json({ error: data.error || 'authorization_pending', error_description: data.error_description || null });
            }

            // --- Password ---
            if (path === '/admin/api/password' && request.method === 'POST') {
                let payload;
                try { payload = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
                const old = typeof payload.old === 'string' ? payload.old : '';
                const newPass = typeof payload.new === 'string' ? payload.new : '';
                const stored = await kvGet(env, 'auth:password', null);
                if (!stored || old !== stored) return json({ ok: false, error: 'Current password is incorrect' }, 400);
                if (newPass.length < 12) return json({ ok: false, error: 'New password must be at least 12 characters' }, 400);
                await kvPut(env, 'auth:password', newPass);
                return json({ ok: true });
            }

            return json({ error: 'not found' }, 404);
        }

        // ================= OPENAI-COMPATIBLE API =================
        if (path === '/v1/chat/completions' || path === '/v1/models') {
            // Validate API key
            const authed = await validateApiKey(env, request.headers.get('Authorization'));
            if (!authed) {
                return json({
                    error: {
                        message: 'Invalid API key. Get one from /admin \u2192 API Keys.',
                        type: 'auth_error',
                        code: 'invalid_api_key',
                    },
                }, 401);
            }

            // ---------- Live, verified free-model endpoint ----------
            if (path === '/v1/models') {
                const catalog = await getFreeModelCatalog(env);
                if (!catalog.models.length) {
                    return json({
                        error: {
                            message: 'Could not verify free model availability from the upstream service. ' + (catalog.error || ''),
                            type: 'server_error',
                            code: 'free_model_catalog_unavailable',
                        },
                    }, 503);
                }
                const capFilter = url.searchParams.get('capability');
                let models = catalog.models;
                if (capFilter) models = models.filter(model => (model.capabilities || []).includes(capFilter));
                return json({
                    object: 'list',
                    data: models.map(model => ({
                        id: model.id,
                        object: 'model',
                        created: Number.isFinite(model.created) ? model.created : undefined,
                        owned_by: model.owned_by || 'xai',
                        ...(Array.isArray(model.capabilities) && model.capabilities.length ? { capabilities: model.capabilities } : {}),
                    })),
                });
            }

            // ---------- Chat completions ----------
            let body;
            try {
                body = await request.json();
            } catch (e) {
                return json({ error: { message: 'Invalid JSON body: ' + e.message, type: 'invalid_request_error' } }, 400);
            }
            if (!body || typeof body.model !== 'string' || !body.model.trim()) {
                return json({ error: { message: 'A model ID is required.', type: 'invalid_request_error', code: 'model_required' } }, 400);
            }
            if (!Array.isArray(body.messages)) {
                return json({ error: { message: 'messages must be an array.', type: 'invalid_request_error', code: 'invalid_messages' } }, 400);
            }

            const account = await pickAccountForModel(env, body.model);
            if (!account) {
                const catalog = await getFreeModelCatalog(env);
                if (!catalog.models.length) {
                    return json({
                        error: {
                            message: 'Could not verify free model eligibility. ' + (catalog.error || ''),
                            type: 'server_error',
                            code: 'free_model_catalog_unavailable',
                        },
                    }, 503);
                }
                return json({
                    error: {
                        message: 'The requested model is unavailable or is not verified as free/included for the configured Grok accounts.',
                        type: 'invalid_request_error',
                        code: 'model_not_allowed',
                    },
                }, 400);
            }

            let upstreamResult;
            try {
                upstreamResult = await fetchAccountRequest(env, account, GROK_UPSTREAM + '/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'x-grok-model-override': body.model,
                        'x-grok-session-id': randomHex(16),
                        'x-grok-conv-id': randomHex(16),
                    },
                    body: JSON.stringify(body),
                });
            } catch (error) {
                return json({
                    error: {
                        message: 'The Grok upstream request failed or timed out.',
                        type: 'server_error',
                        code: 'upstream_request_failed',
                    },
                }, 502);
            }
            const upstreamRes = upstreamResult.response;

            // Increment usage counter
            const keys = await kvGet(env, 'apikeys:list', []);
            const authKey = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
            const usedKey = keys.find(k => k.key === authKey);
            if (usedKey) {
                usedKey.usage = (usedKey.usage || 0) + 1;
                await kvPut(env, 'apikeys:list', keys);
            }

            // Stream passthrough
            return new Response(upstreamRes.body, {
                status: upstreamRes.status,
                headers: {
                    'Content-Type': upstreamRes.headers.get('Content-Type') || 'application/json',
                                'Access-Control-Allow-Origin': '*',
                                'Cache-Control': 'no-cache',
                },
            });
        }

        // ================= ROOT =================
        if (path === '/' || path === '') {
            return Response.redirect(url.origin + '/admin', 302);
        }

        return json({ error: 'not found', path }, 404);
    },
};

export { constantTimeEqual, explicitFreeState, isApiModelSelectable, normalizeModelPayload, subscriptionTierStatus, grokHeaders };
