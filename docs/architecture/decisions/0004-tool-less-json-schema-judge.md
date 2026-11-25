# 4. Judge with a tool-less JSON-schema Claude call, merge in code

Date: 2026-11-24

## Status

Accepted

Live since the v2 switch on 2026-11-24.

## Context

In v1, `refresh-run.sh` started a Claude agent with shell access and
`bypassPermissions` that read the collected candidates and the scraped ad text,
then edited `jobs.json` itself, following the rules in
[refresh-task.md](../../refresh-task.md). The ad text is written by whoever
posts the ad. An agent that reads it and can run commands is a
prompt-injection surface. The merge rules lived in a prompt, so they could not
be unit-tested, and the agent could exit 0 having changed nothing (exit 10,
retried once).

The judgement itself still needs a model: whether an ad fits the target roles,
its category, an estimated salary band when none is posted, a short
description, and whether it duplicates a known ad.

## Decision drivers

- Untrusted ad text must not be able to run anything.
- Every rule that can be code is code, and tested.
- An answer the code cannot validate is never kept by default.
- Keep the Claude subscription as the primary path.

## Considered options

1. Keep the agentic merge.
2. A tool-less, schema-constrained judge for the new candidates only, with
   the merge done by deterministic code.

## Decision

Option 2. `scripts/v2/judge.mjs` runs one `claude --print` per batch of at most
20 new candidates with `--tools ""`, an empty MCP configuration,
`--json-schema`, no session persistence, in an empty temporary directory.
Candidates go in on stdin as one JSON block with `<` and `>` escaped; the
judge prompt is [judge-prompt.md](../../judge-prompt.md). Code then checks
every verdict (id from the batch, vocabulary, salary range, `reason` format,
`duplicateOf` among that candidate's possible twins); a posted salary overrides
the model's. A candidate without a valid verdict stays unjudged and is retried
next run. `judgeVersion` (a hash of prompt and schema) is stored with every
`fit:` verdict.

`scripts/v2/merge.mjs` applies the verdicts, the ledger, tracker releases,
liveness and reposts as pure functions under test.

Authentication goes through `scripts/claude-cli.mjs`: the subscription OAuth
token first, then each configured fallback model on the Claude API with a
token obtained through Azure workload identity federation. Only a CLI failure
falls back; an unparseable answer does not.

## Consequences

Positive:

- The model's output is data checked by code. Ad text cannot reach a shell,
  the file system or a network tool.
- Merge rules are covered by `merge.test.mjs` and `run.test.mjs`.
- Only new candidates go to the model; existing rows are merged by code.

Negative / accepted trade-offs:

- An ad can still steer its own verdict: keep itself, shape its description or
  its estimated salary. The impact stays inside the owner's list and digest.
- A prompt or schema change creates a new `judgeVersion`; old `fit:` verdicts
  are not re-judged automatically.
- Two authentication paths to maintain.

## Risks

- A model outage for every leg leaves the new candidates unjudged; they are
  retried next run and the run exits 8.

## Related

- Architecture views: RefreshRun, Secrets.
- Other ADRs: [2](0002-d1-data-plane-github-code-only.md).
