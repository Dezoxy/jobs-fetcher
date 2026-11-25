"""Image deployment must refuse broader changes and fail closed on busy jobs."""

import copy
import importlib.util
import json
import re
import subprocess
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / ".github/scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


guard = load("azure_release_guard")
config = load("azure_deploy_config")
OLD = "ghcr.io/dezoxy/jobs-fetcher@sha256:" + "1" * 64
NEW = "ghcr.io/dezoxy/jobs-fetcher@sha256:" + "2" * 64
SUB = "00000000-0000-0000-0000-000000000000"


def plan(image=NEW):
    changes = []
    for address in ('azurerm_container_app_job.jobs["backup"]', 'azurerm_container_app_job.jobs["refresh"]'):
        before = {
            "name": "jobs-" + address.split('"')[1],
            "resource_group_name": "jobs-dashboard-westeurope",
            "schedule_trigger_config": [],
            "template": [{"container": [{"name": "jobs", "image": OLD, "env": [{"name": "MODEL", "value": "private"}]}]}],
        }
        after = copy.deepcopy(before)
        after["template"][0]["container"][0]["image"] = image
        changes.append({"address": address, "type": guard.JOB_TYPE, "name": "jobs", "change": {
            "actions": ["no-op"] if image == OLD else ["update"], "before": before, "after": after, "after_unknown": {},
        }})
    return {"resource_changes": changes}


class ImageGuardTests(unittest.TestCase):
    def test_all_jobs_image_bump_and_pinned_noop(self):
        self.assertEqual(guard.check_plan(plan(), NEW)[0], "apply")
        self.assertEqual(guard.check_plan(plan(OLD), OLD)[0], "noop")
        with self.assertRaises(guard.GuardError):
            guard.check_plan(plan(OLD), NEW)

    def test_broader_changes_are_refused(self):
        for alteration in ("schedule", "secret", "replacement", "unknown", "other_resource", "partial", "missing", "retired_pilot"):
            with self.subTest(alteration=alteration):
                value = plan()
                change = value["resource_changes"][0]["change"]
                if alteration == "schedule":
                    change["after"]["schedule_trigger_config"] = [{"cron_expression": "* * * * *"}]
                elif alteration == "secret":
                    change["after"]["template"][0]["container"][0]["env"][0]["value"] = "changed"
                elif alteration == "replacement":
                    change["actions"] = ["delete", "create"]
                elif alteration == "unknown":
                    change["after_unknown"] = {"identity": True}
                elif alteration == "other_resource":
                    value["resource_changes"].append({"type": "azurerm_storage_account", "change": {"actions": ["update"]}})
                elif alteration == "partial":
                    change["actions"] = ["no-op"]
                    change["after"] = change["before"]
                elif alteration == "missing":
                    value["resource_changes"].pop()
                elif alteration == "retired_pilot":
                    pilot = copy.deepcopy(value["resource_changes"][0])
                    pilot["address"] = 'azurerm_container_app_job.pilot[0]'
                    value["resource_changes"].append(pilot)
                with self.assertRaises(guard.GuardError):
                    guard.check_plan(value, NEW)

    def test_wrong_registry_tag_or_pin_refused(self):
        for image in ("ghcr.io/dezoxy/jobs-dashboard:1.0.1", "ghcr.io/dezoxy/other@sha256:" + "2" * 64,
                      "ghcr.io/dezoxy/jobs-dashboard@sha256:" + "2" * 64, OLD):  # archived package (ADR 9)
            with self.subTest(image=image), self.assertRaises(guard.GuardError):
                guard.check_plan(plan(), image)

    def test_pin_file_needs_digest_and_release_version(self):
        with tempfile.TemporaryDirectory() as folder:
            pin = Path(folder) / "image.auto.tfvars.json"
            pin.write_text(json.dumps({"image_version": "2026.11.0", "image": NEW}))
            self.assertEqual(guard.load_pin(pin), NEW)
            # The committed pin in this repository must load too.
            self.assertRegex(guard.load_pin(ROOT / "infra/azure/image.auto.tfvars.json"), guard.IMAGE_RE)
            for bad in (
                {"image": NEW},                                              # no version
                {"image_version": "2026.11.0", "image": NEW, "x": "y"},      # extra key
                {"image_version": "v2026.11.0", "image": NEW},               # tag keeps no v
                {"image_version": "2026.01.0", "image": NEW},                # zero padded
                {"image_version": "2026.11.0", "image": "ghcr.io/dezoxy/jobs-dashboard:2026.11.0"},  # tag, not digest
                ["image", NEW],
            ):
                with self.subTest(bad=bad), self.assertRaises(guard.GuardError):
                    pin.write_text(json.dumps(bad))
                    guard.load_pin(pin)

    def test_renovate_pin_manager_matches_the_committed_pin(self):
        # load_pin accepts any key order; Renovate's regex does not. Reformatting
        # the pin file must fail here, not silently stop Renovate.
        config = json.loads((ROOT / "renovate.json").read_text())
        managers = [m for m in config["customManagers"] if "image" in m["managerFilePatterns"][0]]
        self.assertEqual(len(managers), 1)
        pattern = re.sub(r"\(\?<(\w+)>", r"(?P<\1>", managers[0]["matchStrings"][0])
        text = (ROOT / "infra/azure/image.auto.tfvars.json").read_text()
        match = re.search(pattern, text)
        self.assertIsNotNone(match)
        pin = json.loads(text)
        self.assertEqual(match["currentValue"], pin["image_version"])
        self.assertEqual(f'{match["depName"]}@{match["currentDigest"]}', pin["image"])

    def test_computed_outputs_are_allowed(self):
        value = plan()
        value["resource_changes"][0]["change"]["after_unknown"] = {"event_stream_endpoint": True}
        self.assertEqual(guard.check_plan(value, NEW)[0], "apply")

    def test_busy_unknown_failed_request_and_imminent_schedule_block(self):
        jobs = [guard.Job("jobs-refresh", "jobs-dashboard-westeurope", "0 13 * * *")]
        now = datetime(2026, 10, 9, 12, 55, tzinfo=UTC)
        self.assertTrue(guard.busy_reasons(jobs, now, 10, SUB, lambda *_: ["Succeeded"]))
        later = now + timedelta(hours=1)
        for statuses in (["Running"], ["Processing"], [None], ["unexpected"]):
            self.assertTrue(guard.busy_reasons(jobs, later, 10, SUB, lambda *_: statuses))
        self.assertFalse(guard.busy_reasons(jobs, later, 10, SUB, lambda *_: ["Succeeded", "Failed"]))
        def unavailable(*_):
            raise guard.GuardError("Unavailable")
        self.assertTrue(guard.busy_reasons(jobs, later, 10, SUB, unavailable))

    def test_pagination_reads_every_page_and_refuses_other_host(self):
        pages = [
            subprocess.CompletedProcess([], 0, json.dumps({"value": [{"properties": {"status": "Succeeded"}}], "nextLink": guard.ARM + "/next"})),
            subprocess.CompletedProcess([], 0, json.dumps({"value": [{"properties": {"status": "Running"}}]})),
        ]
        with patch.object(guard.subprocess, "run", side_effect=pages):
            self.assertEqual(guard.fetch_statuses(SUB, "jobs-dashboard-westeurope", "jobs-refresh"), ["Succeeded", "Running"])
        pages[0].stdout = json.dumps({"value": [], "nextLink": "https://example.invalid/next"})
        with patch.object(guard.subprocess, "run", return_value=pages[0]), self.assertRaises(guard.GuardError):
            guard.fetch_statuses(SUB, "jobs-dashboard-westeurope", "jobs-refresh")

    def test_live_readback_checks_digest_and_provisioning(self):
        job = guard.Job("jobs-refresh", "jobs-dashboard-westeurope", None)
        for image, status, success in ((NEW, "Succeeded", True), (OLD, "Succeeded", False), (NEW, "Failed", False)):
            result = subprocess.CompletedProcess([], 0, json.dumps({"properties": {
                "provisioningState": status, "template": {"containers": [{"image": image}]},
            }}))
            with patch.object(guard.subprocess, "run", return_value=result):
                if success:
                    guard.verify_live([job], SUB, NEW)
                else:
                    with self.assertRaises(guard.GuardError):
                        guard.verify_live([job], SUB, NEW)


