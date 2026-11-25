// People and the systems around jobs-dashboard. Everything here except
// jobs-dashboard itself is outside this repository. "Existing System" marks a
// service the owner configures elsewhere (the separate Cloudflare Terraform
// repository, the employee-cv repository); "External" marks a third party.

owner = person "Owner" "Looks for a job: reviews the dashboard, marks jobs in the tracker and reads the Telegram digest."

jobPortals = softwareSystem "Job Portals" "Profession.hu, No Fluff Jobs, LinkedIn (guest endpoints and job-alert e-mails) and Indeed Hungary. Their pages are untrusted input." "External"
claude = softwareSystem "Claude" "Anthropic's model. Judges each new ad as a tool-less, JSON-schema call: subscription first, API as the fallback." "External"
telegram = softwareSystem "Telegram" "Bot API. Carries the change digest to the owner's chat." "External"
employeeCv = softwareSystem "employee-cv" "Private repository with the owner's target roles and salary benchmarks." "Existing System"

access = softwareSystem "Cloudflare Access" "Zero Trust application in front of the dashboard hostname. Signs the owner in and forwards each request with a signed JWT assertion. Managed in the separate Cloudflare Terraform repository." "Existing System,Internet-exposed"
emailRouting = softwareSystem "Cloudflare Email Routing" "Receives mail for the alert address, prepends its own Authentication-Results (SPF, DKIM, DMARC) and hands the message to the Worker." "Existing System,Internet-exposed"
entra = softwareSystem "Microsoft Entra ID" "Issues managed-identity tokens. The Claude API fallback trusts them through workload identity federation." "External"

github = softwareSystem "GitHub" "The public Dezoxy/jobs-fetcher repository and its Actions workflows. Holds code only since v2; no job data. The private jobs-dashboard repository is the archive (ADR 9)." "External"
ghcr = softwareSystem "GitHub Container Registry" "Registry for the refresh image ghcr.io/dezoxy/jobs-fetcher, tagged vYYYY.M.N and deployed by digest." "External"
renovate = softwareSystem "Renovate" "Dependency bot. Opens the pull request that pins a new release image." "External"
workersBuilds = softwareSystem "Cloudflare Workers Builds" "Builds and deploys the Worker and its static assets on every push to main." "External"

owner -> access "Signs in through" "HTTPS, Access login"
telegram -> owner "Delivers the change digest to" "Telegram app"
jobPortals -> emailRouting "Sends LinkedIn job-alert e-mails to" "SMTP" "Inbound across trust boundary"

owner -> github "Reviews and merges pull requests in" "HTTPS"
github -> ghcr "Tags a release, then builds and pushes its image to" "GitHub Actions, GITHUB_TOKEN"
renovate -> ghcr "Looks up new release tags and their digests in" "OCI registry API"
renovate -> github "Opens and automerges the image pin pull request in" "GitHub API"
workersBuilds -> github "Builds every push to main from" "GitHub app"
