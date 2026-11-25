output "resource_group_name" { value = azurerm_resource_group.jobs.name }
output "job_names" { value = { for key, job in azurerm_container_app_job.jobs : key => job.name } }
output "backup_resource_group_name" { value = azurerm_resource_group.backup.name }
output "backup_account_url" { value = azurerm_storage_account.backup.primary_blob_endpoint }
output "backup_container" { value = azurerm_storage_container.backup.name }
output "backup_writer_identity_client_id" { value = azurerm_user_assigned_identity.backup_writer.client_id }
output "runner_identity_client_id" { value = azurerm_user_assigned_identity.runner.client_id }
output "log_analytics_workspace_id" { value = azurerm_log_analytics_workspace.jobs.workspace_id }
output "key_vault_name" { value = azurerm_key_vault.jobs.name }
output "key_vault_id" { value = azurerm_key_vault.jobs.id }
output "key_vault_uri" { value = azurerm_key_vault.jobs.vault_uri }
