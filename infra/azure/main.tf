locals {
  tags = { application = "jobs-dashboard", owner = "toom", managed_by = "terraform" }
  jobs = {
    refresh = "0 13 * * *"
    backup  = "15 4 * * *"
  }
  secrets = { for name, secret_name in var.secret_names : name => {
    name = lower(replace(name, "_", "-"))
    url  = "${azurerm_key_vault.jobs.vault_uri}secrets/${secret_name}"
  } }
  cloud_env = {
    JOBS_CLOUD_IDENTITY_CLIENT_ID = azurerm_user_assigned_identity.runner.client_id
  }
  # Secrets the backup job may read. CLOUDFLARE_API_TOKEN (when mapped) lets the
  # backup export both D1 databases.
  backup_secret_names = [for name in ["GHCR_PULL_TOKEN", "JOBS_TRACKER_CLIENT_ID", "JOBS_TRACKER_CLIENT_SECRET", "CLOUDFLARE_API_TOKEN"] : name if contains(keys(var.secret_names), name)]
  backup_env = {
    JOBS_CLOUD_BACKUP_ACCOUNT_URL = azurerm_storage_account.backup.primary_blob_endpoint
    JOBS_CLOUD_BACKUP_CONTAINER   = azurerm_storage_container.backup.name
    JOBS_CLOUD_IDENTITY_CLIENT_ID = azurerm_user_assigned_identity.backup_writer.client_id
  }
}

resource "azurerm_resource_group" "jobs" {
  name     = var.resource_group_name
  location = var.location
  tags     = local.tags
  lifecycle { prevent_destroy = true }
}

resource "azurerm_log_analytics_workspace" "jobs" {
  name                = "jobs-dashboard-logs"
  resource_group_name = azurerm_resource_group.jobs.name
  location            = var.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  daily_quota_gb      = 0.1
  tags                = local.tags
}

resource "azurerm_container_app_environment" "jobs" {
  name                       = "jobs-dashboard"
  resource_group_name        = azurerm_resource_group.jobs.name
  location                   = var.location
  logs_destination           = "log-analytics"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.jobs.id
  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
  tags = local.tags
}

resource "azurerm_user_assigned_identity" "runner" {
  name                = "jobs-dashboard-runner"
  resource_group_name = azurerm_resource_group.jobs.name
  location            = var.location
  tags                = local.tags
}

resource "azurerm_role_assignment" "secrets" {
  scope                = azurerm_key_vault.jobs.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.runner.principal_id
}

resource "azurerm_key_vault" "jobs" {
  name                       = var.key_vault_name
  location                   = var.location
  resource_group_name        = azurerm_resource_group.jobs.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = true
  soft_delete_retention_days = 7
  tags                       = local.tags
  lifecycle { prevent_destroy = true }
}

# Identity metadata only. Secret values are copied by the separate migration
# tool and must never enter Terraform configuration, plans or state.
data "azurerm_client_config" "current" {}

resource "azurerm_container_app_job" "jobs" {
  # Create jobs only after all referenced vault secrets have been copied and
  # verified. Even Manual jobs resolve Key Vault references during creation.
  for_each                     = var.jobs_enabled ? local.jobs : {}
  name                         = "jobs-${each.key}"
  resource_group_name          = azurerm_resource_group.jobs.name
  location                     = var.location
  container_app_environment_id = azurerm_container_app_environment.jobs.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 3000
  replica_retry_limit          = 0
  identity {
    type         = "UserAssigned"
    identity_ids = [each.key == "backup" ? azurerm_user_assigned_identity.backup_writer.id : azurerm_user_assigned_identity.runner.id]
  }
  dynamic "manual_trigger_config" {
    for_each = var.schedules_enabled ? [] : [1]
    content {
      parallelism              = 1
      replica_completion_count = 1
    }
  }
  dynamic "schedule_trigger_config" {
    for_each = var.schedules_enabled ? [1] : []
    content {
      cron_expression          = each.value
      parallelism              = 1
      replica_completion_count = 1
    }
  }
  dynamic "secret" {
    for_each = { for name, ref in local.secrets : name => ref if each.key != "backup" || contains(local.backup_secret_names, name) }
    content {
      name                = secret.value.name
      identity            = each.key == "backup" ? azurerm_user_assigned_identity.backup_writer.id : azurerm_user_assigned_identity.runner.id
      key_vault_secret_id = secret.value.url
    }
  }
  registry {
    server               = "ghcr.io"
    username             = var.ghcr_username
    password_secret_name = local.secrets["GHCR_PULL_TOKEN"].name
  }
  template {
    container {
      name    = "jobs"
      image   = var.image
      cpu     = 0.5
      memory  = "1Gi"
      command = ["node", "/app/scripts/cloud-run.mjs"]
      args    = [each.key]
      dynamic "env" {
        for_each = merge(var.app_env, local.cloud_env, each.key == "backup" ? local.backup_env : {})
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = { for name, secret in local.secrets : name => secret if name != "GHCR_PULL_TOKEN" && (each.key != "backup" || contains(local.backup_secret_names, name)) }
        content {
          name        = env.key
          secret_name = env.value.name
        }
      }
    }
  }
  lifecycle {
    precondition {
      condition     = length(setintersection(toset(keys(var.app_env)), toset(keys(var.secret_names)))) == 0
      error_message = "An environment variable must have exactly one nonsecret value or secret reference."
    }
  }
  tags       = local.tags
  depends_on = [azurerm_role_assignment.secrets, azurerm_role_assignment.backup_writer, azurerm_role_assignment.backup_secrets]
}
