"""Release version selection (CalVer vYYYY.M.N)."""

import importlib.util
import io
import unittest
from contextlib import redirect_stdout
from datetime import date
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / ".github/scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


version = load("next_release_version")


class VersionTests(unittest.TestCase):
    NOV = date(2026, 11, 25)

    def test_calver_counter_and_month_floor(self):
        nxt = version.next_release_tag
        # First CalVer release continues past the legacy v1.0.x tags at the month floor.
        self.assertEqual(nxt(["v1.0.9", "v1.0.11"], self.NOV), "v2026.11.0")
        # Numeric, not lexical, order within the month.
        self.assertEqual(nxt(["v1.0.11", "v2026.11.9", "v2026.11.10"], self.NOV), "v2026.11.11")
        # A new month restarts at .0; the month is never zero-padded.
        self.assertEqual(nxt(["v2026.11.4"], date(2026, 12, 1)), "v2026.12.0")
        self.assertEqual(nxt(["v2026.12.3"], date(2027, 1, 2)), "v2027.1.0")
        # A clock behind the latest tag never moves the version backwards.
        self.assertEqual(nxt(["v2026.12.0"], self.NOV), "v2026.12.1")

    def test_invalid_tags_do_not_choose_the_version(self):
        noise = ["v9999.0.0-rc1", "v02.0.0", "v2026.01.0", "v2.0.00", "v3.0", "other", "v4000.0.0\nx"]
        self.assertEqual(version.next_release_tag([*noise, "v2026.11.1"], self.NOV), "v2026.11.2")
        with self.assertRaises(ValueError):
            version.next_release_tag(noise, self.NOV)

    def test_retries_reuse_existing_commit_tag(self):
        self.assertEqual(version.existing_tag(["noise", "v1.0.2"]), "v1.0.2")
        self.assertEqual(version.existing_tag(["v1.0.2", "v1.1.0"]), "v1.1.0")
        self.assertEqual(version.existing_tag(["noise"]), "")

    def test_cli_existing_and_next_version(self):
        for args, expected in ((["--date", "2026-11-25"], "v2026.11.0\n"), (["--existing"], "v1.0.2\n")):
            output = io.StringIO()
            with patch.object(version.sys, "stdin", io.StringIO("v1.0.2\n")), redirect_stdout(output):
                self.assertEqual(version.main(args), 0)
            self.assertEqual(output.getvalue(), expected)


if __name__ == "__main__":
    unittest.main()
