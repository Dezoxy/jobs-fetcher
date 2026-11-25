#!/usr/bin/env python3
"""Write the reviewed, nonsecret Terraform config supplied by GitHub variables."""

import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UUID_RE = r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"
FIELDS = {
    "resource_group_name", "location",
    "backup_resource_group_name", "backup_storage_account_name", "key_vault_name",
    "backend_resource_group_name", "alert_email", "ghcr_username", "budget_start_date",
    "monthly_budget", "jobs_enabled", "schedules_enabled",
    "secret_names", "app_env", "subscription_id",
}


def validate(env):
    for name in ("ARM_CLIENT_ID", "ARM_TENANT_ID", "ARM_SUBSCRIPTION_ID"):
        if not re.fullmatch(UUID_RE, env.get(name, "")):
            raise ValueError(f"Configure {name} with an Azure UUID.")
    try:
        values = json.loads(env["TFVARS_JSON"])
        backend = json.loads(env["BACKEND_JSON"])
    except (KeyError, ValueError) as exc:
        raise ValueError("Configure valid Terraform and backend JSON variables.") from exc
    if not isinstance(values, dict) or not isinstance(backend, dict):
        raise ValueError("Terraform configuration must contain JSON objects.")
    if "image" in values:
        raise ValueError("Remove image from AZURE_TERRAFORM_VARS_JSON; use the tracked digest.")
    if set(values) - FIELDS:
        raise ValueError("Terraform variables contain unreviewed fields.")
    if values.get("subscription_id") != env["ARM_SUBSCRIPTION_ID"]:
        raise ValueError("Terraform subscription must match the OIDC subscription.")
    patterns = {
        "resource_group_name": r"jobs-dashboard-terraform-westeurope",
        "storage_account_name": r"sttoomjobstfweu",
        "container_name": r"terraform-state",
        "key": r"jobs-dashboard\.tfstate",
    }
    if set(backend) != set(patterns) or not all(
        isinstance(backend[k], str) and re.fullmatch(pattern, backend[k])
        for k, pattern in patterns.items()
    ):
        raise ValueError("Backend must match the separately provisioned dashboard state container.")
    if values.get("resource_group_name", "jobs-dashboard-westeurope") != "jobs-dashboard-westeurope":
        raise ValueError("Runtime resource group must match the scoped deployment identity.")
    if values.get("backup_resource_group_name", "jobs-dashboard-backups-westeurope") != "jobs-dashboard-backups-westeurope":
        raise ValueError("Backup resource group must match the scoped deployment identity.")
    if values.get("backend_resource_group_name") != backend["resource_group_name"]:
        raise ValueError("Budget backend resource group must match the actual backend.")
    return values, backend


def main():
    try:
        values, backend = validate(os.environ)
    except ValueError as exc:
        raise SystemExit(str(exc)) from None
    folder = ROOT / "infra/azure"
    (folder / "backend.hcl").write_text("".join(
        f"{k} = {json.dumps(v)}\n" for k, v in sorted(backend.items())
    ))
    (folder / "production.auto.tfvars.json").write_text(json.dumps(values) + "\n")
    print("Reviewed backend and nonsecret configuration written; image comes from the tracked pin.")


if __name__ == "__main__":
    main()
