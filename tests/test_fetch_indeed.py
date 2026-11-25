"""Indeed collector mapping and degraded-collection semantics, without network.

JobSpy is not needed: the canned records have the shape of
DataFrame.to_dict("records") from python-jobspy 1.5.0 (NaN for missing). The
two tests that touch JobSpy itself skip when it is not installed.
"""

import datetime as dt
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fetch_indeed", ROOT / "scripts/fetch-indeed.py")
fi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fi)
RECORDS = json.loads((ROOT / "tests/fixtures/indeed-jobspy-records.json").read_text(encoding="utf-8"))
HAS_JOBSPY = importlib.util.find_spec("jobspy") is not None


class MappingTests(unittest.TestCase):
    def test_full_record_maps_to_the_candidate_contract(self):
        self.assertEqual(fi.to_candidate(RECORDS[0]), {
            "id": "in-03dbabc44a4b0866",
            "source": "Indeed",
            "role": "DevOps Engineer",
            "company": "Example Bank Zrt.",
            "location": "Budapest, PE, Hungary",
            "url": "https://hu.indeed.com/viewjob?jk=03dbabc44a4b0866",
            "postedAt": "2026-11-24",
            "salary": {"lo": 1400000, "hi": 1950000, "type": "permanent", "visible": True},
            "adText": "We run Kubernetes on Azure. Hybrid, Budapest office.",
        })

    def test_tracking_parameters_dropped_and_missing_values_omitted(self):
        row = fi.to_candidate(RECORDS[1])
        self.assertEqual(row["id"], "in-f28c99b08a89eb8b")
        self.assertEqual(row["url"], "https://hu.indeed.com/viewjob?jk=f28c99b08a89eb8b")
        self.assertIsNone(row["company"])
        self.assertNotIn("postedAt", row)
        self.assertNotIn("adText", row)
        # yearly HUF -> per month; a one-sided range becomes a point
        self.assertEqual(row["salary"], {"lo": 2500000, "hi": 2500000, "type": "b2b", "visible": True})

    def test_non_huf_salary_is_omitted_not_converted(self):
        row = fi.to_candidate(RECORDS[2])
        self.assertNotIn("salary", row)
        self.assertEqual(row["location"], "Üllő, PE, Hungary")

    def test_rows_without_title_or_valid_key_are_skipped(self):
        self.assertIsNone(fi.to_candidate(RECORDS[3]))
        self.assertIsNone(fi.to_candidate(RECORDS[4]))

    def test_key_falls_back_to_jobspy_id(self):
        rec = dict(RECORDS[0], job_url="https://hu.indeed.com/rc/clk?x=1")
        self.assertEqual(fi.job_key(rec), "03dbabc44a4b0866")

    def test_interval_conversion(self):
        base = {"currency": "HUF", "min_amount": 5000.0, "max_amount": 6000.0}
        self.assertEqual(fi.salary(dict(base, interval="hourly"))["lo"], round(5000 * 2080 / 12))
        self.assertEqual(fi.salary(dict(base, interval="daily"))["hi"], round(6000 * 260 / 12))
        self.assertIsNone(fi.salary(dict(base, interval=None)))
        self.assertIsNone(fi.salary(dict(base, interval="monthly", min_amount=float("nan"),
                                         max_amount=float("nan"))))

    def test_ad_text_capped_at_12_kb_on_a_character_boundary(self):
        text = fi.ad_text("ő" * 10000)  # 2 bytes each
        self.assertLessEqual(len(text.encode("utf-8")), 12 * 1024)
        self.assertEqual(text, "ő" * 6144)