class ConfigTests(unittest.TestCase):
    def env(self):
        return {
            "ARM_CLIENT_ID": SUB, "ARM_TENANT_ID": SUB, "ARM_SUBSCRIPTION_ID": SUB,
            "TFVARS_JSON": json.dumps({"subscription_id": SUB, "backend_resource_group_name": "jobs-dashboard-terraform-westeurope"}),
            "BACKEND_JSON": json.dumps({"resource_group_name": "jobs-dashboard-terraform-westeurope", "storage_account_name": "sttoomjobstfweu", "container_name": "terraform-state", "key": "jobs-dashboard.tfstate"}),
        }

    def test_valid_configuration(self):
        self.assertEqual(config.validate(self.env())[0]["subscription_id"], SUB)

    def test_image_override_other_backend_identity_or_extra_config_refused(self):
        for alteration in ("image", "backend", "identity", "subscription", "secret", "malformed", "retired_pilot"):
            with self.subTest(alteration=alteration):
                env = self.env()
                values = json.loads(env["TFVARS_JSON"])
                if alteration in ("image", "secret"):
                    values["image" if alteration == "image" else "client_secret"] = "forbidden"
                elif alteration == "backend":
                    backend = json.loads(env["BACKEND_JSON"])
                    backend["key"] = "other.tfstate"
                    env["BACKEND_JSON"] = json.dumps(backend)
                elif alteration == "identity":
                    env["ARM_CLIENT_ID"] = "invalid"
                elif alteration == "subscription":
                    values["subscription_id"] = "11111111-1111-1111-1111-111111111111"
                elif alteration == "retired_pilot":
                    values["pilot_enabled"] = True
                env["TFVARS_JSON"] = "[]" if alteration == "malformed" else json.dumps(values)
                with self.assertRaises(ValueError):
                    config.validate(env)

    def test_retired_v1_state_inputs_are_unreviewed(self):
        # Cutover step 4 removed the v1 Blob state account and its handoff gates.
        for name, value in (("storage_account_name", "sttoomjobsweu"), ("namespace", "production"),
                            ("migration_release_verified", True), ("vm_publisher_paused", True)):
            with self.subTest(name=name):
                env = self.env()
                values = json.loads(env["TFVARS_JSON"])
                values[name] = value
                env["TFVARS_JSON"] = json.dumps(values)
                with self.assertRaisesRegex(ValueError, "unreviewed fields"):
                    config.validate(env)


if __name__ == "__main__":
    unittest.main()
