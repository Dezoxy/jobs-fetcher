#!/usr/bin/env node
// v2 refresh orchestrator: docs/architecture-v2.md "Who does what", steps 1-11.
//
//   node scripts/v2/run.mjs            one run for the current 13:00 UTC slot
//
// Exit codes (the Azure job and its alert rules key on these):
//    0  success: the slot was committed and published, or it already had been
//       ("already_completed")
//    8  degraded: committed and published, but a collector, the liveness sweep,
//       prefetch or the judge was incomplete — warnings in the run note say why
//   70  failure: nothing was committed (or the commit landed but the snapshot
//       write failed; the next invocation re-puts it). Includes the removal
//       guard, a missing tracker import and an empty jobs table (import first).
//
// Every run starts by re-putting the last committed snapshot from D1 to KV, so
// a crash between commit and KV write heals itself on the next invocation.
// Every durable effect is ONE D1 batch: its first statement inserts the `runs`
// row, so a second commit for the same slot fails on the primary key and the
// whole batch rolls back. The collectors (the existing v1 scripts) run in a
// private temp directory with materialised inputs and a minimal environment:
// they read untrusted web pages and never see a Cloudflare or Telegram secret.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { merge, applyTracker, findTwins, candidateLedger, collectorLedger, daysBetween } from './merge.mjs';
import { loadState, readSnapshot, snapshotOf, commitStatements, renderSnapshot, serialize } from './store.mjs';
import { configFromEnv, createCloudflare } from './d1.mjs';
import { fetchLinkedInDetail } from './linkedin-detail.mjs';
import { ledgerLookup } from '../ledger.mjs';
import { judgeLinkedIn } from '../vetoes.mjs';

export const EXIT = Object.freeze({ OK: 0, DEGRADED: 8, FAILURE: 70 });
// check-liveness.mjs probes only rows seen in the last 20 days; that is the
// population a sweep can remove from, so it is the guard's denominator.
export const LIVENESS_RECENT_DAYS = 20;
export const REMOVAL_MIN = 5;
export const REMOVAL_RATIO = 0.20;
export const EMAIL_RETRY_DAYS = 7;
const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_LINKEDIN_ROWS = 15;
const DECIDED = new Set(['seen', 'added', 'repost', 'fit', 'dedupe', 'ledgered', 'url-conflict']);

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// The most recent daily 13:00 UTC slot (same rule as cloud-run.mjs scheduleSlot).
export function scheduleSlot(now = new Date()) {
  const slot = new Date(now);
  slot.setUTCHours(13, 0, 0, 0);
  if (now < slot) slot.setUTCDate(slot.getUTCDate() - 1);
  return slot.toISOString();
}

export class RunFailure extends Error {}

/**
 * The removal guard. A run may remove (and the sweep may call dead) at most
 * max(5, 20% of the probed rows). Returns a refusal message or null.
 */
export function checkRemovals({ jobs, today, removed, dead }) {
  const probed = jobs.filter(j => daysBetween(j.lastSeen, today) <= LIVENESS_RECENT_DAYS).length;
  const limit = Math.max(REMOVAL_MIN, Math.floor(probed * REMOVAL_RATIO));
  const ids = new Set(jobs.map(j => j.id));
  const deadCount = (dead ?? []).filter(id => ids.has(id)).length;
  if (removed.length > limit) {
    return `refusing to commit: the run would remove ${removed.length} rows (limit ${limit} = max(${REMOVAL_MIN}, ${REMOVAL_RATIO * 100}% of ${probed} probed))`;
  }
  if (deadCount > limit) {
    return `refusing to commit: liveness marked ${deadCount} rows dead (limit ${limit} = max(${REMOVAL_MIN}, ${REMOVAL_RATIO * 100}% of ${probed} probed))`;
  }
  return null;
}

