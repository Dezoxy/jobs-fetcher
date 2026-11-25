"""Offline checks for the copied digest secret-migration safety contract."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "migration", Path(__file__).resolve().parents[1] / "scripts/migrate-azure-secrets.py"
)
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class FakeVault:
    def __init__(self):
        self.writes = []
        self.reads = []
        self.record = {"attributes": {"enabled": True},
                       "tags": {"folder": "jobs-refresh", "envvar": "TEST_TOKEN"}}

    def metadata(self, vault):
        return {"source-token": self.record} if vault == "source-vault" else {}

    def get(self, vault, name):
        self.reads.append((vault, name))
        return {**self.record, "value": "private-test-value"}

    def put(self, vault, name, body):
        self.writes.append((vault, name, body))
        return body


class SecretMigrationTests(unittest.TestCase):
    def test_pagination_accepts_only_same_https_vault_and_default_port(self):
        for url in ["https://source-vault.vault.azure.net/secrets",
                    "https://source-vault.vault.azure.net:443/secrets?$skiptoken=opaque"]:
            self.assertTrue(migration.same_vault_origin(url, "source-vault"))
        for url in ["https://other-vault.vault.azure.net/secrets",
                    "http://source-vault.vault.azure.net/secrets",
                    "https://source-vault.vault.azure.net:444/secrets",
                    "https://user@source-vault.vault.azure.net/secrets",
                    "https://source-vault.vault.azure.net.evil.example/secrets"]:
            self.assertFalse(migration.same_vault_origin(url, "source-vault"))

    def test_preview_reads_metadata_only(self):
        client = FakeVault()
        messages = migration.migrate(client, "source-vault", "target-vault",
                                     [{"source": "source-token", "target": "target-token"}])
        self.assertEqual(client.reads, [])
        self.assertEqual(client.writes, [])
        self.assertNotIn("private-test-value", str(messages))

    def test_copy_preserves_version_tags_without_logging_value(self):
        client = FakeVault()
        messages = migration.migrate(client, "source-vault", "target-vault",
                                     [{"source": "source-token", "target": "target-token"}], "apply")
        self.assertEqual(client.writes[0][2]["tags"], client.record["tags"])
        self.assertNotIn("private-test-value", str(messages))

    def test_same_vault_and_disabled_source_fail_before_writes(self):
        client = FakeVault()
        entries = [{"source": "source-token", "target": "target-token"}]
        with self.assertRaises(migration.MigrationError):
            migration.migrate(client, "source-vault", "source-vault", entries, "apply")
        client.record["attributes"]["enabled"] = False
        with self.assertRaises(migration.MigrationError):
            migration.migrate(client, "source-vault", "target-vault", entries, "apply")
        self.assertEqual(client.writes, [])


if __name__ == "__main__":
    unittest.main()
