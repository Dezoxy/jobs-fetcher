# Architecture

## System

jobs-dashboard

## Purpose

A private job-search dashboard for one person: a daily run collects job ads,
has Claude judge the new ones and keeps the list; the owner reads it and
tracks each job behind Cloudflare Access.

The binding contract of the current (v2) architecture is
[architecture-v2.md](../architecture-v2.md). This folder explains it; where the
two disagree, the contract wins and this folder is wrong.

## Architecture model

- [workspace.dsl](workspace.dsl) — entry point (fragments in [model/](model/))
- `make check` validates and inspects the model with the pinned Structurizr
  image; `make view` serves it at <http://localhost:8080/workspace/1>. Both need
  Docker.
- [model/styles-shared.dsl](model/styles-shared.dsl) is copied unchanged from
  development-base; change it there first.

## Important views

| View | Question it answers |
|---|---|
| SystemContext | What does jobs-dashboard depend on, and who uses it? |
| Containers | What runs, and which stores does each part read and write? |
| RefreshRun | What happens during one daily refresh run? |
| Access | Who can reach the Worker, and where is each caller checked? |
| Secrets | Where do the jobs' credentials come from, and what does each one unlock? |
| Delivery | How does a merged change reach the running jobs and the Worker? |
| Deployment | Where does it run, and what fails together? |

### View register

Budgets come from development-base's `architecture-views` skill: 7 elements /
8 arrows for an audience overview, 10/12 for a technical view, 7 participants /
8 interactions for a runtime scenario, 12 boxes / 8 arrows for deployment.
Counts (elements / arrows) are from the exported workspace JSON. Omissions are listed
so a focused view is not mistaken for the whole system.

| Key | Audience | Count (budget) | Omits, and where it lives | Update trigger |
|---|---|---|---|---|
| SystemContext | Everyone | 7 / 8 (7/8) | Email Routing and the alert path (Access); Entra (Secrets); delivery tooling (Delivery); the Worker's key fetch from Access (Access) | A source, a reader or an external dependency changes |
| Containers | Engineers | 9 / 11 (10/12) | External systems (SystemContext, RefreshRun); Key Vault (Secrets, Deployment); Access (Access) | A container, a store or who writes it changes |
| RefreshRun | Engineers | 7 / 7 (7/8) | The `employee-cv` fetch before `run.mjs` starts, the opening KV re-put and the `already_completed` exit; described in the [overview](overview/01-jobs-dashboard.md#one-refresh-run) | Run order, guards or failure handling change |
| Access | Owner, reviewer | 6 / 8 (10/12) | The stores behind the Worker (Containers); runner credentials (Secrets) | Exposure, Access policy or `email()` verification changes |
| Secrets | Owner, reviewer | 9 / 9 (10/12) | The tracker and snapshot, reached with the same Cloudflare token as Job Data; the registry pull token (Delivery); the Worker's own secrets (Access, [threat model](security/threat-model.md)) | A credential, identity or its scope changes |
| Delivery | Operators | 8 / 10 (10/12) | Everything during a run; the operator plan/apply path for infrastructure (prose in [ADR 8](decisions/0008-release-by-tag-deploy-by-renovate-pin.md)) | The release or deploy procedure changes |
| Deployment | Operators, reviewer | 12 / 0 (12/8) | Every arrow: each automatic layout drew the Azure-to-Cloudflare arrows through the Worker and Snapshot boxes, so the view shows placement only (arrows in Containers, the cross-cloud dependency in the [overview](overview/01-jobs-dashboard.md#where-it-runs-and-what-fails-together)); the UI files (served with the Worker); Log Analytics and alerts (overview, Observability) | Hosting, region or placement changes |

**Visual verification** (2026-11-25, rendered with the pinned image's
`-playwright` twin, `structurizr/structurizr:2026.10.26-playwright`, into a
temporary folder, and read at full size): no arrow runs through an unrelated
box in any view. Remaining flaws, all traceable: in Containers the Worker's
tracker arrow crosses the runner's arrows; in Secrets the runner's Key Vault
arrow crosses the backup job's export arrow; in Access the Email Routing arrow
crosses the system boundary below the "Verifies the assertion" label.
RefreshRun and Secrets use `tb` with a 600 rank separation and Containers `tb`
because `lr` drew arrows through the external boxes. Re-check with `make view`
after any view change.

## Key decisions

- [0001 Run the refresh as an Azure Container Apps Job](decisions/0001-run-refresh-as-azure-container-apps-job.md) (accepted, amended by 0002)
- [0002 D1 is the data plane and GitHub is code only](decisions/0002-d1-data-plane-github-code-only.md) (accepted)
- [0003 Keep the tracker in its own D1 database](decisions/0003-tracker-in-its-own-d1-database.md) (accepted)
- [0004 Judge with a tool-less JSON-schema Claude call, merge in code](decisions/0004-tool-less-json-schema-judge.md) (accepted)
- [0005 Verify the Access JWT in the Worker as a second lock](decisions/0005-verify-access-jwt-in-worker.md) (accepted)
- [0006 Ingest LinkedIn alert e-mails, DMARC-verified, and not No Fluff Jobs](decisions/0006-ingest-linkedin-alert-emails.md) (accepted)
- [0007 Number releases by calendar (vYYYY.M.N)](decisions/0007-calendar-versioning.md) (accepted)
- [0008 Release by tag, deploy by a Renovate pin bump through the guard](decisions/0008-release-by-tag-deploy-by-renovate-pin.md) (accepted)
- [0009 Move the code to a public jobs-fetcher repository](decisions/0009-public-jobs-fetcher-repository.md) (accepted)

New ADR: copy [templates/adr.md](templates/adr.md) to
`decisions/NNNN-short-title.md`. Keep this index up to date; there is
deliberately no README inside `decisions/`, because the ADR importer parses
every `.md` file in that folder.

## Written documentation

| Area | Documents |
|---|---|
| Narrative (opens the Documentation tab) | [01 overview](overview/01-jobs-dashboard.md) |
| Security | [Threat model: Worker endpoints and runner credentials](security/threat-model.md) |
| Contract | [architecture-v2.md](../architecture-v2.md): schemas, judge, runner, cutover |
| Operations | [Azure image deployment](../azure-image-deployment.md), [Azure operator runbook](../azure-migration.md) |

Only `overview/` is imported into the model by `!docs`; the threat model
reaches it as a symlink, `overview/02-threat-model.md`. `pdf-sections.txt`
stays empty.

## Not documented here

The v1 pipeline (`refresh-run.sh`, the Blob state machine, git publishing),
retired on 2026-11-25; it is described in the repository
[README](../../README.md) and [refresh-task.md](../refresh-task.md) until the
cutover's step 4 removes it.
