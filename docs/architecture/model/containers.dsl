// jobs-dashboard after the v2 switch (2026-11-24): a Cloudflare edge half (the
// static UI, the Worker, two D1 databases and the snapshot KV) and an Azure
// half (two scheduled Container Apps Jobs, Key Vault and the backup account).
// The v1 Azure Blob state account and the git-hosted job list were retired in
// cutover step 4 (2026-11-25).
// docs/architecture-v2.md is the binding contract for every name used here.

jobsDashboard = softwareSystem "jobs-dashboard" "Collects job ads every day, has Claude judge the new ones, keeps the list and the owner's tracker, and shows both behind Cloudflare Access." {

    ui = container "Dashboard UI" "The page the owner reads: filters, archive, tracker statuses. Static files served by the Workers assets layer without running the Worker, so Access is their only lock." "HTML, JavaScript (public/)" "Layer Edge,Web UI"
    worker = container "Worker" "Serves /data/* from the snapshot and /api/tracker from D1, after its own Access JWT check; its email() handler turns verified LinkedIn alerts into candidate ids. src/worker.js, src/access.js, src/email.js." "Cloudflare Worker, JavaScript" "Layer Edge"

    jobsDb = container "Job Data" "D1 jobs-data: jobs, the verdict ledger, unseen streaks, one runs row per slot, and e-mail candidates." "Cloudflare D1 (SQLite), EU jurisdiction" "Layer Data,Database"
    trackerDb = container "Tracker" "D1 jobs-tracker: the owner's per-job status (saved, applied, ignored, ...). Separate so restoring job data never rewinds the owner's clicks." "Cloudflare D1 (SQLite), EU jurisdiction" "Layer Data,Database"
    snapshot = container "Snapshot" "KV jobs-snapshot: jobs.json and last-run.json exactly as the runner rendered them. The Worker streams them unparsed." "Cloudflare Workers KV" "Layer Data,Storage"

    runner = container "Refresh Runner" "Container Apps Job jobs-refresh, daily 13:00 UTC, stateless. cloud-run.mjs refresh starts scripts/v2/run.mjs: collect, prefetch, judge, merge, validate, commit, notify." "Node.js, Python (JobSpy), Claude CLI" "Layer Runtime"
    backupJob = container "Backup Job" "Container Apps Job jobs-backup, daily 04:15 UTC. Exports both D1 databases to the backup account, write-once and checksum-verified. scripts/v2/backup.mjs." "Node.js" "Layer Runtime"

    keyVault = container "Key Vault" "Holds the jobs' credentials by name; values never enter Terraform. Resolved at job start through each job's managed identity." "Azure Key Vault, RBAC, purge protection" "Layer Data,Storage"
    backupStore = container "Backup Storage" "Separate storage account and resource group; only the backup-writer identity can write. 30-day copy retention." "Azure Blob Storage, LRS" "Layer Data,Storage"

    ui -> worker "Fetches the job list and run note, reads and replaces the tracker through" "HTTPS/JSON, behind Access"
    worker -> snapshot "Streams jobs.json and last-run.json from" "KV binding"
    worker -> trackerDb "Reads and replaces the tracker map in" "D1 binding, one batch per write"
    worker -> jobsDb "Stores verified alert job ids in" "D1 binding, INSERT OR IGNORE"

    runner -> jobsDb "Reads state from, and commits each run in one batch to" "Cloudflare REST API, account-wide D1/KV token"
    runner -> trackerDb "Reads tracker statuses from" "Cloudflare REST API, account-wide D1/KV token"
    runner -> snapshot "Writes last-run.json, then jobs.json, to" "Cloudflare REST API, account-wide D1/KV token"

    backupJob -> jobsDb "Exports" "Cloudflare REST API, the same account-wide token"
    backupJob -> trackerDb "Exports" "Cloudflare REST API, the same account-wide token"
    backupJob -> backupStore "Writes the nightly export to" "Blob API, backup-writer identity"

    runner -> keyVault "Has its secrets resolved at start from" "Key Vault reference, runner identity"
    backupJob -> keyVault "Has the Cloudflare token and the registry pull token resolved from" "Key Vault reference, backup-writer identity"
}

access -> jobsDashboard.ui "Admits only the signed-in owner to" "HTTPS"
access -> jobsDashboard.worker "Forwards /data/* and /api/* with a signed JWT assertion to" "HTTPS, Cf-Access-Jwt-Assertion"
jobsDashboard.worker -> access "Verifies the assertion against the signing keys of" "HTTPS, JWKS cached 1 h"
emailRouting -> jobsDashboard.worker "Delivers each alert, with its DMARC verdict, to" "Email Workers, Authentication-Results"
owner -> jobsDashboard.ui "Reviews jobs and sets tracker statuses in" "Browser"

jobsDashboard.runner -> employeeCv "Fetches the target roles and salary benchmarks from" "git over SSH, CV deploy key"
jobsDashboard.runner -> jobPortals "Collects ads, checks liveness and fetches ad text from" "HTTPS" "Inbound across trust boundary"
jobsDashboard.runner -> claude "Asks for a fit verdict on each new ad, 20 per call" "Claude CLI, OAuth token; API via federation"
jobsDashboard.runner -> entra "Gets a federated token for the API fallback from" "Managed identity"
jobsDashboard.runner -> telegram "Sends the digest, only when the list changed" "HTTPS, Bot API token"

github -> jobsDashboard.runner "Applies the guarded image-only plan to" "Terraform over OIDC"
github -> jobsDashboard.backupJob "Applies the guarded image-only plan to" "Terraform over OIDC"
jobsDashboard.runner -> ghcr "Pulls its image by digest from" "Registry pull token"
jobsDashboard.backupJob -> ghcr "Pulls its image by digest from" "Registry pull token"
workersBuilds -> jobsDashboard.worker "Deploys the Worker and the UI files on each push to main to" "Workers deploy"
