// ============================================================
//  Grok CLI → OpenAI Compatible Proxy
//  ------------------------------------------------------------
//  A single-file Cloudflare Worker that turns Grok CLI into a
//  fully OpenAI-compatible API with:
//    • Dark, modern admin panel (Grok-like theme)
//    • OAuth 2.0 Device Code Flow for Grok CLI login
//    • Multi-account support with automatic Round-Robin
//    • Dedicated API keys with usage tracking
//    • KV-only storage (no environment variables required)
//    • Full /v1/chat/completions and /v1/models endpoints
//
//  Repository: https://github.com/MHDLabs/grok-cli2api
//  License:    MIT
//  Author:     MHDLabs
// ============================================================

const DEFAULT_PASSWORD = '123456';
const SESSION_TTL = 86400; // 24h
const GROK_UPSTREAM = 'https://cli-chat-proxy.grok.com';
const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const GROK_SCOPE = 'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write';
const OIDC_DISCOVERY = 'https://auth.x.ai/.well-known/openid-configuration';

// ---------- Grok Client Identity (required by upstream) ----------
const GROK_CLIENT_VERSION = '1.0.44';
const GROK_CLIENT_IDENTIFIER = 'grok-shell';
const GROK_USER_AGENT = 'grok-shell/1.0.44 (linux; x86_64)';

// ---------- Static Model Catalog ----------
const GROK_MODELS = [
    // Flagship & Latest
    { id: 'grok-4.7', object: 'model', created: 1780000000, owned_by: 'xai', context_length: 500000, capabilities: ['text', 'image', 'reasoning', 'tools'] },
{ id: 'grok-4.6', object: 'model', created: 1770000000, owned_by: 'xai', context_length: 500000, capabilities: ['text', 'image', 'reasoning', 'tools'] },
{ id: 'grok-4.5', object: 'model', created: 1760000000, owned_by: 'xai', context_length: 500000, capabilities: ['text', 'image', 'reasoning', 'tools'] },
{ id: 'grok-4.3', object: 'model', created: 1750000000, owned_by: 'xai', context_length: 1000000, capabilities: ['text', 'image', 'reasoning', 'tools'] },

// Grok 4.20 Series
{ id: 'grok-4.20-reasoning', object: 'model', created: 1748000000, owned_by: 'xai', context_length: 1000000, capabilities: ['text', 'image', 'reasoning', 'tools'] },
{ id: 'grok-4.20-non-reasoning', object: 'model', created: 1748000000, owned_by: 'xai', context_length: 1000000, capabilities: ['text', 'image', 'tools'] },
{ id: 'grok-4.20-multi-agent-0309', object: 'model', created: 1748000000, owned_by: 'xai', context_length: 1000000, capabilities: ['text', 'image', 'reasoning', 'tools'] },

// Grok 4 Series
{ id: 'grok-4', object: 'model', created: 1730000000, owned_by: 'xai', context_length: 131072, capabilities: ['text', 'image', 'reasoning', 'tools'] },
{ id: 'grok-4-latest', object: 'model', created: 1730000000, owned_by: 'xai', context_length: 131072, capabilities: ['text', 'image', 'reasoning', 'tools'] },
{ id: 'grok-4-0709', object: 'model', created: 1720000000, owned_by: 'xai', context_length: 131072, capabilities: ['text', 'image', 'reasoning', 'tools'] },
{ id: 'grok-4-fast-reasoning', object: 'model', created: 1730000000, owned_by: 'xai', context_length: 131072, capabilities: ['text', 'reasoning', 'tools'] },
{ id: 'grok-4-fast-non-reasoning', object: 'model', created: 1730000000, owned_by: 'xai', context_length: 131072, capabilities: ['text', 'tools'] },
{ id: 'grok-4-1-fast-reasoning', object: 'model', created: 1735000000, owned_by: 'xai', context_length: 2000000, capabilities: ['text', 'reasoning', 'tools'] },
{ id: 'grok-4-1-fast-non-reasoning', object: 'model', created: 1735000000, owned_by: 'xai', context_length: 2000000, capabilities: ['text', 'tools'] },

// Grok Build (Coding)
{ id: 'grok-build-0.1', object: 'model', created: 1745000000, owned_by: 'xai', context_length: 256000, capabilities: ['text', 'reasoning', 'tools'] },
{ id: 'grok-code-fast-1', object: 'model', created: 1730000000, owned_by: 'xai', context_length: 131072, capabilities: ['text', 'tools'] },
{ id: 'grok-code-fast', object: 'model', created: 1725000000, owned_by: 'xai', context_length: 131072, capabilities: ['text', 'tools'] },

// Grok 3 Series
{ id: 'grok-3', object: 'model', created: 1710000000, owned_by: 'xai', context_length: 131072, capabilities: ['text', 'tools'] },
{ id: 'grok-3-latest', object: 'model', created: 1710000000, owned_by: 'xai', context_length: 131072, capabilities: ['text', 'tools'] },
{ id: 'grok-3-fast', object: 'model', created: 1710000000, owned_by: 'xai', context_length: 131072, capabilities: ['text', 'tools'] },
{ id: 'grok-3-mini', object: 'model', created: 1710000000, owned_by: 'xai', context_length: 131072, capabilities: ['text', 'reasoning', 'tools'] },
{ id: 'grok-3-mini-fast', object: 'model', created: 1710000000, owned_by: 'xai', context_length: 131072, capabilities: ['text', 'reasoning', 'tools'] },

// Grok 2 Series (Legacy)
{ id: 'grok-2-image-1212', object: 'model', created: 1700000000, owned_by: 'xai', capabilities: ['image'] },

// Imagine (Image / Video)
{ id: 'grok-imagine-image', object: 'model', created: 1769472000, owned_by: 'xai', capabilities: ['image'] },
{ id: 'grok-imagine-image-quality', object: 'model', created: 1769472000, owned_by: 'xai', capabilities: ['image'] },
{ id: 'grok-imagine-image-2.0', object: 'model', created: 1770000000, owned_by: 'xai', capabilities: ['image'] },
{ id: 'grok-imagine-video', object: 'model', created: 1769472000, owned_by: 'xai', capabilities: ['video'] },
{ id: 'grok-imagine-video-1.5', object: 'model', created: 1770000000, owned_by: 'xai', capabilities: ['video'] },

// Voice
{ id: 'grok-voice-think-fast-2.0', object: 'model', created: 1770000000, owned_by: 'xai', capabilities: ['audio'] },
];

