// Where the containers run in production. There is no other environment: pull
// requests run tests only, and the Worker has no preview URLs.

production = deploymentEnvironment "Production" {

    deploymentNode "Cloudflare" "One account. The Worker answers only on the custom hostname behind Access; workers.dev and preview URLs are disabled." "Cloudflare global network" {
        containerInstance jobsDashboard.snapshot
        deploymentNode "D1, EU jurisdiction" "Free plan: 7-day Time Travel per database." "Cloudflare D1" {
            containerInstance jobsDashboard.jobsDb
            containerInstance jobsDashboard.trackerDb
        }
        containerInstance jobsDashboard.worker
    }

    deploymentNode "Azure West Europe" "One subscription. Runtime, backup and Terraform state each in their own resource group." "Microsoft Azure" {
        deploymentNode "Container Apps environment" "Consumption profile; each job 0.5 vCPU / 1 GiB, parallelism 1, no platform retries." "Azure Container Apps" {
            containerInstance jobsDashboard.runner
            containerInstance jobsDashboard.backupJob
        }
        containerInstance jobsDashboard.keyVault
        containerInstance jobsDashboard.backupStore
    }
}
