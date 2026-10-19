import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker, {
  explicitFreeState,
  modeAvailability,
  normalizeModelPayload,
  grokHeaders,
} from '../worker.js';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

test('Grok client identity headers use the requested exact values', () => {
  const headers = grokHeaders('test-token');
  assert.equal(headers['User-Agent'], 'grok-shell/1.0.44 (linux; x86_64)');
  assert.equal(headers['x-grok-client-identifier'], 'grok-shell');
  assert.equal(headers['x-grok-client-version'], '1.0.44');
  assert.equal(headers['X-XAI-Token-Auth'], 'xai-grok-cli');
  assert.equal(headers.Authorization, 'Bearer test-token');
});

test('model payload normalization accepts known shapes and drops invalid/duplicate IDs', () => {
  const models = normalizeModelPayload({
    object: 'list',
    data: [
      { id: 'free-a', capabilities: ['text'] },
      { id: 'free-a', capabilities: ['image'] },
      { name: 'missing-id' },
      { id: ' paid-b ' },
    ],
  });
  assert.deepEqual(models.map(model => model.id), ['free-a', 'paid-b']);
  assert.equal(models[0].object, 'model');
  assert.deepEqual(models[1].capabilities, []);
});

test('free eligibility fails closed when upstream metadata is missing', () => {
  assert.equal(explicitFreeState({ id: 'free-a', is_free: true }), true);
  assert.equal(explicitFreeState({ id: 'paid-a', is_free: false }), false);
  assert.equal(explicitFreeState({ id: 'unknown-a' }), null);
  assert.equal(explicitFreeState({ id: 'included-a', billingTier: 'included' }), true);
  assert.equal(explicitFreeState({ id: 'paid-b', billingTier: 'premium' }), false);
});

test('mode availability is not itself treated as proof that a model is free', () => {
  assert.equal(modeAvailability({ availability: { available: {} } }), 'available');
  assert.equal(modeAvailability({ availability: { requiresUpgrade: {} } }), 'blocked');
  assert.equal(modeAvailability({ availability: {} }), 'unknown');
  assert.equal(explicitFreeState({ id: 'accessible-but-unknown' }), null);
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

function mockUpstream() {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === 'https://cli-chat-proxy.grok.com/v1/models') {
      return Response.json({
        object: 'list',
        data: [
          { id: 'free-model', is_free: true, capabilities: ['text'] },
          { id: 'paid-model', is_free: false, capabilities: ['text'] },
          { id: 'unknown-model', capabilities: ['text'] },
        ],
      });
    }
    if (url === 'https://grok.com/rest/modes') {
      return Response.json({
        modes: [
          { id: 'free-model', availability: { available: {} } },
          { id: 'paid-model', availability: { requiresUpgrade: {} } },
          { id: 'unknown-model', availability: { available: {} } },
        ],
      });
    }
    if (url === 'https://cli-chat-proxy.grok.com/v1/chat/completions') {
      return Response.json({
        id: 'chat-test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      });
    }
    throw new Error('Unexpected upstream URL: ' + url);
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

function apiRequest(path, body) {
  return new Request('https://proxy.example.test' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: 'Bearer gk_test',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('public models endpoint returns only explicitly free models with eligible account access', async () => {
  const env = makeEnv();
  const upstream = mockUpstream();
  try {
    const response = await worker.fetch(apiRequest('/v1/models'), env);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.data.map(model => model.id), ['free-model']);
  } finally {
    upstream.restore();
  }
});

test('chat rejects paid/unknown models even when they appear in upstream model lists', async () => {
  const env = makeEnv();
  const upstream = mockUpstream();
  try {
    // Warm the live model cache with mocked upstream metadata.
    const listed = await worker.fetch(apiRequest('/v1/models'), env);
    assert.equal(listed.status, 200);

    const response = await worker.fetch(apiRequest('/v1/chat/completions', {
      model: 'paid-model',
      messages: [{ role: 'user', content: 'hello' }],
    }), env);
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, 'model_not_allowed');
    assert.equal(upstream.calls.some(call => call.url.endsWith('/v1/chat/completions')), false);
  } finally {
    upstream.restore();
  }
});

test('chat forwards exact client headers and the validated model override', async () => {
  const env = makeEnv();
  const upstream = mockUpstream();
  try {
    const listed = await worker.fetch(apiRequest('/v1/models'), env);
    assert.equal(listed.status, 200);

    const response = await worker.fetch(apiRequest('/v1/chat/completions', {
      model: 'free-model',
      messages: [{ role: 'user', content: 'hello' }],
    }), env);
    assert.equal(response.status, 200);
    const chatCall = upstream.calls.find(call => call.url.endsWith('/v1/chat/completions'));
    assert.ok(chatCall);
    assert.equal(chatCall.init.headers['User-Agent'], 'grok-shell/1.0.44 (linux; x86_64)');
    assert.equal(chatCall.init.headers['x-grok-client-identifier'], 'grok-shell');
    assert.equal(chatCall.init.headers['x-grok-client-version'], '1.0.44');
    assert.equal(chatCall.init.headers['x-grok-model-override'], 'free-model');
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

test('constant-time comparison helper rejects mismatched setup secrets', async () => {
  const { constantTimeEqual } = await import('../worker.js');
  assert.equal(constantTimeEqual('same-secret', 'same-secret'), true);
  assert.equal(constantTimeEqual('same-secret', 'different-secret'), false);
});