// ============================================================
//  Utilities
// ============================================================
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

function grokHeaders(accessToken) {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': GROK_USER_AGENT,
        'x-grok-client-version': GROK_CLIENT_VERSION,
        'x-grok-client-identifier': GROK_CLIENT_IDENTIFIER,
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
        console.log('OAuth device start:', res.status, text);

        if (!res.ok) {
            return { error: 'device_code_request_failed', status: res.status, raw: text };
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch {
            return { error: 'invalid_json', raw: text };
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
        console.log('OAuth poll:', res.status, text);

        try {
            return JSON.parse(text);
        } catch {
            return { error: 'invalid_json', raw: text };
        }
    } catch (e) {
        return { error: 'exception', message: String(e) };
    }
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

    <!-- DASHBOARD -->
    <div id="dashView" class="container hidden">
    <div class="header">
    <div class="logo"><div class="logo-icon">&#9889;</div> Grok Proxy</div>
    <button class="logout-btn" onclick="doLogout()">Logout</button>
    </div>

    <div class="tabs">
    <button class="tab active" data-tab="accounts" onclick="switchTab(this)">Accounts</button>
    <button class="tab" data-tab="apikeys" onclick="switchTab(this)">API Keys</button>
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
        if (r.ok) { showDash(); loadAll(); } else { showLogin(); }
    }

    function showLogin() {
        document.getElementById('loginView').classList.remove('hidden');
        document.getElementById('dashView').classList.add('hidden');
    }

    function showDash() {
        document.getElementById('loginView').classList.add('hidden');
        document.getElementById('dashView').classList.remove('hidden');
        document.getElementById('proxyUrl').textContent = location.origin + '/v1/chat/completions';
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
        ['accounts', 'apikeys', 'settings'].forEach(t => {
            document.getElementById('tab-' + t).classList.toggle('hidden', t !== currentTab);
        });
    }

    // --- Data ---
    async function loadAll() { await loadAccounts(); await loadKeys(); }

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
        <div style="font-size:14px;font-weight:600;">\${a.email || 'Account ' + (i+1)}</div>
        <div style="font-size:12px;color:var(--muted);">Added: \${new Date(a.createdAt).toLocaleString()}</div>
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
        <div style="font-family:monospace;font-size:12px;">\${k.key.substring(0,20)}...</div>
        <div style="font-size:12px;color:var(--muted);">\${k.label} — usage: \${k.usage || 0}</div>
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
            console.log('OAuth start response:', r);

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
            console.log('OAuth poll:', r);

            if (r.access_token) {
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
            const ok = await requireAdmin(request, env);
            return json({ ok });
        }

        // ---------- Admin API: Login ----------
        if (path === '/admin/api/login' && request.method === 'POST') {
            const { password } = await request.json();
            const stored = await kvGet(env, 'auth:password', DEFAULT_PASSWORD);
            if (password === stored) {
                const token = await createSession(env);
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Set-Cookie': `grok_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}`,
                    },
                });
            }
            return json({ ok: false, error: 'invalid password' }, 401);
        }

        // ---------- Admin API: Logout ----------
        if (path === '/admin/api/logout' && request.method === 'POST') {
            const token = getCookie(request, 'grok_session');
            if (token) await kvDel(env, `session:${token}`);
            return new Response(JSON.stringify({ ok: true }), {
                headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'grok_session=; Path=/; Max-Age=0' },
            });
        }

        // ---------- Admin API: Authenticated routes ----------
        if (path.startsWith('/admin/api/')) {
            const authed = await requireAdmin(request, env);
            if (!authed) return json({ error: 'unauthorized' }, 401);

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
                return json({ keys });
            }

            if (path === '/admin/api/keys' && request.method === 'POST') {
                const { label } = await request.json();
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
                console.log('oauth/start result:', JSON.stringify(data));
                return json(data);
            }

            if (path === '/admin/api/oauth/poll' && request.method === 'POST') {
                const { device_code } = await request.json();
                const data = await oauthDevicePoll(env, device_code);

                if (data.access_token) {
                    const accounts = await kvGet(env, 'accounts:list', []);
                    accounts.push({
                        email: data.email || `grok-${Date.now()}`,
                                  access_token: data.access_token,
                                  refresh_token: data.refresh_token || null,
                                  expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
                                  active: true,
                                  createdAt: Date.now(),
                                  lastUsed: null,
                    });
                    await kvPut(env, 'accounts:list', accounts);
                }

                return json(data);
            }

            // --- Password ---
            if (path === '/admin/api/password' && request.method === 'POST') {
                const { old, new: newPass } = await request.json();
                const stored = await kvGet(env, 'auth:password', DEFAULT_PASSWORD);
                if (old !== stored) return json({ ok: false, error: 'Current password is incorrect' }, 400);
                if (!newPass || newPass.length < 4) return json({ ok: false, error: 'New password must be at least 4 characters' }, 400);
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

            // ---------- Models endpoint ----------
            if (path === '/v1/models') {
                const capFilter = url.searchParams.get('capability');
                let models = GROK_MODELS;
                if (capFilter) {
                    models = models.filter(m => (m.capabilities || []).includes(capFilter));
                }
                return json({ object: 'list', data: models });
            }

            // ---------- Chat completions ----------
            const account = await pickAccount(env);
            if (!account) {
                return json({
                    error: {
                        message: 'No active Grok account configured. Add one at /admin \u2192 Accounts.',
                        type: 'server_error',
                        code: 'no_account',
                    },
                }, 503);
            }

            let body;
            try {
                body = await request.json();
            } catch (e) {
                return json({ error: { message: 'Invalid JSON body: ' + e.message, type: 'invalid_request_error' } }, 400);
            }

            // Forward to Grok upstream with proper client identity headers
            const upstreamRes = await fetch(`${GROK_UPSTREAM}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    ...grokHeaders(account.access_token),
                                            'x-grok-session-id': randomHex(16),
                                            'x-grok-conv-id': randomHex(16),
                },
                body: JSON.stringify(body),
            });

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
