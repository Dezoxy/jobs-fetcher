terraform {
  required_version = "~> 1.17.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.15.0"
    }
  }
  # Bootstrap this separate backend before init. Operator Entra or GitHub OIDC credentials access state
  # without account keys; the jobs-dashboard runner cannot access this container.
  # Supply only nonsecret location fields through -backend-config=backend.hcl.
  backend "azurerm" {
    use_azuread_auth = true
  }
}

provider "azurerm" {
  features {}
  subscription_id                 = var.subscription_id
  storage_use_azuread             = true
  resource_provider_registrations = "none"
}
