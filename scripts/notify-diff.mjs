#!/usr/bin/env node
/**
 * Diff two jobs.json snapshots and emit a Telegram message.
 *
 * Usage:  node scripts/notify-diff.mjs <old.json|-> <new.json> [last-run.json]
 *
 * "-" as the old path means "no previous version" (first run) — in that case
 * nothing is reported as new, because reporting 287 jobs as new is noise.
 *
 * Writes the message to stdout and sets these GitHub Actions outputs:
 *   changed = true|false   — whether anything worth sending happened
 *   message = <the text>   — via $GITHUB_OUTPUT heredoc
 *
 * Outside GitHub Actions, set NOTIFY_CHANGED_FILE=<path> to have the same
 * changed verdict written to that file as "true"/"false".
 *
 * Exit code is always 0 unless the inputs are unreadable. A diff with no
 * changes is a normal outcome, not a failure.
 */
import fs from "node:fs";

const [oldPath, newPath, runPath] = process.argv.slice(2);
if (!newPath) {
  console.error("usage: notify-diff.mjs <old|-> <new> [last-run.json]");
  process.exit(2);
}

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return null; }
};

const prev = oldPath === "-" ? null : readJson(oldPath);
const next = readJson(newPath);
if (!next?.jobs) { console.error("cannot read new jobs.json"); process.exit(2); }

const lastRun = runPath ? readJson(runPath) : null;

// ---------- diff ----------
const prevById = new Map((prev?.jobs ?? []).map((j) => [j.id, j]));
const nextById = new Map(next.jobs.map((j) => [j.id, j]));

const isFirstRun = prev === null;
const added = isFirstRun ? [] : next.jobs.filter((j) => !prevById.has(j.id));

// A vanished row is only routine when the run says it deleted that exact id on
// purpose — a confirmed-dead Értesítő / NFJ keresés row (check-liveness.mjs
// proves death, docs/refresh-task.md authorises the delete). Anything else that
// vanished is still unexplained and still shouts, which is the whole point of
// the warning below: silent row loss must never look like routine cleanup.
//
// Added 2026-08-01. check-liveness.mjs (2026-07-30) made deletion legitimate
// two days after this script was written, and nothing taught the diff about it
// — so every liveness cleanup fired "ez nem várt, nézd meg" at a run that had
// done exactly what it was told. 35 rows in one run, all correct, all flagged.
// A warning that cries wolf on correct behaviour stops being read.
//
// The list is deliberately per-id rather than a count: a run that cleans 35
// dead rows AND loses one row to a bug still reports that one row.
const cleanedIds = new Set(
  Array.isArray(lastRun?.cleanedDeadIds) ? lastRun.cleanedDeadIds : []);
const vanished = isFirstRun ? [] : (prev.jobs ?? []).filter((j) => !nextById.has(j.id));
const cleaned = vanished.filter((j) => cleanedIds.has(j.id));
const removed = vanished.filter((j) => !cleanedIds.has(j.id));

// status transitions worth knowing about: something you were only watching is now saved
const promoted = isFirstRun ? [] : next.jobs.filter((j) => {
  const p = prevById.get(j.id);
  return p && p.status !== "Mentett" && j.status === "Mentett";
});

// newly archived: crossed the 14-day lastSeen threshold between the two snapshots
const ARCHIVE_DAYS = 14;
const ageOf = (iso) => {
  const d = new Date(iso + "T00:00:00");
  return isNaN(d) ? Infinity : Math.floor((Date.now() - d.getTime()) / 86400000);
};
const newlyArchived = isFirstRun ? [] : next.jobs.filter((j) => {
  const p = prevById.get(j.id);
  return p && ageOf(p.lastSeen) <= ARCHIVE_DAYS && ageOf(j.lastSeen) > ARCHIVE_DAYS;
});

// newly closed: the liveness probe proved the ad is gone and apply-dead.mjs
// stamped `closed`. public/app.js:93 archives on EITHER flag —
// `j.archived = !!j.closed || j.ageSeen > ARCHIVE_DAYS` — but this script only
// ever tracked the 14-day half, so a closure was invisible here.
//
// Added 2026-08-23, the same shape of miss as the `cleaned` case above: the
// `closed` flag arrived 2026-08-11 and nothing taught the diff about it. Dead
// feed rows are DELETED and so surfaced as `cleaned`; dead saved rows are
// closed instead, so they left the triage list reporting nothing at all — and
// a run whose only change was a closure went out entirely silent, because
// `changed` never saw it either. Observed 2026-08-23 13:02: a hand-saved Lead
// AI Engineer row was archived and no digest was sent.
//
// Only ever `Mentett` in practice (101/101 rows carrying the flag on
// 2026-08-23) — docs/refresh-task.md deletes dead feed rows rather than
// closing them — which is exactly why these are worth enumerating: every one
// is a job the user saved by hand.
const newlyClosed = isFirstRun ? [] : next.jobs.filter((j) => {
  const p = prevById.get(j.id);
  return p && !p.closed && !!j.closed;
});