const plainSummary = (s) => typeof s === 'string' && s.trim() && s.length <= 1500 && !/[<]/.test(s);
export function fallbackSummary(stats) {
  return `Automatikus összefoglaló: ${stats.added} új sor, ${stats.seen + stats.alive} frissítve, ` +
    `${stats.deleted} lejárt hirdetés törölve, ${stats.closed} lezárva, ${stats.fitRejected} kiszűrve, ` +
    `${stats.deduped} duplikátum. Összesen ${stats.total} hirdetés.`;
}

/** Put a committed snapshot to KV: note before data, as in v1. No note = nothing committed by v2 yet. */
export async function publish(cf, { jobs, runNote }) {
  if (!runNote) return false;
  await cf.kvPut('last-run.json', serialize(runNote));
  await cf.kvPut('jobs.json', serialize(jobs));
  return true;
}

/**
 * One refresh. Every side effect goes through `deps`, so tests run the whole
 * pipeline against a SQLite-backed D1 and fakes for the network-bound steps.
 */
export async function runRefresh({ cf, deps, now = new Date(), env = {}, log = console.log }) {
  const slot = scheduleSlot(now);
  const today = slot.slice(0, 10);
  const ranAt = now.toISOString();

  // ---- 1. load state (one consistent read per database)
  const state = await loadState(cf);
  if (!state.trackerImported) throw new RunFailure('jobs-tracker has no tracker_imported marker — run scripts/v2/import.mjs first');
  if (!state.jobs.length) throw new RunFailure('jobs table is empty — run scripts/v2/import.mjs first');

  // Heal first: the last committed snapshot goes to KV on every run.
  if (await publish(cf, snapshotOf(state.jobs, state.lastRun))) log(`v2_run event=republished slot=${state.lastRun.slot}`);
  // ---- idempotency: a slot is committed at most once
  if (state.lastRun && state.lastRun.slot >= slot) {
    log(`v2_run event=already_completed slot=${slot}`);
    return EXIT.OK;
  }

  // ---- 2. tracker verdicts
  const previous = renderSnapshot(state.jobs, state.lastRun?.committed_at ?? ranAt);
  const { verdicts: ledger } = applyTracker(state.verdicts, state.tracker, slot);

  // ---- 3-5. collect, filter, liveness (existing scripts on materialised inputs)
  const collection = await deps.collect({ previous, ledger, state, env, log });
  const warnings = [...collection.warnings];
  let degraded = collection.degraded;
  if (!collection.anySource) throw new RunFailure('every collector failed — nothing to merge');

  // ---- 6. prefetch, 7. judge — NEW candidates only
  const present = new Set(state.jobs.map(j => j.id));
  const newLedger = candidateLedger(ledger, state.tracker);
  const seen = new Set();
  const fresh = collection.candidates.filter(c => {
    if (present.has(c.id) || seen.has(c.id) || newLedger(c.id)?.reason) return false;
    seen.add(c.id);
    return true;
  });
  let judged = { verdicts: [], unjudged: [], judgeVersion: null, model: null };
  if (fresh.length) {
    let withText = fresh.map(c => ({ ...c, possibleTwins: findTwins(c, state.jobs, state.tracker) }));
    try {
      withText = await deps.prefetch(withText);
      const missing = withText.filter(c => !c.adText).length;
      if (missing) warnings.push(`${missing} új jelölt hirdetésszövege nem jött le; az értékelés nélküle futott.`);
    } catch (e) {
      warnings.push(`Hirdetésszöveg-letöltés sikertelen (${String(e?.message ?? e).slice(0, 120)}); az értékelés szöveg nélkül futott.`);
      degraded = true;
    }
    try {
      judged = await deps.judge(withText.map(c => ({ ...c, adText: c.adText ?? '' })), await deps.context());
      if ((judged?.unjudged ?? []).length) degraded = true;
    } catch (e) {
      warnings.push(`Az értékelő (Claude) nem futott le (${String(e?.message ?? e).slice(0, 160)}); ${fresh.length} új jelölt a következő futásra marad.`);
      degraded = true;
      judged = null;
    }
  }

  // ---- 8. merge
  const result = merge({
    jobs: state.jobs, verdicts: state.verdicts, streaks: state.streaks, tracker: state.tracker,
    candidates: collection.candidates, judged, liveness: collection.liveness, today, slot,
    sourcesQueried: collection.sourcesQueried,
  });
  warnings.push(...result.warnings);
  const refusal = checkRemovals({ jobs: state.jobs, today, removed: result.diff.removed, dead: collection.liveness?.dead });
  if (refusal) throw new RunFailure(refusal);

  // ---- run note (summary from the judge's summarizer, deterministic fallback)
  const kept = result.jobs.filter(j => result.diff.added.includes(j.id));
  let summary = fallbackSummary(result.stats);
  try {
    const s = await deps.summarize(result.stats, kept, warnings);
    if (plainSummary(s?.summary)) summary = s.summary.trim();
    for (const w of Array.isArray(s?.warnings) ? s.warnings : []) {
      if (typeof w === 'string' && w.trim() && !warnings.includes(w)) warnings.push(w.slice(0, 500));
    }
  } catch (e) {
    warnings.push(`Az összefoglaló nem készült el (${String(e?.message ?? e).slice(0, 120)}); automatikus szöveg.`);
  }
  const runNote = { ranAt, summary, warnings: warnings.slice(0, 30) };
  if (result.cleanedDeadIds.length) runNote.cleanedDeadIds = result.cleanedDeadIds;
  const snapshot = renderSnapshot(result.jobs, ranAt);

  // ---- 9. validate exactly what will be published
  await deps.validate(snapshot, runNote);

  // ---- 10. commit: one atomic batch, then the snapshot
  const payloadSha256 = sha256(JSON.stringify({ slot, state, candidates: collection.candidates,
    judged, liveness: collection.liveness, sourcesQueried: collection.sourcesQueried }));
  const decided = new Set(Object.entries(result.outcomes).filter(([, o]) => DECIDED.has(o)).map(([id]) => id));
  const cutoff = new Date(now.getTime() - EMAIL_RETRY_DAYS * 86400000).toISOString();
  const consumedEmailIds = state.emailCandidates
    .filter(e => decided.has(e.id) || collection.emailDecided.has(e.id) || e.receivedAt < cutoff)
    .map(e => e.id);
  const statements = commitStatements({ slot, payloadSha256, committedAt: ranAt, runNote, result, consumedEmailIds,
    previousIds: new Map(state.jobs.map(j => [j.id, JSON.stringify(j)])) });
  try {
    await cf.batch('jobs', statements);
  } catch (e) {
    const [row] = await cf.query('jobs', 'SELECT payload_sha256 FROM runs WHERE slot = ?', [slot]);
    if (!row) throw e;
    if (row.payload_sha256 !== payloadSha256) {
      // Another run committed this slot first: publish ITS result, send nothing.
      log(`v2_run event=already_completed slot=${slot} via=commit_conflict`);
      await publish(cf, await readSnapshot(cf));
      return EXIT.OK;
    }
    // Our own batch landed and only its response was lost (the retry hit the
    // primary key): it is committed — publish and notify exactly once, below.
    log(`v2_run event=commit_confirmed slot=${slot} via=payload_match`);
  }
  log(`v2_run event=committed slot=${slot} added=${result.diff.added.length} removed=${result.diff.removed.length} ` +
    `updated=${result.diff.updated} statements=${statements.length}`);
  await publish(cf, { jobs: snapshot, runNote });
  log(`v2_run event=published slot=${slot}`);

  // ---- 11. notify (assume-delivered policy; never changes the exit code)
  try {
    const delivery = await deps.notify({ previous, next: snapshot, runNote });
    log(`v2_run event=notified slot=${slot} delivery=${delivery}`);
  } catch (e) {
    log(`v2_run event=notify_error slot=${slot} error=${String(e?.name ?? 'Error').replace(/[^A-Za-z]/g, '')}`);
  }
  return degraded ? EXIT.DEGRADED : EXIT.OK;
}

