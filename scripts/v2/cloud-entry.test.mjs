// The Azure entry (scripts/cloud-run.mjs): refresh runs scripts/v2/run.mjs and
// backup exports D1. The v1 path is retired, so neither depends on JOBS_DATA_PLANE.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, refreshD1, v2Env, CV_FILES } from '../cloud-run.mjs';

const SECRETS = { EMPLOYEE_CV_SSH_KEY: 'cv-key', JOBS_DASHBOARD_SSH_KEY: 'dash-key', JOBS_TRACKER_CLIENT_SECRET: 'tr',
  JOBS_TRACKER_CLIENT_ID: 'tid', JOBS_CLOUD_ACCOUNT_URL: 'https://x.blob.core.windows.net' };
const V2 = { PATH: process.env.PATH, CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 'cf', JOBS_D1_ID: 'j', TRACKER_D1_ID: 't',
  SNAPSHOT_KV_ID: 'k', TELEGRAM_BOT_TOKEN: 'tg', TELEGRAM_CHAT_ID: '1', JOBS_REFRESH_NOTIFY_ENABLED: 'true',
  ANTHROPIC_MODEL: 'claude-x', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' };

test('refreshD1: fetches the CV files with the CV key, then runs v2 with an allowlisted env and returns its exit code', async () => {
  const cvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-cv-'));
  const calls = [];
  let runEnv;
  const command = async (cmd, args, opts) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'git' && args[0] === 'show') return { code: 0, output: `content of ${args[1]}` };
    if (cmd === 'node') { runEnv = opts.env; assert.equal(opts.allowFailure, true); return { code: 8, output: '' }; }
    if (cmd === 'git' && args[0] === 'clone') { fs.mkdirSync(args.at(-1), { recursive: true }); assert.match(opts.env.GIT_SSH_COMMAND, /cv\.key/); }
    return { code: 0, output: '' };
  };
  try {
    assert.equal(await refreshD1({ ...V2, ...SECRETS, JOBS_DATA_PLANE: 'd1' }, { command, cvDir }), 8);
    for (const name of CV_FILES) assert.equal(fs.readFileSync(path.join(cvDir, name), 'utf8'), `content of HEAD:${name}`);
    assert.ok(calls.some(c => c.includes('employee-cv.git')));
    assert.equal(calls.some(c => c.includes('jobs-dashboard.git')), false); // no repo clone, no verifyCode
    assert.match(calls.at(-1), /^node .*scripts\/v2\/run\.mjs$/);
    for (const k of Object.keys(SECRETS)) assert.equal(runEnv[k], undefined, `${k} must not reach run.mjs`);
    assert.equal(runEnv.CLOUDFLARE_API_TOKEN, 'cf');
    assert.equal(runEnv.TELEGRAM_BOT_TOKEN, 'tg');
    assert.equal(runEnv.JOBS_EMPLOYEE_CV_ROOT, cvDir);
    assert.equal(runEnv.JOBS_DATA_PLANE, undefined);
  } finally { fs.rmSync(cvDir, { recursive: true, force: true }); }
});

test('refreshD1 refuses without the CV key, and enabled notification without Telegram credentials', async () => {
  await assert.rejects(refreshD1({ ...V2 }, { command: async () => ({ code: 0, output: '' }) }), /employee-cv deploy key/);
  await assert.rejects(refreshD1({ ...V2, TELEGRAM_BOT_TOKEN: undefined, EMPLOYEE_CV_SSH_KEY: 'k' }, { command: async () => ({ code: 0, output: '' }) }), /Telegram/);
});

test('cloud-run refresh always takes the v2 path; unknown and retired v1 commands fail', async () => {
  let called = 0;
  const deps = { refreshD1: async () => { called++; return 8; } };
  assert.equal(await main(['refresh'], { ...V2, JOBS_DATA_PLANE: 'd1' }, deps), 8);
  assert.equal(await main([], { ...V2 }, deps), 8);
  assert.equal(called, 2);
  for (const mode of ['seed', 'reconcile', 'export', 'publish']) {
    await assert.rejects(main([mode, '--operator-login'], { ...V2 }, deps), /Unknown cloud command/);
  }
  assert.equal(called, 2);
});

test('cloud-run backup exports D1 into the backup container, with the operator login only when asked', async () => {
  const seen = [];
  const deps = { backupContainer: async (env, operator) => { seen.push(operator); throw new Error('container reached'); } };
  await assert.rejects(main(['backup'], { ...V2 }, deps), /container reached/);
  await assert.rejects(main(['backup', '--operator-login'], { ...V2 }, deps), /container reached/);
  assert.deepEqual(seen, [false, true]);
});

test('v2Env is an allowlist', () => {
  assert.deepEqual(Object.keys(v2Env({ PATH: '/bin', CLOUDFLARE_API_TOKEN: 'x', EMPLOYEE_CV_SSH_KEY: 'k', RANDOM: 'r' })).sort(), ['CLOUDFLARE_API_TOKEN', 'PATH']);
});
