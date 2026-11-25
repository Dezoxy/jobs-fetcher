// Moved from claude-merge.test.mjs when the v1 merge was retired; these cover
// the shared claude-cli.mjs pieces the v2 judge uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { federationConfig, claudeEnv, entraAssertion, invokeClaude, runWithFallback } from './claude-cli.mjs';

const configured = {
  ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
  ANTHROPIC_ORGANIZATION_ID: '11111111-1111-1111-1111-111111111111',
  ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
  ANTHROPIC_FEDERATION_AUDIENCE: 'api://22222222-2222-2222-2222-222222222222',
  ANTHROPIC_FEDERATION_TENANT_ID: '33333333-3333-3333-3333-333333333333',
  ANTHROPIC_WORKSPACE_ID: 'wrkspc_test',
};

test('federation is opt-in; partial, invalid and unbounded model configurations fail', () => {
  assert.equal(federationConfig({}), null);
  assert.throws(() => federationConfig({ ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test' }), /ORGANIZATION/);
  assert.throws(() => federationConfig({ ...configured, ANTHROPIC_FEDERATION_AUDIENCE: 'https://attacker.test' }), /AUDIENCE/);
  assert.throws(() => federationConfig({ ...configured, JOBS_REFRESH_FALLBACK_MODELS: '' }), /model IDs/);
  assert.throws(() => federationConfig({ ...configured, JOBS_REFRESH_FALLBACK_MODELS: 'claude-a,claude-b,claude-c' }), /model IDs/);
  assert.deepEqual(federationConfig(configured).models, ['claude-opus-5-5', 'claude-sonnet-5-5']);
});

test('primary agent cannot silently switch billing; API agent has no subscription or Azure credentials', () => {
  const env = { ...configured, PATH: '/bin', HOME: '/private', CLAUDE_CONFIG_DIR: '/private/claude',
    CLAUDE_CODE_OAUTH_TOKEN: 'subscription', ANTHROPIC_API_KEY: 'unwanted', ANTHROPIC_AUTH_TOKEN: 'unwanted',
    ANTHROPIC_BASE_URL: 'https://attacker.test', ANTHROPIC_PROFILE: 'personal',
    IDENTITY_ENDPOINT: 'endpoint', IDENTITY_HEADER: 'identity-secret',
    JOBS_TRACKER_CLIENT_SECRET: 'tracker-secret', TELEGRAM_BOT_TOKEN: 'bot', EMPLOYEE_CV_SSH_KEY: 'key' };
  const primary = claudeEnv(env);
  assert.equal(primary.CLAUDE_CODE_OAUTH_TOKEN, 'subscription');
  const fallback = claudeEnv(env, federationConfig(env), 'app-assertion');
  assert.equal(fallback.ANTHROPIC_IDENTITY_TOKEN, 'app-assertion');
  assert.equal(fallback.ANTHROPIC_FEDERATION_RULE_ID, 'fdrl_test');
  assert.equal(fallback.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  for (const child of [primary, fallback]) {
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE', 'ANTHROPIC_BASE_URL',
      'IDENTITY_ENDPOINT', 'IDENTITY_HEADER', 'JOBS_TRACKER_CLIENT_SECRET', 'TELEGRAM_BOT_TOKEN', 'EMPLOYEE_CV_SSH_KEY']) {
      assert.equal(child[name], undefined, name);
    }
    assert.equal(child.ANTHROPIC_CONFIG_DIR, '/private/claude/anthropic');
  }
  assert.equal(primary.ANTHROPIC_FEDERATION_RULE_ID, undefined);
});

test('Entra exchange selects runner identity and audience app rather than a 24-hour MI assertion', async () => {
  const calls = [];
  class ManagedIdentityCredential {
    constructor(options) { assert.equal(options.clientId, 'runner-id'); }
    async getToken(scope, options) { calls.push(scope); assert.ok(options.abortSignal); return { token: 'mi-token' }; }
  }
  class ClientAssertionCredential {
    constructor(tenant, app, getAssertion) {
      assert.equal(tenant, configured.ANTHROPIC_FEDERATION_TENANT_ID);
      assert.equal(app, '22222222-2222-2222-2222-222222222222'); this.getAssertion = getAssertion;
    }
    async getToken(scope, options) {
      assert.ok(options.abortSignal); assert.equal(await this.getAssertion(), 'mi-token'); calls.push(scope);
      return { token: 'short-app-token', expiresOnTimestamp: Date.now() + 3900000 };
    }
  }
  assert.equal(await entraAssertion({ JOBS_CLOUD_IDENTITY_CLIENT_ID: 'runner-id' }, federationConfig(configured),
    { ManagedIdentityCredential, ClientAssertionCredential }), 'short-app-token');
  assert.deepEqual(calls, ['api://AzureADTokenExchange/.default', `${configured.ANTHROPIC_FEDERATION_AUDIENCE}/.default`]);
  await assert.rejects(entraAssertion({}, federationConfig(configured), {
    ManagedIdentityCredential: class { constructor() { throw new Error('SECRET'); } }, ClientAssertionCredential,
  }), error => error.message === 'Claude fallback Entra token exchange failed');
});

// Ported from the v1 merge tests: the fallback order and the paid-API boundary
// belong to runWithFallback, not to the caller.
test('fallback legs run in configured order, each after beforeFallback, without the subscription token', async () => {
  const legs = []; let restores = 0;
  const outcome = await runWithFallback({ ...configured, CLAUDE_CONFIG_DIR: '/private/claude', CLAUDE_CODE_OAUTH_TOKEN: 'subscription' }, 'claude-opus-5-5',
    async (model, childEnv, fallback) => {
      legs.push({ model, fallback, oauth: childEnv.CLAUDE_CODE_OAUTH_TOKEN, token: childEnv.ANTHROPIC_IDENTITY_TOKEN });
      return { success: legs.length === 3, code: legs.length === 3 ? 0 : 1 };
    }, { assertion: async () => 'app-assertion', log() {}, beforeFallback: async () => { restores++; } });
  assert.deepEqual(outcome, { success: true, code: 0 });
  assert.deepEqual(legs, [
    { model: 'claude-opus-5-5', fallback: false, oauth: 'subscription', token: undefined },
    { model: 'claude-opus-5-5', fallback: true, oauth: undefined, token: 'app-assertion' },
    { model: 'claude-sonnet-5-5', fallback: true, oauth: undefined, token: 'app-assertion' },
  ]);
  assert.equal(restores, 2);
});

test('unconfigured fallback returns the primary outcome untouched and never asks for a token', async () => {
  for (const code of [0, 1, 7]) {
    const primary = { success: code === 0, code };
    assert.equal(await runWithFallback({ CLAUDE_CONFIG_DIR: '/private/claude' }, 'claude-opus-5-5', async () => primary, {
      assertion: () => assert.fail('fallback disabled'), beforeFallback: () => assert.fail('fallback disabled'), log() {},
    }), primary);
  }
});

test('a failing token exchange exhausts the fallback without logging the provider error', async () => {
  const logs = []; let calls = 0;
  const outcome = await runWithFallback({ ...configured, CLAUDE_CONFIG_DIR: '/private/claude' }, 'claude-opus-5-5', async () => { calls++; return { success: false, code: 1 }; },
    { assertion: async () => { throw new Error('SECRET_FROM_HTTP_RESPONSE'); }, log: line => logs.push(line) });
  assert.deepEqual(outcome, { success: false, code: 4, exhausted: true });
  assert.equal(calls, 1);
  assert.equal(logs.length, 2);
  assert.ok(logs.every(line => !line.includes('SECRET_FROM_HTTP_RESPONSE')));
});

test('real subprocess captures structured usage and does not echo stderr', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-claude-cli-test-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const bin = path.join(cwd, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho "SECRET" >&2\necho \'{"type":"result","result":"merged"}\'\n', { mode: 0o700 });
  const actual = await invokeClaude(['--print', 'prompt', '--model', 'claude-opus-5-5'], { PATH: bin }, cwd);
  assert.equal(actual.code, 0); assert.equal(actual.result.result, 'merged');
});
