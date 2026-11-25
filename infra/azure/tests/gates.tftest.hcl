mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = { tenant_id = "22222222-2222-2222-2222-222222222222" }
  }
}

variables {
  subscription_id             = "11111111-1111-1111-1111-111111111111"
  backup_storage_account_name = "jobsbackuptest"
  key_vault_name              = "jobs-vault-test"
  alert_email                 = "test@example.com"
  ghcr_username               = "test"
  budget_start_date           = "2026-10-01T00:00:00Z"
  secret_names = {
    GHCR_PULL_TOKEN            = "registry"
    CLAUDE_CODE_OAUTH_TOKEN    = "oauth"
    EMPLOYEE_CV_SSH_KEY        = "cv-read"
    JOBS_TRACKER_CLIENT_ID     = "tracker-id"
    JOBS_TRACKER_CLIENT_SECRET = "tracker-secret"
    TELEGRAM_BOT_TOKEN         = "telegram-bot"
    TELEGRAM_CHAT_ID           = "telegram-chat"
  }
}

run "foundation_has_no_jobs" {
  command = plan
  assert {
    condition     = length(azurerm_container_app_job.jobs) == 0
    error_message = "Foundation must create no executable jobs."
  }
}

run "manual_jobs_keep_backup_access_separate" {
  command = plan
  variables {
    jobs_enabled = true
    image        = "ghcr.io/dezoxy/jobs-fetcher@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  assert {
    condition     = length(azurerm_container_app_job.jobs) == 2 && alltrue([for job in azurerm_container_app_job.jobs : length(job.manual_trigger_config) == 1 && length(job.schedule_trigger_config) == 0])
    error_message = "Jobs must remain Manual until schedules are explicitly enabled."
  }
  assert {
    condition     = alltrue([for job in azurerm_container_app_job.jobs : length(setintersection(toset([for e in job.template[0].container[0].env : e.name]), toset(["JOBS_CLOUD_ACCOUNT_URL", "JOBS_CLOUD_CONTAINER", "JOBS_CLOUD_NAMESPACE"]))) == 0])
    error_message = "The retired v1 Blob state configuration must not reach either job."
  }
}

run "backup_gets_cloudflare_token_only_when_mapped" {
  command = plan
  variables {
    jobs_enabled = true
    image        = "ghcr.io/dezoxy/jobs-fetcher@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    secret_names = {
      GHCR_PULL_TOKEN            = "registry"
      CLAUDE_CODE_OAUTH_TOKEN    = "oauth"
      EMPLOYEE_CV_SSH_KEY        = "cv-read"
      JOBS_TRACKER_CLIENT_ID     = "tracker-id"
      JOBS_TRACKER_CLIENT_SECRET = "tracker-secret"
      TELEGRAM_BOT_TOKEN         = "telegram-bot"
      TELEGRAM_CHAT_ID           = "telegram-chat"
      CLOUDFLARE_API_TOKEN       = "cloudflare"
    }
  }
  assert {
    condition     = toset([for e in azurerm_container_app_job.jobs["backup"].template[0].container[0].env : e.name if e.secret_name != null]) == toset(["JOBS_TRACKER_CLIENT_ID", "JOBS_TRACKER_CLIENT_SECRET", "CLOUDFLARE_API_TOKEN"])
    error_message = "Backup reads only the tracker and Cloudflare secrets; never Claude, Telegram or deploy keys."
  }
  assert {
    condition     = contains([for e in azurerm_container_app_job.jobs["refresh"].template[0].container[0].env : e.name], "CLOUDFLARE_API_TOKEN")
    error_message = "The v2 refresh needs the Cloudflare token."
  }
  assert {
    condition     = toset(keys(azurerm_role_assignment.backup_secrets)) == toset(["GHCR_PULL_TOKEN", "JOBS_TRACKER_CLIENT_ID", "JOBS_TRACKER_CLIENT_SECRET", "CLOUDFLARE_API_TOKEN"])
    error_message = "Backup identity gets per-secret access to exactly its secrets."
  }
}

run "backup_without_cloudflare_mapping_is_unchanged" {
  command = plan
  variables {
    jobs_enabled = true
    image        = "ghcr.io/dezoxy/jobs-fetcher@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  assert {
    condition     = toset(keys(azurerm_role_assignment.backup_secrets)) == toset(["GHCR_PULL_TOKEN", "JOBS_TRACKER_CLIENT_ID", "JOBS_TRACKER_CLIENT_SECRET"])
    error_message = "Without a Cloudflare mapping the backup secrets stay as before."
  }
}

run "schedules_require_enabled_jobs" {
  command = plan
  variables {
    schedules_enabled = true
  }
  expect_failures = [var.schedules_enabled]
}

run "partial_claude_federation_is_rejected" {
  command = plan
  variables {
    app_env = { ANTHROPIC_FEDERATION_RULE_ID = "fdrl_test" }
  }
  expect_failures = [var.app_env]
}

run "complete_claude_federation_needs_no_api_secret" {
  command = plan
  variables {
    app_env = {
      ANTHROPIC_FEDERATION_RULE_ID   = "fdrl_test"
      ANTHROPIC_ORGANIZATION_ID      = "11111111-1111-1111-1111-111111111111"
      ANTHROPIC_SERVICE_ACCOUNT_ID   = "svac_test"
      ANTHROPIC_FEDERATION_AUDIENCE  = "api://22222222-2222-2222-2222-222222222222"
      ANTHROPIC_FEDERATION_TENANT_ID = "33333333-3333-3333-3333-333333333333"
    }
  }
}

run "static_claude_fallback_credentials_are_rejected" {
  command = plan
  variables {
    secret_names = {
      GHCR_PULL_TOKEN            = "registry"
      CLAUDE_CODE_OAUTH_TOKEN    = "oauth"
      EMPLOYEE_CV_SSH_KEY        = "cv-read"
      JOBS_TRACKER_CLIENT_ID     = "tracker-id"
      JOBS_TRACKER_CLIENT_SECRET = "tracker-secret"
      TELEGRAM_BOT_TOKEN         = "telegram-bot"
      TELEGRAM_CHAT_ID           = "telegram-chat"
      ANTHROPIC_API_KEY          = "forbidden-api-key"
    }
  }
  expect_failures = [var.secret_names]
}

run "daily_schedules_and_freshness_are_aligned" {
  command = plan
  variables {
    jobs_enabled      = true
    schedules_enabled = true
    image             = "ghcr.io/dezoxy/jobs-fetcher@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  assert {
    condition     = azurerm_container_app_job.jobs["refresh"].schedule_trigger_config[0].cron_expression == "0 13 * * *" && azurerm_container_app_job.jobs["backup"].schedule_trigger_config[0].cron_expression == "15 4 * * *"
    error_message = "Refresh must run once at 13:00 UTC; backup keeps its existing schedule."
  }
  assert {
    condition     = strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.jobs["freshness"].criteria[0].query, "[\"refresh\",26h,\"backup\",26h]")
    error_message = "Daily refresh and backup freshness must allow 26 hours."
  }
  assert {
    condition     = strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.jobs["freshness"].criteria[0].query, "event=v2_refresh_exit job=refresh code=(0|8)") && strcontains(azurerm_monitor_scheduled_query_rules_alert_v2.jobs["failures"].criteria[0].query, "event=v2_refresh_exit job=refresh code=[1-9]")
    error_message = "The v2 refresh exit line must count as fresh (0/8) and alert as a failure (non-zero)."
  }
}