// ---------------------------------------------------------------- collectors

// The children read the open web; they get no secrets, only what node needs.
export function childEnv(env) {
  return Object.fromEntries(['PATH', 'HOME', 'LANG', 'TZ', 'JOBS_REFRESH_BROWSE_MIN_ROWS']
    .filter(k => env[k] !== undefined).map(k => [k, env[k]]));
}

function runChild(cmd, args, { cwd, env, log, name }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = d => { out = (out + d).slice(-20000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.once('error', () => resolve(127));
    child.once('close', code => {
      for (const line of out.trim().split('\n').slice(-15)) if (line) log(`v2_run child=${name} ${line}`);
      resolve(code ?? 70);
    });
  });
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

// The JobSpy venv baked into the image (architecture-v2.md "Indeed").
const indeedPython = (env) => env.JOBS_INDEED_PYTHON ??
  (fsSync.existsSync('/opt/indeed/bin/python') ? '/opt/indeed/bin/python' : 'python3');

/**
 * Materialise the inputs the v1 scripts expect (they resolve paths from their
 * own location), run them, and turn their outputs into contract candidate rows.
 */
export async function collectWithScripts({ previous, ledger, state, env, log, salaryFloor, fetchDetail = fetchLinkedInDetail, scriptsDir = SCRIPTS }) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-v2-'));
  try {
    await fs.cp(scriptsDir, path.join(work, 'scripts'), { recursive: true,
      filter: src => !src.includes('__pycache__') && !src.endsWith('.test.mjs') });
    await fs.mkdir(path.join(work, '.cache'), { recursive: true });
    await fs.mkdir(path.join(work, 'public/data'), { recursive: true });
    await fs.writeFile(path.join(work, 'public/data/jobs.json'), serialize(previous));
    await fs.writeFile(path.join(work, '.cache/rejected-ids.json'),
      JSON.stringify({ ids: collectorLedger(ledger, state.tracker ?? {}) }));
    const opts = name => ({ cwd: work, env: childEnv(env), log, name });
    const has = rel => fsSync.existsSync(path.join(work, rel));

    const [sourcesRc, live, linkedin, indeedRun] = await Promise.all([
      // The posted-salary floor comes from employee-cv (judge-profile.md), never from this repo.
      runChild('node', ['scripts/fetch-sources.mjs'], { ...opts('fetch-sources'),
        env: { ...childEnv(env), ...(salaryFloor ? { JOBS_SALARY_FLOOR_HUF: String(salaryFloor) } : {}) } }),
      (async () => {
        const rc = await runChild('node', ['scripts/check-liveness.mjs'], opts('liveness'));
        if (rc !== 0) return { rc };
        await runChild('node', ['scripts/check-liveness.mjs', '--retry-unknown'], opts('liveness-retry'));
        return { rc: 0 };
      })(),
      (async () => {
        if ((env.JOBS_REFRESH_LINKEDIN_ENABLED ?? 'true') !== 'true') return { skipped: true };
        const rc = await runChild('node', ['scripts/fetch-linkedin.mjs'], opts('fetch-linkedin'));
        if (rc !== 0 && rc !== 5) return { rc };
        const frc = await runChild('node', ['scripts/filter-browser.mjs'], opts('filter-browser'));
        return { rc, frc };
      })(),
      (async () => {
        // fetch-indeed.py + filter-indeed.mjs (ledger, then judgeLinkedIn).
        if (!has('scripts/fetch-indeed.py') || !has('scripts/filter-indeed.mjs')) return null;
        const rc = await runChild(indeedPython(env), ['-I', 'scripts/fetch-indeed.py'], opts('fetch-indeed'));
        if (rc !== 0) return { rc };
        const frc = await runChild('node', ['scripts/filter-indeed.mjs'], opts('filter-indeed'));
        return { rc, frc };
      })(),
    ]);
    const file = rel => path.join(work, rel);
    return interpretCollection({
      sources: await readJson(file('.cache/sources-latest.json')), sourcesRc,
      dead: live.rc === 0 ? await readJson(file('.cache/dead-ids.json')) : null,
      linkedin, filtered: linkedin.frc === 0 ? await readJson(file('.cache/browser-filtered.json')) : null,
      indeedRun, indeed: indeedRun?.frc === 0 ? await readJson(file('.cache/indeed-filtered.json')) : null,
      ledger, state, env, fetchDetail,
    });
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** Pure-ish half of collection (only e-mail detail fetches do I/O): files -> candidates. */
export async function interpretCollection({ sources, sourcesRc, dead, linkedin, filtered, indeedRun = null, indeed = null,
  ledger, state, env = {}, fetchDetail = fetchLinkedInDetail }) {
  const warnings = [];
  let degraded = false;
  const candidates = [];
  const sourcesQueried = { Profession: false, NoFluff: false, LinkedIn: false, Indeed: false };
  let anySource = false;
  const reasonOf = ledgerLookup(Object.fromEntries(Object.entries(ledger).map(([id, v]) => [id, v.reason])));

  // Profession + NFJ (fetch-sources.mjs already applied vetoes and the ledger)
  if (sources && Array.isArray(sources.profession) && Array.isArray(sources.nfj)) {
    anySource = true;
    const cov = sources.coverage ?? {};
    sourcesQueried.Profession = sourcesRc === 0 && cov.profession?.units > 0 && cov.profession.failed === 0;
    sourcesQueried.NoFluff = sourcesRc === 0 && cov.nfj?.units > 0 && cov.nfj.failed === 0;
    for (const p of sources.profession) {
      candidates.push({ id: p.id, source: 'Profession', role: p.role, company: p.company, location: p.location ?? null, url: p.url });
    }
    for (const n of sources.nfj) {
      const c = { id: n.id, source: 'NoFluff', role: n.role, company: n.company, location: null, url: n.url,
        postedAt: n.posted ?? undefined };
      if (Number.isInteger(n.salaryLo)) {
        // Only a visible HUF band is copied verbatim; anything else is the judge's estimate.
        c.salary = { lo: n.salaryLo, hi: Number.isInteger(n.salaryHi) ? n.salaryHi : n.salaryLo,
          type: n.salaryType, visible: !!n.salaryVisible && n.salaryCurrency === 'HUF' };
      }
      candidates.push(c);
    }
    if (sourcesRc !== 0 || (sources.errors ?? []).length) {
      degraded = degraded || sourcesRc !== 0;
      const errs = sources.errors ?? [];
      warnings.push(`Profession/NFJ gyűjtés hiányos (exit ${sourcesRc}, ${errs.length} hiba)` +
        (errs.length ? `: ${errs.slice(0, 3).join('; ').slice(0, 300)}${errs.length > 3 ? ` +${errs.length - 3}` : ''}` : '') + '.');
    }
  } else {
    degraded = true;
    warnings.push(`Profession/NFJ gyűjtés sikertelen (exit ${sourcesRc}); ezek a források kimaradtak.`);
  }

  // LinkedIn guest search (filter-browser.mjs already applied vetoes and the ledger)
  if (linkedin?.skipped) {
    warnings.push('LinkedIn gyűjtés kikapcsolva (JOBS_REFRESH_LINKEDIN_ENABLED), csak a többi forrás futott.');
  } else if (filtered && Array.isArray(filtered.linkedinAlerts)) {
    anySource = true;
    sourcesQueried.LinkedIn = linkedin.rc === 0;
    for (const r of filtered.linkedinAlerts) {
      candidates.push({ id: r.id, source: 'LinkedIn', role: r.title ?? r.role, company: r.company,
        location: r.location ?? null, url: r.url, postedAt: r.postedAt ?? undefined });
    }
    const li = [];
    if (linkedin.rc === 5) li.push('a guest search lefedettsége hiányos (lekérdezés-hiba, 100-as plafon vagy hibás lapozás)');
    if ((filtered.queryFailures ?? []).length) li.push(`${filtered.queryFailures.length} lekérdezés hibázott`);
    if ((filtered.truncatedQueries ?? []).length) li.push(`${filtered.truncatedQueries.length} lekérdezés elérte a plafont`);
    const state_ = filtered.auth?.linkedin?.state;
    if (state_ !== 'ok') li.push(`állapot: ${state_ ?? 'nincs jelentve'}${filtered.auth?.linkedin?.reason ? ` (${filtered.auth.linkedin.reason})` : ''}`);
    const total = filtered.linkedinAlerts.length + (filtered.droppedRows ?? []).length;
    const min = Number.parseInt(env.JOBS_REFRESH_BROWSE_MIN_ROWS ?? '', 10);
    if (state_ === 'ok' && total < (Number.isFinite(min) ? min : MIN_LINKEDIN_ROWS)) li.push(`csak ${total} sor jött (összeomlás-gyanú)`);
    if (total > 0 && (filtered.titled ?? 0) === 0) li.push('egyik sornak sincs címe, a vétók nem futottak');
    if (total > 0 && (filtered.located ?? 0) === 0) li.push('egyik sornak sincs helye, a helyvétó nem futott');
    if (li.length) { degraded = true; warnings.push(`LinkedIn: ${li.join('; ')}.`); }
  } else {
    degraded = true;
    warnings.push(`LinkedIn gyűjtés sikertelen (fetch exit ${linkedin?.rc ?? '?'}, filter exit ${linkedin?.frc ?? '-'}); a LinkedIn kimaradt.`);
  }

  // Indeed: fetch-indeed.py -> filter-indeed.mjs (.cache/indeed-filtered.json).
  // An undetermined run is degraded collection; its partial rows still count.
  if (indeedRun) {
    if (indeedRun.rc === 0 && indeedRun.frc === 0 && indeed && Array.isArray(indeed.rows)) {
      anySource = anySource || indeed.rows.length > 0 || indeed.state === 'ok';
      sourcesQueried.Indeed = indeed.state === 'ok';
      for (const r of indeed.rows) {
        candidates.push({ id: r.id, source: 'Indeed', role: r.role, company: r.company, location: r.location ?? null,
          url: r.url, postedAt: r.postedAt ?? undefined, salary: r.salary ?? undefined, adText: r.adText ?? undefined });
      }
      const why = [];
      if (indeed.state !== 'ok') { degraded = true; why.push(`állapot: ${indeed.state}${indeed.reason ? ` (${String(indeed.reason).slice(0, 200)})` : ''}`); }
      if ((indeed.queryFailures ?? []).length) { degraded = true; why.push(`${indeed.queryFailures.length} lekérdezés hibázott`); }
      if ((indeed.truncatedQueries ?? []).length) why.push(`${indeed.truncatedQueries.length} lekérdezés elérte a plafont`);
      if (why.length) warnings.push(`Indeed: ${why.join('; ')}.`);
    } else {
      degraded = true;
      warnings.push(`Indeed gyűjtés sikertelen (fetch exit ${indeedRun.rc ?? '?'}, filter exit ${indeedRun.frc ?? '-'}); az Indeed kimaradt.`);
    }
  }

  // E-mail alert candidates -> LinkedIn guest detail
  const emailDecided = new Set();
  const byId = new Map(state.jobs.map(j => [j.id, j]));
  const inBatch = new Set(candidates.map(c => c.id));
  for (const e of state.emailCandidates) {
    if (reasonOf(e.id)) { emailDecided.add(e.id); continue; }
    if (inBatch.has(e.id)) continue; // the feed carried it; merge decides
    const existing = byId.get(e.id);
    if (existing) {
      candidates.push({ id: existing.id, source: existing.source, role: existing.role, company: existing.company, location: null, url: existing.url });
      continue;
    }
    const d = await fetchDetail(e.id);
    if (d.state === 'gone') { emailDecided.add(e.id); continue; }
    if (d.state !== 'ok') continue; // retried next run
    if (judgeLinkedIn(d.role, d.company, d.location) !== 'keep') { emailDecided.add(e.id); continue; }
    const num = e.id.replace(/^li-/, '');
    candidates.push({ id: e.id, source: 'LinkedIn', role: d.role, company: d.company, location: d.location || null,
      url: `https://www.linkedin.com/jobs/view/${num}/`, adText: d.adText || undefined });
    anySource = true;
  }

  // Liveness: absent means "no liveness this run", never "nothing died".
  let liveness = null;
  if (dead && Array.isArray(dead.dead) && Array.isArray(dead.alive)) liveness = { dead: dead.dead, alive: dead.alive };
  else { degraded = true; warnings.push('A liveness-ellenőrzés nem futott le; ebben a futásban nincs halott-sor kezelés.'); }

  return { candidates, liveness, sourcesQueried, warnings, degraded, anySource, emailDecided };
}

// ---------------------------------------------------------------- validate / notify

/** Run validate.mjs on exactly the files that will be published. */
export async function validateWithScript(snapshot, runNote, log = console.log) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-v2-validate-'));
  try {
    await fs.mkdir(path.join(dir, 'public/data'), { recursive: true });
    await fs.writeFile(path.join(dir, 'public/data/jobs.json'), serialize(snapshot));
    await fs.writeFile(path.join(dir, 'public/data/last-run.json'), serialize(runNote));
    const rc = await runChild('node', [path.join(SCRIPTS, 'validate.mjs')], { cwd: dir, env: childEnv(process.env), log, name: 'validate' });
    if (rc !== 0) throw new RunFailure(`validate.mjs rejected the result (exit ${rc})`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Failures that happen before any byte can reach Telegram (cloud-run.mjs).
export const PRE_CONNECT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * Copy of cloud-run.mjs Runner.sendTelegram. Delivery policy (owner decision
 * 2026-11-22): an unprovable outcome is assumed delivered — 'sent', 'failed'
 * (provably never left, after retries) or 'unconfirmed'. Never logs the URL or
 * error text: both can carry the bot token.
 */
export async function sendTelegram(env, text, { fetchImpl = globalThis.fetch, retryDelayMs = 30000, log = console.error } = {}) {
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, parse_mode: 'HTML',
          disable_web_page_preview: true, text }), signal: AbortSignal.timeout(30000),
      });
      const body = await response.json();
      if (!response.ok || body.ok !== true || !Number.isInteger(body.result?.message_id)) throw new Error('Unconfirmed');
      return 'sent';
    } catch (error) {
      const safe = value => String(value ?? 'none').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'none';
      log(`v2_run event=telegram_error error=${safe(error?.name)} ` +
        `cause=${safe(error?.cause?.code ?? error?.cause?.name)} status=${safe(response?.status)} attempt=${attempt}`);
      if (response || !PRE_CONNECT_CODES.has(error?.cause?.code)) return 'unconfirmed';
      if (attempt >= attempts) return 'failed';
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
}