// `cleaned` counts as a change even though it is routine: a cleanup-only run
// still moves the total, and staying silent would leave the next message's
// "előző" figure unexplained.
const changed = added.length > 0 || removed.length > 0 || cleaned.length > 0 ||
                newlyArchived.length > 0 || promoted.length > 0 ||
                newlyClosed.length > 0;

// ---------- format ----------
const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const money = (j) => {
  const f = (n) => (n / 1e6).toFixed(2).replace(/0$/, "").replace(/\.$/, "");
  const band = j.salaryLo === j.salaryHi ? `${f(j.salaryLo)}M` : `${f(j.salaryLo)}–${f(j.salaryHi)}M`;
  const unit = j.type === "Contract" ? "nettó" : "br.";
  return j.salaryPosted ? `${band} ${unit} ✓hirdetett` : `${band} ${unit} ~becslés`;
};

// Priority signal: the target-role families plus anything reaching into the top band.
const PRIORITY = new Set(["DevOps", "Architecture", "Security", "Artificial Intelligence"]);
const isPriority = (j) => PRIORITY.has(j.category) || j.salaryHi >= 2_000_000;

// Demoted categories: counted in "Új (N)" but never enumerated — the digest's
// 12 lines are too scarce for a family that is 83% "Nem érdekel" (measured on
// the 2026-08-07 tracker export; the kept 17% is why it is demoted, not
// dropped). Same sync rule as PRIORITY: duplicated in public/app.js
// (DEMOTED_CATEGORIES), change both or neither.
const DEMOTED = new Set(["Business Analyst"]);
const isDemoted = (j) => DEMOTED.has(j.category);

// Source-agnostic on purpose: Indeed rows (v2) need nothing of their own. A
// repost of an ad the owner ignored is shown flagged (docs/architecture-v2.md),
// so the digest flags it too — same rule as the dashboard's "újrafeladás" tag.
const line = (j) => {
  const star = isPriority(j) ? "⭐ " : "• ";
  return `${star}<a href="${esc(j.url)}">${esc(j.role)}</a>${j.repostOf ? " ↻ újrafeladás" : ""}\n` +
         `   ${esc(j.company)} · ${esc(j.category)} · ${money(j)}`;
};

const parts = [];
const total = next.jobs.length;
const prevTotal = prev?.jobs?.length ?? 0;
const delta = isFirstRun ? "" : ` (előző: ${prevTotal}${total !== prevTotal ? `, ${total > prevTotal ? "+" : ""}${total - prevTotal}` : ""})`;

// Section order is deliberate (changed 2026-07-29): the run's judgement and
// the warnings are the parts a reader cannot reconstruct from the site, so
// they come first and are never truncated. The new-item list is the cheap
// tail — it fills whatever character budget remains, because the full list
// is one tap away on the dashboard anyway. A 136-item run previously pushed
// the warnings past Telegram's 4096-char cap and they were cut off entirely.

parts.push(`<b>Álláslista frissült</b> — ${total} hirdetés${delta}`);

// The refresh task's own qualitative note, if it left one.
if (lastRun?.summary) {
  parts.push(`\n<b>A futás értékelése</b>\n${esc(lastRun.summary).slice(0, 1500)}`);
}
if (lastRun?.warnings?.length) {
  parts.push(`\n⚠️ <b>Figyelmeztetés</b>\n` +
    lastRun.warnings.map((w) => `• ${esc(w)}`).join("\n"));
}

if (promoted.length) {
  parts.push(`\n<b>Elmentetted (${promoted.length})</b>\n` +
    promoted.slice(0, 8).map((j) => `• ${esc(j.role)} — ${esc(j.company)}`).join("\n"));
}

