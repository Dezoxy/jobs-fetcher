variable "resource_group_name" {
  type    = string
  default = "jobs-dashboard-westeurope"
}

variable "location" {
  type    = string
  default = "westeurope"
  validation {
    condition     = var.location == "westeurope"
    error_message = "This reviewed migration targets West Europe. Review residency and pricing before changing region."
  }
}

variable "backup_resource_group_name" {
  description = "Separate resource group for recovery copies outside the runtime account."
  type        = string
  default     = "jobs-dashboard-backups-westeurope"
  validation {
    condition     = lower(var.backup_resource_group_name) != lower(var.resource_group_name)
    error_message = "Recovery copies require a separate resource group from the runtime."
  }
}

variable "backup_storage_account_name" {
  description = "Globally unique recovery storage name, different from the runtime account."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.backup_storage_account_name))
    error_message = "Backup storage names require 3-24 lowercase letters/digits."
  }
}

variable "image" {
  description = "Immutable GHCR release digest. Replace the VM baseline with the tested migration release before executing any job."
  type        = string
  default     = ""
  validation {
    condition     = var.image == "" ? !var.jobs_enabled : can(regex("^ghcr\\.io/dezoxy/jobs-fetcher@sha256:[0-9a-f]{64}$", var.image))
    error_message = "Jobs require the verified immutable release digest; an empty image is allowed only for the foundation."
  }
}

variable "image_version" {
  description = "Release tag of var.image (without the v). Renovate reads it to find newer releases and bumps it together with the digest; it is not deployed."
  type        = string
  default     = ""
  validation {
    condition     = var.image_version == "" || can(regex("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$", var.image_version))
    error_message = "image_version is a release tag such as 2026.11.0."
  }
}

variable "jobs_enabled" {
  description = "False prepares the foundation and empty vault. Enable only after every required secret has been copied and verified."
  type        = bool
  default     = false
}

variable "schedules_enabled" {
  description = "False creates Manual jobs. True replaces them with Scheduled jobs."
  type        = bool
  default     = false
  validation {
    condition     = !var.schedules_enabled || var.jobs_enabled
    error_message = "Schedule activation requires jobs_enabled after the dedicated vault secrets are copied and verified."
  }
}

variable "key_vault_name" {
  description = "Globally unique name of the dedicated jobs vault created by this stack."
  type        = string
  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$", var.key_vault_name)) && !strcontains(var.key_vault_name, "--")
    error_message = "Vault names require 3-24 letters/digits/hyphens, start with a letter and cannot contain consecutive hyphens."
  }
}

variable "secret_names" {
  description = "Runtime environment name -> secret name in the dedicated jobs vault. Secret values are copied separately and never managed by Terraform."
  type        = map(string)
  validation {
    condition = alltrue([
      for name, secret_name in var.secret_names :
      can(regex("^[A-Z][A-Z0-9_]*$", name)) && can(regex("^[a-zA-Z0-9-]{1,127}$", secret_name))
    ])
    error_message = "Use uppercase environment names and Azure Key Vault secret names containing only letters, digits and hyphens."
  }
  validation {
    condition = alltrue([
      for name in ["CLAUDE_CODE_OAUTH_TOKEN", "EMPLOYEE_CV_SSH_KEY", "JOBS_TRACKER_CLIENT_ID", "JOBS_TRACKER_CLIENT_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] : contains(keys(var.secret_names), name)
    ])
    error_message = "Subscription OAuth, the employee-cv deploy key, tracker and Telegram secret references are required."
  }
  validation {
    condition     = length(setintersection(toset(keys(var.secret_names)), toset(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_IDENTITY_TOKEN"]))) == 0
    error_message = "Claude API fallback uses workload identity federation; never map static API credentials or identity assertions."
  }

}

variable "app_env" {
  description = "Reviewed nonsecret application configuration. Keep credentials/cookies and signed URLs in secret_names."
  type        = map(string)
  default = {
    ANTHROPIC_MODEL               = "claude-opus-5-5"
    JOBS_REFRESH_MERGE_EFFORT     = "xhigh"
    JOBS_REFRESH_LINKEDIN_ENABLED = "true"
    JOBS_REFRESH_NOTIFY_ENABLED   = "false"
  }
  validation {
    condition = alltrue([
      for name in keys(var.app_env) :
      !can(regex("(TOKEN|SECRET|PASSWORD|COOKIE|SESSION|API_KEY|INGEST_KEY|API_HASH|PROXY_KEY)", name)) &&
      !startswith(name, "JOBS_CLOUD_") && !contains(["JOBS_REFRESH_CLOUD", "GIT_SSH_COMMAND", "HOME", "PATH", "NODE_OPTIONS"], name)
    ])
    error_message = "Do not put credentials or cloud-managed paths in app_env; use secret_names for credentials."
  }
  validation {
    condition = contains([0, 5], length([
      for name in ["ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_SERVICE_ACCOUNT_ID", "ANTHROPIC_FEDERATION_AUDIENCE", "ANTHROPIC_FEDERATION_TENANT_ID"] : name
      if lookup(var.app_env, name, "") != ""
    ])) && (lookup(var.app_env, "ANTHROPIC_WORKSPACE_ID", "") == "" || lookup(var.app_env, "ANTHROPIC_FEDERATION_RULE_ID", "") != "")
    error_message = "Set all five Claude federation identifiers or none; workspace selection also requires federation."
  }
}

variable "alert_email" {
  type        = string
  description = "Owner email for Azure failures, missed schedules and budget notifications."
  validation {
    condition     = can(regex("^[^@ ]+@[^@ ]+\\.[^@ ]+$", var.alert_email))
    error_message = "Supply an alert recipient email."
  }
}

variable "monthly_budget" {
  description = "Budget in the Azure subscription billing currency, not necessarily USD. Alerts do not cap spending."
  type        = number
  default     = 5
  validation {
    condition     = var.monthly_budget >= 1
    error_message = "A monthly budget must be at least 1 billing-currency unit."
  }
}

variable "budget_start_date" {
  description = "First day of the deployment month, e.g. 2026-10-01T00:00:00Z."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-01T00:00:00Z$", var.budget_start_date))
    error_message = "Use the first day of the deployment month at UTC midnight."
  }
}

variable "subscription_id" {
  type        = string
  description = "Select the existing Azure subscription explicitly."
  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.subscription_id))
    error_message = "An explicit subscription UUID is required."
  }
}
variable "backend_resource_group_name" {
  type    = string
  default = "jobs-dashboard-terraform-westeurope"
}
