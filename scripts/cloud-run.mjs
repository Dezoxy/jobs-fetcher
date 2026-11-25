// Azure entry point (docs/architecture-v2.md). D1 is the data plane: `refresh`
// fetches the three employee-cv inputs and runs scripts/v2/run.mjs; `backup`
// exports both D1 databases to the write-once backup container. The v1 path
// (Blob state, lease, git publish) was retired in cutover step 4.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FEDERATION_NAMES, federationConfig } from './claude-cli.mjs';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sshCommand = file => `ssh -i ${file} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=${SOURCE}/runtime/github-known-hosts`;
export const CV_FILES = ['profile/target-roles.md', 'profile/judge-profile.md', 'research/market/salary-benchmarks.md'];

// Export only the three required inputs, and discard the entire CV object store.
// `command(cmd, args, opts)` -> { code, output }, throwing on failure.
export async function fetchCvFiles(command, { work, gitEnv, cvDir }) {
  const cvRepo = path.join(work, 'cv-fetch');
  await command('git', ['clone', '--quiet', '--depth', '1', '--no-checkout',
    'git@github.com:Dezoxy/employee-cv.git', cvRepo], { cwd: work, env: gitEnv });
  await fs.mkdir(cvDir, { recursive: true, mode: 0o700 });
  for (const name of CV_FILES) {
    const value = (await command('git', ['show', `HEAD:${name}`], { cwd: cvRepo, env: gitEnv })).output;
    await fs.mkdir(path.dirname(path.join(cvDir, name)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(cvDir, name), value, { mode: 0o600 });
  }
  await fs.rm(cvRepo, { recursive: true });
}

// v2 runner environment (scripts/v2/run.mjs): D1/KV, Telegram, collector
// switches, and what the judge needs for Claude (judge.mjs builds a narrower
// allowlist for each claude process; collectors get none of it). Never the
// CV deploy key, the tracker credentials or the Blob configuration.
export const V2_ENV = ['PATH', 'HOME', 'LANG', 'TZ',
  'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'JOBS_D1_ID', 'TRACKER_D1_ID', 'SNAPSHOT_KV_ID',
  'JOBS_EMPLOYEE_CV_ROOT', 'JOBS_REFRESH_NOTIFY_ENABLED', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
  'JOBS_REFRESH_LINKEDIN_ENABLED', 'JOBS_REFRESH_BROWSE_MIN_ROWS', 'JOBS_INDEED_PYTHON',
  'ANTHROPIC_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER',
  'JOBS_REFRESH_JUDGE_EFFORT', 'JOBS_REFRESH_MERGE_EFFORT', ...FEDERATION_NAMES, 'ANTHROPIC_WORKSPACE_ID',
  'JOBS_REFRESH_FALLBACK_MODELS', 'JOBS_CLOUD_IDENTITY_CLIENT_ID', 'IDENTITY_ENDPOINT', 'IDENTITY_HEADER'];
export const v2Env = env => Object.fromEntries(V2_ENV.filter(k => env[k] !== undefined).map(k => [k, env[k]]));

async function execCommand(cmd, args, { cwd, env, capture = true, allowFailure = false } = {}) {
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'] });
  let output = '';
  if (capture) { child.stdout.on('data', d => { output += d; }); child.stderr.resume(); } // stderr can carry SSH details
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', c => resolve(c ?? 70)); });
  if (code && !allowFailure) throw new Error(`${cmd} failed (exit ${code})`);
  return { code, output: output.trimEnd() };
}

/**
 * Refresh: employee-cv's three files, then scripts/v2/run.mjs, whose exit code
 * (0/8/70) is the job's. No Blob lease (the D1 `runs` row is the idempotency
 * guard), no clone of jobs-dashboard: the image is the release.
 */
export async function refreshD1(env, { command = execCommand, cvDir = env.JOBS_EMPLOYEE_CV_ROOT ?? '/data/employee-cv' } = {}) {
  if (!env.EMPLOYEE_CV_SSH_KEY) throw new Error('Missing employee-cv deploy key');
  if (env.JOBS_REFRESH_NOTIFY_ENABLED === 'true' && (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID)) {
    throw new Error('Enabled notification requires Telegram credentials');
  }
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-cloud-'));
  try {
    await fs.chmod(work, 0o700);
    const cvKey = path.join(work, 'cv.key');
    await fs.writeFile(cvKey, env.EMPLOYEE_CV_SSH_KEY, { mode: 0o600 });
    await fetchCvFiles(command, { work, cvDir,
      gitEnv: { PATH: env.PATH, HOME: work, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: sshCommand(cvKey) } });
    await fs.rm(cvKey);
    const run = await command('node', [path.join(SOURCE, 'scripts/v2/run.mjs')], {
      cwd: work, capture: false, allowFailure: true,
      env: v2Env({ ...env, HOME: '/home/node', CLAUDE_CONFIG_DIR: path.join(work, 'claude'), JOBS_EMPLOYEE_CV_ROOT: cvDir }),
    });
    console.log(`cloud_job event=v2_refresh_exit job=refresh code=${run.code}`);
    return run.code;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

// The write-once backup container. An operator may run a backup with their own
// Azure CLI login; the job uses its managed identity.
async function backupContainer(env, operator = false) {
  const { BlobServiceClient } = await import('@azure/storage-blob');
  const { ManagedIdentityCredential, AzureCliCredential } = await import('@azure/identity');
  const credential = operator ? new AzureCliCredential() :
    new ManagedIdentityCredential({ clientId: env.JOBS_CLOUD_IDENTITY_CLIENT_ID });
  const url = env.JOBS_CLOUD_BACKUP_ACCOUNT_URL;
  const name = env.JOBS_CLOUD_BACKUP_CONTAINER;
  if (!/^https:\/\/[a-z0-9]+\.blob\.core\.windows\.net\/?$/.test(url ?? '') || !name) throw new Error('Invalid Blob configuration');
  return new BlobServiceClient(url, credential, { retryOptions: { maxTries: 1 },
    keepAliveOptions: { enable: true } }).getContainerClient(name);
}

export async function main(args = process.argv.slice(2), env = process.env, deps = {}) {
  const [mode = 'refresh'] = args;
  if (mode === '--help') {
    console.log('cloud-run.mjs refresh | backup [--operator-login]');
    return 0;
  }
  if (mode === 'backup') {
    const { backupD1 } = await import('./v2/backup.mjs');
    await backupD1(env, await (deps.backupContainer ?? backupContainer)(env, args.includes('--operator-login')));
    return 0;
  }
  if (mode !== 'refresh') throw new Error('Unknown cloud command');
  federationConfig(env);
  return (deps.refreshD1 ?? refreshD1)(env);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`cloud_job event=failure job=${process.argv[2] ?? 'refresh'} reason=${error.message}`);
    process.exitCode = 70;
  });
}