if (newlyArchived.length) {
  parts.push(`\n<b>Archívba került (${newlyArchived.length})</b> — 14+ napja nem látható egyik forrásban sem\n` +
    newlyArchived.slice(0, 8).map((j) => `• ${esc(j.role)} — ${esc(j.company)}`).join("\n"));
}

// Enumerated, unlike `cleaned` below: every one of these is a row the user
// saved by hand, and "the ad you were tracking is gone" is the most actionable
// line the digest carries. The overflow note is deliberate — the sections
// above truncate at 8 silently, and a silently dropped closure is the exact
// failure this section exists to fix.
if (newlyClosed.length) {
  parts.push(`\n<b>Mentett hirdetés megszűnt (${newlyClosed.length})</b> — a liveness igazolta, hogy lekerült a portálról; azonnal archívba került\n` +
    newlyClosed.slice(0, 8).map((j) => `• ${esc(j.role)} — ${esc(j.company)}`).join("\n") +
    (newlyClosed.length > 8 ? `\n<i>…és további ${newlyClosed.length - 8}.</i>` : ""));
}

// One line, no enumeration: these are ads that provably no longer exist, the
// count already explains the drop in the total, and the run's own summary says
// anything interesting about them (e.g. one employer pulling its whole
// portfolio). Listing 8 dead ads here would only cost budget that the "Új"
// section below spends better.
if (cleaned.length) {
  parts.push(`\n<b>Halott hirdetés takarítva (${cleaned.length})</b> — a hirdető visszavonta, nincs teendő`);
}

if (removed.length) {
  parts.push(`\n<b>Eltűnt a fájlból (${removed.length})</b> — ez nem várt, nézd meg\n` +
    removed.slice(0, 8).map((j) => `• ${esc(j.role)} — ${esc(j.company)}`).join("\n"));
}

const FOOTER = `\n<a href="https://jobs.toomhorvath.com">Megnyitás</a>`;
const LIMIT = 3950; // Telegram hard cap is 4096; leave headroom for the footer

if (added.length) {
  // priority first, then by salary ceiling; demoted categories never enumerated
  const demotedCount = added.filter(isDemoted).length;
  const sorted = added.filter((j) => !isDemoted(j)).sort((a, b) =>
    (isPriority(b) - isPriority(a)) || (b.salaryHi - a.salaryHi));
  const head = `\n<b>Új (${added.length})</b>`;
  // Fill the remaining budget line by line, max 12 items as before.
  let used = parts.join("\n").length + head.length + FOOTER.length + 80; // 80: remainder note
  const shown = [];
  for (const j of sorted) {
    const l = line(j);
    if (shown.length >= 12 || used + l.length + 1 > LIMIT) break;
    shown.push(l);
    used += l.length + 1;
  }
  // Head goes out even with zero enumerable lines — a run whose additions are
  // all demoted must still say "Új (N)", not leave an orphan remainder note.
  parts.push(shown.length ? head + "\n" + shown.join("\n") : head);
  const rest = added.length - shown.length;
  if (rest > 0) {
    parts.push(`<i>…és további ${rest} tétel a listán${
      demotedCount ? ` (ebből ${demotedCount} üzleti elemző)` : ""}.</i>`);
  }
}

parts.push(FOOTER);

let message = parts.join("\n");
// Safety net only — the budgeting above should keep us under the cap.
if (message.length > 4000) message = message.slice(0, 3950) + "\n…<i>(levágva)</i>";

// ---------- output ----------
process.stdout.write(message + "\n");

if (process.env.GITHUB_OUTPUT) {
  const d = "EOF_" + Math.random().toString(36).slice(2);
  fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `changed=${changed}\nmessage<<${d}\n${message}\n${d}\n`);
}

// The VM-side sender (scripts/notify-telegram.sh) needs the same verdict but
// has no $GITHUB_OUTPUT to read it from, and the message already comes back on
// stdout — so only the boolean needs a channel. Parsing it off the stderr
// summary below would work today and break the first time that line is
// reworded; this is the explicit contract instead.
if (process.env.NOTIFY_CHANGED_FILE) {
  fs.writeFileSync(process.env.NOTIFY_CHANGED_FILE, `${changed}\n`);
}

console.error(`[notify-diff] total=${total} added=${added.length} removed=${removed.length} ` +
              `cleaned=${cleaned.length} promoted=${promoted.length} ` +
              `archived=${newlyArchived.length} closed=${newlyClosed.length} ` +
              `changed=${changed}` +
              (isFirstRun ? " (first run — additions suppressed)" : ""));
