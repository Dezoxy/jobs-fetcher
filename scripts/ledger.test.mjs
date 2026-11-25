// Tests for the ledger's release rule. `npm test` (node --test, no deps).
//
// The ledger is append-only everywhere else, so planRelease is the one code
// path that can put an ad back in front of the fetcher — a prefix check that
// widens by accident resurrects dead or merged ads with no error anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planRelease, releaseLedger, readLedger } from "./ledger.mjs";

// Reasons as they stood on the refresh VM on 2026-09-15 for saved tracker ids.
const LEDGER = {
  "li-4456333116": "tracker:ignored",        // MOL, saved 09-04, alive
  "li-4433182106": "tracker:rejected",
  "li-4457755682": "dead:liveness-confirmed", // saved, but the ad is gone
  "pr-1": "dedupe:li-2",
  "pr-2": "fit:german",
  "pr-3": "legacy",
};

test("release: only tracker verdicts are released", () => {
  const { released, held } = planRelease(LEDGER, Object.keys(LEDGER));
  assert.deepEqual(released, ["li-4456333116", "li-4433182106"]);
  assert.deepEqual(held, {
    "li-4457755682": "dead:liveness-confirmed",
    "pr-1": "dedupe:li-2",
    "pr-2": "fit:german",
    "pr-3": "legacy",
  });
});

test("release: ids not in the ledger are neither released nor held", () => {
  assert.deepEqual(planRelease(LEDGER, ["li-999"]), { released: [], held: {} });
});

test("releaseLedger: removes released ids, keeps the rest, honours dryRun", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), "rejected-ids.json");
  fs.writeFileSync(file, JSON.stringify({ ids: LEDGER }));

  releaseLedger(file, ["li-4456333116", "li-4457755682"], { dryRun: true });
  assert.deepEqual(readLedger(file), LEDGER);

  releaseLedger(file, ["li-4456333116", "li-4457755682"]);
  const after = readLedger(file);
  assert.equal("li-4456333116" in after, false);
  assert.equal(after["li-4457755682"], "dead:liveness-confirmed");
  assert.equal(Object.keys(after).length, Object.keys(LEDGER).length - 1);
});
