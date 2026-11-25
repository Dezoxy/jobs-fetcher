// Shared Claude CLI plumbing: subscription first, federated API fallback,
// allowlisted child environment. Used by the v2 judge (v2/judge.mjs).
import path from 'node:path';
import { spawn } from 'node:child_process';

export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
export const FEDERATION_NAMES = ['ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_SERVICE_ACCOUNT_ID', 'ANTHROPIC_FEDERATION_AUDIENCE', 'ANTHROPIC_FEDERATION_TENANT_ID'];
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

export function federationConfig(env) {
  if (!FEDERATION_NAMES.some(name => env[name]) && !env.ANTHROPIC_WORKSPACE_ID) return null;
  const patterns = [ /^fdrl_[A-Za-z0-9_-]+$/, new RegExp(`^${UUID}$`),
    /^svac_[A-Za-z0-9_-]+$/, new RegExp(`^api://${UUID}$`), new RegExp(`^${UUID}$`) ];
  for (const [i, name] of FEDERATION_NAMES.entries()) {
    if (!patterns[i].test(env[name] ?? '')) throw new Error(`Missing or invalid ${name}`);
  }
  if (env.ANTHROPIC_WORKSPACE_ID && !/^wrkspc_[A-Za-z0-9_-]+$/.test(env.ANTHROPIC_WORKSPACE_ID)) {
    throw new Error('Invalid ANTHROPIC_WORKSPACE_ID');
  }
  const models = (env.JOBS_REFRESH_FALLBACK_MODELS ?? 'claude-opus-5-5,claude-sonnet-5-5')
    .split(',').map(model => model.trim());
  if (!models.length || models.length > 2 || models.some(model => !/^claude-[a-z0-9][a-z0-9.-]*$/.test(model))) {
    throw new Error('JOBS_REFRESH_FALLBACK_MODELS requires one or two Claude model IDs');
  }
  return { ...Object.fromEntries(FEDERATION_NAMES.map(name => [name, env[name]])),
    ...(env.ANTHROPIC_WORKSPACE_ID ? { ANTHROPIC_WORKSPACE_ID: env.ANTHROPIC_WORKSPACE_ID } : {}), models };
}

// Neither the primary nor the API-backed agent receives Azure identity access,
// tracker credentials, inherited API keys, provider routing, or personal profiles.
export function claudeEnv(env, federation = null, assertion = null) {
  const names = ['PATH', 'HOME', 'LANG', 'CLAUDE_CONFIG_DIR'];
  const child = { ...Object.fromEntries(names.filter(name => env[name] !== undefined)
    .map(name => [name, env[name]])), DISABLE_AUTOUPDATER: '1',
    ANTHROPIC_CONFIG_DIR: path.join(env.CLAUDE_CONFIG_DIR, 'anthropic'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  if (federation) {
    for (const name of [...FEDERATION_NAMES.slice(0, 3), 'ANTHROPIC_WORKSPACE_ID']) {
      if (federation[name]) child[name] = federation[name];
    }
    // Claude Code's built-in federation refreshes the short-lived Anthropic
    // token during a tool-using run. The Entra assertion lasts about an hour.
    child.ANTHROPIC_IDENTITY_TOKEN = assertion;
  } else if (env.CLAUDE_CODE_OAUTH_TOKEN) child.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN;
  return child;
}

export async function entraAssertion(env, federation, identityClasses) {
  try {
    const { ManagedIdentityCredential, ClientAssertionCredential } = identityClasses ?? await import('@azure/identity');
    const signal = AbortSignal.timeout(30000);
    const identity = new ManagedIdentityCredential({ clientId: env.JOBS_CLOUD_IDENTITY_CLIENT_ID });
    const app = new ClientAssertionCredential(federation.ANTHROPIC_FEDERATION_TENANT_ID,
      federation.ANTHROPIC_FEDERATION_AUDIENCE.slice('api://'.length),
      async () => (await identity.getToken('api://AzureADTokenExchange/.default', { abortSignal: signal })).token);
    const token = await app.getToken(`${federation.ANTHROPIC_FEDERATION_AUDIENCE}/.default`, { abortSignal: signal });
    if (typeof token?.token !== 'string' || !token.token || !Number.isFinite(token.expiresOnTimestamp) ||
        token.expiresOnTimestamp < Date.now() + 35 * 60000) throw new Error('Short assertion');
    return token.token;
  } catch {
    // SDK exceptions may contain assertions or endpoint responses.
    throw new Error('Claude fallback Entra token exchange failed');
  }
}

// `input` is written to stdin (the judge passes untrusted ad text this way, never
// in argv: Linux caps one argv string at 128 KiB). `timeoutMs` 0 = no limit.
export async function invokeClaude(args, env, cwd, { input = null, timeoutMs = 0 } = {}) {
  const child = spawn('claude', [...args, '--output-format', 'json'], {
    cwd, env, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }); // Same process group as the cloud runner: lease fencing kills the whole tree.
  if (input !== null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  let output = ''; let oversized = false;
  child.stdout.on('data', bytes => {
    if (oversized) return;
    output += bytes;
    if (output.length > MAX_OUTPUT_BYTES) { oversized = true; output = ''; child.kill('SIGTERM'); }
  });
  child.stderr.resume(); // Never echo token-bearing SDK/HTTP errors.
  const timer = timeoutMs > 0 ? setTimeout(() => child.kill('SIGTERM'), timeoutMs) : null;
  const code = await new Promise(resolve => {
    child.once('error', () => resolve(70)); child.once('close', code => resolve(code ?? 70));
  });
  if (timer) clearTimeout(timer);
  let result;
  try { result = JSON.parse(output); } catch { /* failed or empty output */ }
  return { code, result: oversized ? null : result };
}

export function failureReason(code, result) {
  return /(?:weekly|session|usage) limit/i.test(result?.result ?? '') ? 'usage_limit' :
    code !== 0 ? 'cli_exit' : result?.is_error ? 'cli_error_result' : 'invalid_output';
}

export const usageFields = result => {
  const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
  return `input_tokens=${number(result?.usage?.input_tokens)}` +
    ` output_tokens=${number(result?.usage?.output_tokens)} cost_usd=${number(result?.total_cost_usd)}`;
};

// Subscription first; only after it fails, each federated model in order.
// attempt(model, childEnv, fallback) → { success, code, ... }. Returns the first
// successful attempt, the failed primary when federation is not configured, or
// { success: false, code: 4, exhausted: true } when every paid leg failed too.
// An invalid federation configuration throws before anything is invoked.
export async function runWithFallback(env, primaryModel, attempt, {
  assertion = entraAssertion, log = console.log, event = 'claude', beforeFallback = async () => {},
} = {}) {
  const federation = federationConfig(env);
  const primary = await attempt(primaryModel, claudeEnv(env), false);
  if (primary.success || !federation) return primary;
  for (const model of federation.models) {
    await beforeFallback();
    try {
      const token = await assertion(env, federation);
      const leg = await attempt(model, claudeEnv(env, federation, token), true);
      if (leg.success) return leg;
    } catch {
      log(`${event} event=failure model=${model} fallback=true reason=token_exchange_or_invocation_failed`);
    }
  }
  return { success: false, code: 4, exhausted: true };
}