/** notify-diff.mjs on previous vs new snapshot, then Telegram when enabled and changed. */
export async function notifyWithScript({ previous, next, runNote }, env, { send = sendTelegram, log = console.log } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-v2-notify-'));
  try {
    const f = name => path.join(dir, name);
    await fs.writeFile(f('previous.json'), serialize(previous));
    await fs.writeFile(f('jobs.json'), serialize(next));
    await fs.writeFile(f('last-run.json'), serialize(runNote));
    const message = await new Promise((resolve, reject) => {
      const child = spawn('node', [path.join(SCRIPTS, 'notify-diff.mjs'), f('previous.json'), f('jobs.json'), f('last-run.json')],
        { env: { ...childEnv(process.env), NOTIFY_CHANGED_FILE: f('changed') }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => log(`v2_run child=notify-diff ${String(d).trim()}`));
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve(out.trimEnd()) : reject(new Error(`notify-diff exit ${code}`)));
    });
    const changed = (await fs.readFile(f('changed'), 'utf8')).trim() === 'true';
    if (!changed) return 'skipped';
    if (env.JOBS_REFRESH_NOTIFY_ENABLED !== 'true' || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return 'disabled';
    return await send(env, message);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- judge context

const readCvFile = (env, name) => fs.readFile(path.join(env.JOBS_EMPLOYEE_CV_ROOT ?? '/data/employee-cv', name), 'utf8');

/**
 * judge-profile.md's load-bearing lines; returns the salary floor ("- Salary
 * floor: 900000 HUF gross per month"). Fails closed: a missing or malformed
 * line stops the run, so a truncated profile can neither drop the posted-band
 * prefilter nor leave the judge to fall back on target-roles.md's gap list.
 */
export function parseOwnerProfile(profile) {
  for (const line of ['Location', 'Known gaps']) {
    if (!new RegExp(`^- ${line}: \\S`, 'm').test(profile)) throw new RunFailure(`judge-profile.md has no "- ${line}:" line`);
  }
  const m = /^- Salary floor: (\d{6,8}) HUF gross per month\b/m.exec(profile);
  if (!m) throw new RunFailure('judge-profile.md has no "- Salary floor: <HUF> HUF gross per month" line');
  return { salaryFloor: Number(m[1]) };
}

/** judge-profile.md, target-roles.md and salary-benchmarks.md from JOBS_EMPLOYEE_CV_ROOT (default /data/employee-cv). */
export async function loadJudgeContext(env, today) {
  return { ownerProfile: await readCvFile(env, 'profile/judge-profile.md'),
    targetRoles: await readCvFile(env, 'profile/target-roles.md'),
    salaryBenchmarks: await readCvFile(env, 'research/market/salary-benchmarks.md'), today };
}

// ---------------------------------------------------------------- main

export function defaultDeps(env, now, log) {
  return {
    collect: async (args) => collectWithScripts({ ...args, log,
      ...parseOwnerProfile(await readCvFile(env, 'profile/judge-profile.md')) }),
    // scripts/v2/prefetch.mjs and judge.mjs (architecture-v2.md "Judge
    // contract", "Prefetch"); imported lazily so this file loads without them.
    prefetch: async (candidates) => (await import('./prefetch.mjs')).prefetchAll(candidates),
    judge: async (candidates, context) => (await import('./judge.mjs')).judge(candidates, context, { env, log }),
    summarize: async (stats, kept, warnings) => (await import('./judge.mjs')).summarize(stats, kept, warnings, { env, log }),
    context: () => loadJudgeContext(env, scheduleSlot(now).slice(0, 10)),
    validate: (snapshot, runNote) => validateWithScript(snapshot, runNote, log),
    notify: (args) => notifyWithScript(args, env, { log }),
  };
}

export async function main(env = process.env, now = new Date(), log = console.log) {
  const cf = createCloudflare(configFromEnv(env));
  if (!env.SNAPSHOT_KV_ID) throw new RunFailure('SNAPSHOT_KV_ID is required for a refresh');
  return runRefresh({ cf, deps: defaultDeps(env, now, log), now, env, log });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    // error.message never carries a token: d1.mjs and sendTelegram build their own texts.
    console.error(`v2_run event=failure reason=${String(error?.message ?? error).slice(0, 500)}`);
    process.exitCode = EXIT.FAILURE;
  });
}
