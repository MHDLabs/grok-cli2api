import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker, {
  constantTimeEqual,
  grokHeaders,
  passthroughUpstreamResponse,
} from '../worker.js';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

test('Grok client identity headers match the expected CLI identity', () => {
  const headers = grokHeaders('test-token');
  assert.equal(headers['User-Agent'], 'grok-shell/1.0.44 (linux; x86_64)');
  assert.equal(headers['x-grok-client-identifier'], 'grok-shell');
  assert.equal(headers['x-grok-client-version'], '1.0.44');
  assert.equal(headers['X-XAI-Token-Auth'], 'xai-grok-cli');
  assert.equal(headers.Authorization, 'Bearer test-token');
});

test('upstream response passthrough preserves status, body and relevant headers', async () => {
  const upstream = new Response('{"error":{"code":"model_not_found"}}', {
    status: 404,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': '2',
      'X-Request-Id': 'upstream-request-123',
    },
  });
  const response = passthroughUpstreamResponse(upstream);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), '{"error":{"code":"model_not_found"}}');
  assert.equal(response.headers.get('Content-Type'), 'application/json');
  assert.equal(response.headers.get('Retry-After'), '2');
  assert.equal(response.headers.get('X-Request-Id'), 'upstream-request-123');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
});

function makeEnv() {
  const state = new Map([
    ['apikeys:list', JSON.stringify([{ key: 'gk_test', label: 'tests', active: true, usage: 0 }])],
    ['accounts:list', JSON.stringify([{
      email: 'test@example.invalid',
      user_id: 'test-user',
      access_token: 'mock-access-token',
      refresh_token: null,
      active: true,
      createdAt: 1,
      lastUsed: 0,
    }])],
  ]);
  return {
    state,
    GROK_KV: {
      async get(key) { return state.has(key) ? state.get(key) : null; },
      async put(key, value) { state.set(key, String(value)); },
      async delete(key) { state.delete(key); },
    },
  };
}

function mockUpstream({ modelsResponse, chatResponse } = {}) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === 'https://cli-chat-proxy.grok.com/v1/models') {
      return modelsResponse || Response.json({
        object: 'list',
        data: [
          { id: 'paid-looking-model', is_free: false },
          { id: 'hidden-model', hidden: true },
          { id: 'model-without-eligibility-metadata' },
        ],
      });
    }
    if (url === 'https://cli-chat-proxy.grok.com/v1/chat/completions') {
      return chatResponse || Response.json({
        id: 'chat-test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'real upstream response' }, finish_reason: 'stop' }],
      });
    }
    throw new Error('Unexpected upstream URL: ' + url);
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

function apiRequest(path, body, method) {
  const requestMethod = method || (body === undefined ? 'GET' : 'POST');
  return new Request('https://proxy.example.test' + path, {
    method: requestMethod,
    headers: {
      Authorization: 'Bearer gk_test',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

test('/v1/models returns the exact upstream model list without local free/hidden filtering', async () => {
  const env = makeEnv();
  const upstreamBody = JSON.stringify({
    object: 'list',
    data: [
      { id: 'paid-looking-model', is_free: false },
      { id: 'hidden-model', hidden: true },
      { id: 'model-without-eligibility-metadata' },
    ],
    extra_upstream_field: { keep: true },
  });
  const upstream = mockUpstream({
    modelsResponse: new Response(upstreamBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'models-123' },
    }),
  });
  try {
    const response = await worker.fetch(apiRequest('/v1/models'), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), upstreamBody);
    assert.equal(response.headers.get('X-Request-Id'), 'models-123');

    const call = upstream.calls.find(item => item.url.endsWith('/v1/models'));
    assert.ok(call, 'the real upstream /v1/models endpoint must be called');
    assert.equal(call.init.headers.Authorization, 'Bearer mock-access-token');
    assert.equal(call.init.headers['x-userid'], 'test-user');
    assert.equal(call.init.headers['x-email'], 'test@example.invalid');
  } finally {
    upstream.restore();
  }
});

test('/v1/models preserves the actual upstream 404 instead of synthesizing a local response', async () => {
  const env = makeEnv();
  const body = '{"error":{"code":"model_not_found","message":"upstream model catalog unavailable"}}';
  const upstream = mockUpstream({
    modelsResponse: new Response(body, { status: 404, headers: { 'Content-Type': 'application/json' } }),
  });
  try {
    const response = await worker.fetch(apiRequest('/v1/models'), env);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), body);
  } finally {
    upstream.restore();
  }
});

