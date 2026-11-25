// Each view answers one question. Budgets from development-base's
// architecture-views skill: 7 elements/8 arrows for an audience overview, 10/12
// for a technical structural view, 7 participants/8 interactions for a runtime
// scenario, 12 boxes/8 arrows for deployment. The register in ../README.md
// records each view's question, its counts and what it leaves out.

systemContext jobsDashboard "SystemContext" "What does jobs-dashboard depend on, and who uses it?" {
    include owner jobsDashboard access jobPortals claude telegram employeeCv
    // The Worker's key fetch from Access is the Access view's question.
    exclude "jobsDashboard -> access"
    autoLayout lr
}

container jobsDashboard "Containers" "What runs, and which stores does each part read and write?" {
    include owner
    include jobsDashboard.ui jobsDashboard.worker jobsDashboard.snapshot jobsDashboard.jobsDb jobsDashboard.trackerDb
    include jobsDashboard.runner jobsDashboard.backupJob jobsDashboard.backupStore
    autoLayout tb 600 300
}

// The employee-cv fetch happens in cloud-run.mjs before run.mjs starts, and the
// opening KV re-put of the last snapshot is a self-heal, not part of the flow;
// both are described in the overview instead of drawn.
dynamic jobsDashboard "RefreshRun" "What happens during one daily refresh run?" {
    jobsDashboard.runner -> jobsDashboard.jobsDb "Reads jobs, verdicts, streaks, e-mail candidates and runs in one consistent batch"
    jobsDashboard.runner -> jobsDashboard.trackerDb "Reads the tracker; a positive status releases tracker: and fit: verdicts"
    jobsDashboard.runner -> jobPortals "Collects candidates, checks liveness, fetches ad text for new ones only"
    jobsDashboard.runner -> claude "Judges the new candidates, 20 per tool-less JSON-schema call"
    jobsDashboard.runner -> jobsDashboard.jobsDb "Commits the merged result in one batch, runs row first"
    jobsDashboard.runner -> jobsDashboard.snapshot "Puts last-run.json, then jobs.json"
    jobsDashboard.runner -> telegram "Sends the digest when the list changed, assumed delivered"
    autoLayout tb 600 300
}

container jobsDashboard "Access" "Who can reach the Worker, and where is each caller checked?" {
    include owner access emailRouting jobPortals
    include jobsDashboard.ui jobsDashboard.worker
    autoLayout lr
}

container jobsDashboard "Secrets" "Where do the jobs' credentials come from, and what does each one unlock?" {
    include jobsDashboard.runner jobsDashboard.backupJob jobsDashboard.keyVault
    include jobsDashboard.jobsDb jobsDashboard.backupStore
    include entra claude telegram employeeCv
    autoLayout tb 600 300
}

// None of this happens during a run.
container jobsDashboard "Delivery" "How does a merged change reach the running jobs and the Worker?" {
    include owner github ghcr renovate workersBuilds
    include jobsDashboard.runner jobsDashboard.backupJob jobsDashboard.worker
    autoLayout lr
}

// Placement only: every automatic layout drew the Azure-to-Cloudflare arrows
// through the Worker and Snapshot boxes. The arrows are the Containers view's
// question; the cross-cloud dependency is stated in the overview.
deployment jobsDashboard "Production" "Deployment" "Where does it run, and what fails together?" {
    include *
    exclude "* -> *"
    autoLayout tb
}
