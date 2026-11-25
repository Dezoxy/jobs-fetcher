// Nightly backup of both D1 databases to the existing Azure backup account
// (docs/architecture-v2.md: "plus a nightly export to the Azure backup account").
//
// Called by `cloud-run.mjs backup`. Same upload rules as the retired v1 backup: a new immutable blob backups/<iso>-<sha256>.json written with
// If-None-Match: *, then read back and checksum-verified.
//
// Bundle: { schema: 2, exportedAt, databases: { 'jobs-data': {table: rows},
//           'jobs-tracker': { tracker: rows, meta: rows } } } — rows exactly as D1 returns them,
// so a restore is INSERTs of the same columns.
import { createHash } from 'node:crypto';
import { dumpDatabase } from './store.mjs';
import { configFromEnv, createCloudflare } from './d1.mjs';

export const BACKUP_MAX_BYTES = 32 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function buildBundle(cf, now = new Date()) {
  const jobsData = await dumpDatabase(cf, 'jobs');
  const tracker = await dumpDatabase(cf, 'tracker');
  if (!jobsData.jobs.length) throw new Error('D1 jobs table is empty — refusing to back up nothing');
  const bundle = Buffer.from(JSON.stringify({ schema: 2, exportedAt: now.toISOString(),
    databases: { 'jobs-data': jobsData, 'jobs-tracker': tracker } }));
  if (bundle.length > BACKUP_MAX_BYTES) throw new Error('Backup bundle exceeds 32 MB');
  return { bundle, counts: Object.fromEntries([...Object.entries(jobsData), ...Object.entries(tracker)].map(([t, rows]) => [t, rows.length])) };
}

/**
 * `container` is an @azure/storage-blob ContainerClient for the backup
 * container (cloud-run.mjs builds it with the backup writer's managed identity).
 */
export async function uploadBundle(container, bundle, now = new Date()) {
  const target = container.getBlockBlobClient(`backups/${now.toISOString()}-${sha256(bundle)}.json`);
  await target.uploadData(bundle, { conditions: { ifNoneMatch: '*' }, abortSignal: AbortSignal.timeout(15000) });
  const verified = await target.downloadToBuffer(0, bundle.length, { abortSignal: AbortSignal.timeout(15000) });
  if (verified.length !== bundle.length || sha256(verified) !== sha256(bundle)) throw new Error('Backup verification failed');
  return target.name;
}

export async function backupD1(env, container, { cf = createCloudflare(configFromEnv(env)), now = new Date() } = {}) {
  const { bundle, counts } = await buildBundle(cf, now);
  await uploadBundle(container, bundle, now);
  console.log(`cloud_job event=success job=backup source=d1 bytes=${bundle.length} ` +
    Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(' '));
}