test('chat request for an unknown model reaches Grok and returns its real model_not_found response', async () => {
  const env = makeEnv();
  const upstreamBody = '{"error":{"code":"model_not_found","message":"model not found at upstream"}}';
  const upstream = mockUpstream({
    chatResponse: new Response(upstreamBody, {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'chat-upstream-404' },
    }),
  });
  try {
    const requestBody = {
      model: 'model-id-not-present-in-any-local-list',
      messages: [{ role: 'user', content: 'test' }],
      temperature: 0.2,
    };
    const response = await worker.fetch(apiRequest('/v1/chat/completions', requestBody), env);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), upstreamBody);
    assert.equal(response.headers.get('X-Request-Id'), 'chat-upstream-404');

    const call = upstream.calls.find(item => item.url.endsWith('/v1/chat/completions'));
    assert.ok(call, 'the chat request must reach Grok even when the model is not in a local catalog');
    assert.equal(call.init.headers['x-grok-model-override'], requestBody.model);
    assert.equal(call.init.headers.Authorization, 'Bearer mock-access-token');
    assert.equal(call.init.headers['x-userid'], 'test-user');
    assert.equal(call.init.headers['x-email'], 'test@example.invalid');
    assert.equal(call.init.body, JSON.stringify(requestBody));
  } finally {
    upstream.restore();
  }
});

test('successful chat returns the real upstream response and increments API-key usage', async () => {
  const env = makeEnv();
  const upstreamBody = '{"id":"real-upstream-result","choices":[{"message":{"role":"assistant","content":"hello from Grok"}}]}';
  const upstream = mockUpstream({
    chatResponse: new Response(upstreamBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  try {
    const response = await worker.fetch(apiRequest('/v1/chat/completions', {
      model: 'whatever-the-upstream-accepts',
      messages: [{ role: 'user', content: 'hello' }],
    }), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), upstreamBody);
    const keys = JSON.parse(await env.GROK_KV.get('apikeys:list'));
    assert.equal(keys[0].usage, 1);
  } finally {
    upstream.restore();
  }
});

test('public API rejects unsupported HTTP methods without contacting Grok', async () => {
  const env = makeEnv();
  const upstream = mockUpstream();
  try {
    const modelsResponse = await worker.fetch(apiRequest('/v1/models', '{}', 'POST'), env);
    assert.equal(modelsResponse.status, 405);
    assert.equal((await modelsResponse.json()).error.code, 'method_not_allowed');

    const chatResponse = await worker.fetch(apiRequest('/v1/chat/completions', undefined, 'GET'), env);
    assert.equal(chatResponse.status, 405);
    assert.equal((await chatResponse.json()).error.code, 'method_not_allowed');
    assert.equal(upstream.calls.length, 0);
  } finally {
    upstream.restore();
  }
});

test('first-run setup fails closed unless the deployment secret is configured', async () => {
  const env = makeEnv();
  const response = await worker.fetch(new Request('https://proxy.example.test/admin/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://proxy.example.test' },
    body: JSON.stringify({ secret: 'attacker-secret', password: 'a-long-random-password' }),
  }), env);
  assert.equal(response.status, 503);
  assert.equal(await env.GROK_KV.get('auth:password'), null);
});

test('first-run setup requires the deployment secret and a strong password', async () => {
  const env = makeEnv();
  env.ADMIN_SETUP_SECRET = 'z'.repeat(40);
  const bad = await worker.fetch(new Request('https://proxy.example.test/admin/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://proxy.example.test' },
    body: JSON.stringify({ secret: 'wrong-secret', password: 'a-long-random-password' }),
  }), env);
  assert.equal(bad.status, 403);
  assert.equal(await env.GROK_KV.get('auth:password'), null);

  const good = await worker.fetch(new Request('https://proxy.example.test/admin/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://proxy.example.test' },
    body: JSON.stringify({ secret: env.ADMIN_SETUP_SECRET, password: 'a-long-random-password' }),
  }), env);
  assert.equal(good.status, 200);
  assert.equal((await good.json()).ok, true);
  assert.equal(JSON.parse(await env.GROK_KV.get('auth:password')), 'a-long-random-password');
  assert.match(good.headers.get('set-cookie'), /HttpOnly/);
  assert.match(good.headers.get('set-cookie'), /SameSite=Strict/);
});

test('constant-time comparison helper rejects mismatched setup secrets', () => {
  assert.equal(constantTimeEqual('same-secret', 'same-secret'), true);
  assert.equal(constantTimeEqual('same-secret', 'different-secret'), false);
});

test('cross-origin admin mutations are rejected before auth or state changes', async () => {
  const env = makeEnv();
  const before = JSON.parse(await env.GROK_KV.get('apikeys:list'));
  const response = await worker.fetch(new Request('https://proxy.example.test/admin/api/keys', {
    method: 'POST',
    headers: {
      Origin: 'https://attacker.example',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ label: 'attacker-key' }),
  }), env);
  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(await env.GROK_KV.get('apikeys:list')), before);
});

test('admin API never returns stored API key material', async () => {
  const env = makeEnv();
  await env.GROK_KV.put('auth:password', JSON.stringify('strong test password 123'));
  const login = await worker.fetch(new Request('https://proxy.example.test/admin/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'strong test password 123' }),
  }), env);
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const response = await worker.fetch(new Request('https://proxy.example.test/admin/api/keys', {
    headers: { Cookie: cookie },
  }), env);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.keys[0].key, undefined);
  assert.equal(payload.keys[0].masked_key, 'gk_test…test');
});
