locals {
  failure_query   = <<-KQL
    union isfuzzy=true
      (datatable(TimeGenerated:datetime, Log_s:string, ContainerJobName_s:string, ContainerGroupName_s:string, Type_s:string, Reason_s:string) []),
      ContainerAppConsoleLogs_CL, ContainerAppSystemLogs_CL
    | where TimeGenerated > ago(30m)
    | where tostring(column_ifexists("ContainerJobName_s", "")) startswith "jobs-"
        or tostring(column_ifexists("ContainerGroupName_s", "")) startswith "jobs-"
    | where Log_s contains "cloud_job event=failure"
        or Log_s contains "collection_exit=8"
        or Log_s matches regex @"cloud_job event=v2_refresh_exit job=refresh code=[1-9]"
        or tostring(column_ifexists("Type_s", "")) == "Error"
        or tostring(column_ifexists("Reason_s", "")) in ("ContainerCrashing", "ErrImagePull", "ImagePullBackOff", "JobExecutionFailed", "BackoffLimitExceeded")
    | summarize Failures = count()
  KQL
  freshness_query = <<-KQL
    let Expected = datatable(Job:string, MaxAge:timespan) ["refresh",26h,"backup",26h];
    let Success = ContainerAppConsoleLogs_CL
      | where TimeGenerated > ago(2d)
      | where tostring(column_ifexists("ContainerJobName_s", "")) startswith "jobs-"
          or tostring(column_ifexists("ContainerGroupName_s", "")) startswith "jobs-"
      // v2 logs only its exit; 0 and 8 both committed and published.
      | where Log_s contains "cloud_job event=published" or Log_s contains "cloud_job event=success"
          or Log_s matches regex @"cloud_job event=v2_refresh_exit job=refresh code=(0|8)\b"
      | extend Job = extract(@"job=([a-z]+)", 1, Log_s)
      | summarize LastSuccess = max(TimeGenerated) by Job;
    Expected
      | join kind=leftouter Success on Job
      | where isnull(LastSuccess) or now() - LastSuccess > MaxAge
      | summarize StaleJobs = count()
  KQL
}
resource "azurerm_monitor_action_group" "owner" {
  name                = "jobs-dashboard-owner"
  resource_group_name = azurerm_resource_group.jobs.name
  short_name          = "jobs"
  email_receiver {
    name                    = "owner"
    email_address           = var.alert_email
    use_common_alert_schema = true
  }
  tags = local.tags
}
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "jobs" {
  for_each = {
    failures  = { query = local.failure_query, column = "Failures", window = "PT30M" }
    freshness = { query = local.freshness_query, column = "StaleJobs", window = "P2D" }
  }
  name                    = "jobs-dashboard-${each.key}"
  resource_group_name     = azurerm_resource_group.jobs.name
  location                = var.location
  evaluation_frequency    = "PT15M"
  window_duration         = each.value.window
  scopes                  = [azurerm_log_analytics_workspace.jobs.id]
  severity                = 2
  enabled                 = var.schedules_enabled
  auto_mitigation_enabled = true
  skip_query_validation   = true
  criteria {
    query                   = each.value.query
    time_aggregation_method = "Maximum"
    metric_measure_column   = each.value.column
    operator                = "GreaterThan"
    threshold               = 0
    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }
  action { action_groups = [azurerm_monitor_action_group.owner.id] }
  tags = local.tags
}
resource "azurerm_consumption_budget_subscription" "jobs" {
  name            = "jobs-dashboard-monthly"
  subscription_id = "/subscriptions/${var.subscription_id}"
  amount          = var.monthly_budget
  time_grain      = "Monthly"
  time_period { start_date = var.budget_start_date }
  filter {
    dimension {
      name     = "ResourceGroupName"
      operator = "In"
      values   = [azurerm_resource_group.jobs.name, azurerm_resource_group.backup.name, var.backend_resource_group_name]
    }
  }
  dynamic "notification" {
    for_each = toset([80, 100])
    content {
      enabled        = true
      threshold      = notification.value
      threshold_type = "Actual"
      operator       = "GreaterThanOrEqualTo"
      contact_emails = [var.alert_email]
    }
  }
}