class CollectTests(unittest.TestCase):
    now = staticmethod(lambda: dt.datetime(2026, 11, 25, 13, tzinfo=dt.timezone.utc))

    def test_ok_run_dedupes_across_queries(self):
        doc = fi.collect(scrape=lambda q: (RECORDS, None), queries=["a", "b"], now=self.now)
        self.assertEqual(doc["state"], "ok")
        self.assertNotIn("reason", doc)
        self.assertEqual(doc["collectedAt"], "2026-11-25T13:00:00Z")
        self.assertEqual([r["id"] for r in doc["rows"]],
                         ["in-03dbabc44a4b0866", "in-f28c99b08a89eb8b", "in-1ee9ccde228e00bd"])
        self.assertEqual(doc["queries"][1], {"q": "b", "got": 3, "fresh": 0, "capped": False})

    def test_block_is_undetermined_and_keeps_collected_rows(self):
        answers = {"a": (RECORDS[:1], None), "b": ([], "response status code 403 (blocked: use a proxy)")}
        doc = fi.collect(scrape=lambda q: answers[q], queries=["a", "b"], now=self.now)
        self.assertEqual(doc["state"], "undetermined")
        self.assertIn("403", doc["reason"])
        self.assertEqual(len(doc["rows"]), 1)

    def test_exception_is_undetermined_not_raised(self):
        def boom(q):
            raise ConnectionError("reset")
        doc = fi.collect(scrape=boom, queries=["a"], now=self.now)
        self.assertEqual(doc["state"], "undetermined")
        self.assertEqual(doc["rows"], [])
        self.assertIn("ConnectionError", doc["reason"])

    def test_zero_rows_is_undetermined(self):
        doc = fi.collect(scrape=lambda q: ([], None), queries=["a"], now=self.now)
        self.assertEqual(doc["state"], "undetermined")
        self.assertIn("zero rows", doc["reason"])

    def test_capped_query_is_reported(self):
        many = [dict(RECORDS[0], job_url=f"https://hu.indeed.com/viewjob?jk=k{i}") for i in range(fi.RESULTS_WANTED)]
        doc = fi.collect(scrape=lambda q: (many, None), queries=["a"], now=self.now)
        self.assertEqual(doc["truncatedQueries"], ["a"])

    def test_queries_match_linkedin_role_families(self):
        js = (ROOT / "scripts/fetch-linkedin.mjs").read_text(encoding="utf-8")
        block = re.search(r"LINKEDIN_QUERIES = \[(.*?)\n\];", js, re.S).group(1)
        code = "\n".join(line for line in block.splitlines() if not line.strip().startswith("//"))
        self.assertEqual(re.findall(r'"([^"]+)"', code), fi.QUERIES)


class CommandTests(unittest.TestCase):
    @unittest.skipIf(HAS_JOBSPY, "would reach the network with JobSpy installed")
    def test_missing_jobspy_is_degraded_exit_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp, "indeed.json")
            run = subprocess.run([sys.executable, "-I", str(ROOT / "scripts/fetch-indeed.py"), "-o", str(out)],
                                 capture_output=True, text=True, check=False)
            self.assertEqual(run.returncode, 0, run.stderr)
            doc = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(doc["state"], "undetermined")
            self.assertIn("jobspy unavailable", doc["reason"])
            self.assertEqual(doc["rows"], [])

    def test_bad_arguments_exit_two(self):
        run = subprocess.run([sys.executable, "-I", str(ROOT / "scripts/fetch-indeed.py"), "-x"],
                             capture_output=True, text=True, check=False)
        self.assertEqual(run.returncode, 2)


@unittest.skipUnless(HAS_JOBSPY, "python-jobspy not installed")
class JobSpyTests(unittest.TestCase):
    def test_estimated_salary_is_not_reported_as_posted(self):
        import jobspy.indeed
        from jobspy.indeed.model import IndeedCompensation

        fi._employer_pay_only(jobspy.indeed)
        fi._employer_pay_only(jobspy.indeed)  # idempotent
        pay = {"unitOfWork": "MONTH", "range": {"min": 1000000, "max": 1200000}}
        estimate_only = IndeedCompensation.model_validate(
            {"baseSalary": None, "currencyCode": None,
             "estimated": {"baseSalary": pay, "currencyCode": "HUF"}})
        posted = IndeedCompensation.model_validate(
            {"baseSalary": pay, "currencyCode": "HUF", "estimated": None})
        self.assertIsNone(jobspy.indeed.get_compensation(estimate_only).min_amount)
        self.assertEqual(jobspy.indeed.get_compensation(posted).min_amount, 1000000)

    def test_dataframe_records_map(self):
        import pandas as pd

        frame = pd.DataFrame(RECORDS[:3])
        frame["date_posted"] = [dt.date(2026, 11, 24), None, None]
        rows = [fi.to_candidate(r) for r in fi.records(frame)]
        self.assertEqual(rows[0]["postedAt"], "2026-11-24")
        self.assertNotIn("postedAt", rows[1])
        self.assertIsNone(rows[1]["company"])


if __name__ == "__main__":
    unittest.main()
