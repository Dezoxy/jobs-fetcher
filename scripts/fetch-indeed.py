#!/usr/bin/env python3
"""Indeed Hungary collector via JobSpy (python-jobspy, pinned in
runtime/requirements-indeed.txt).

    python3 -I scripts/fetch-indeed.py [-o FILE]
      FILE = .cache/indeed-latest.json

Writes {collectedAt, state: 'ok'|'undetermined', reason?, lookbackHours,
queries, truncatedQueries, rows: [candidate]} (docs/architecture-v2.md,
"Candidate row"). Indeed is degraded collection, never a failed run: any
exception, block or empty result is state 'undetermined' with a short reason,
the rows collected so far are kept, and the exit code is 0. Only a bad command
line (2) or an unwritable output file is fatal.

The mapping (to_candidate) is pure and stdlib-only so tests run without
JobSpy, pandas or the network. JobSpy is imported inside collect().
"""
from __future__ import annotations

import datetime as dt
import json
import math
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

# The LinkedIn role families (scripts/fetch-linkedin.mjs LINKEDIN_QUERIES),
# verbatim, so both sources answer the same question. Keep the two lists equal;
# tests/test_fetch_indeed.py fails when they drift.
QUERIES = [
    "(devops OR platform OR cloud OR infrastructure) engineer",
    "architect",
    "devops",
    "(ai OR genai OR llm) engineer",
    "(azure OR aws OR gcp) (engineer OR architect OR devops)",
    "(site reliability OR sre)",
]

# 72 hours, not LinkedIn's 26. Indeed's keyword index lags its date filter:
# measured 2026-11-24 from hu.indeed.com, `devops` and `architect` returned 0
# rows with hours_old=26, while a broader query returned a "DevOps Engineer" ad
# posted that day and `devops` with no window returned 59 (newest a day old).
# An ad that becomes searchable ~a day after posting would be visible for only
# a couple of hours inside a 26-hour window. The overlap is free: ids are
# de-duplicated within a run and the store upserts across runs.
LOOKBACK_HOURS = 72
LOCATION = "Budapest"
# JobSpy's default radius is 50 miles, which reaches Kecskemét and
# Székesfehérvár. 25 miles (~40 km) covers vetoes.mjs METRO_CITIES; whatever
# provincial ad still arrives is dropped by the location veto downstream.
DISTANCE_MILES = 25
# One GraphQL page is 100 jobs, so 100 costs one request per query. A query
# that returns exactly this many was capped and is reported, as LinkedIn's are.
RESULTS_WANTED = 100
AD_TEXT_BYTES = 12 * 1024

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / ".cache" / "indeed-latest.json"
JOB_KEY = re.compile(r"^[A-Za-z0-9]+$")
# Monthly factors for JobSpy's CompensationInterval values (its own annual
# factors are 2080 h, 260 d, 52 w, 12 m per year).
PER_MONTH = {"monthly": 1.0, "yearly": 1 / 12, "weekly": 52 / 12,
             "daily": 260 / 12, "hourly": 2080 / 12}


def _value(v):
    """None for missing values, including pandas' NaN/NaT."""
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    if type(v).__name__ in ("NaTType", "NAType"):
        return None
    return v


def _text(v):
    v = _value(v)
    return v.strip() if isinstance(v, str) and v.strip() else None


def job_key(rec):
    """Indeed's job key: the jk of job_url, else JobSpy's id ('in-<key>').
    Both come from the same GraphQL `key`; jk is preferred because it is what
    the canonical URL carries."""
    url = _text(rec.get("job_url")) or ""
    key = (parse_qs(urlsplit(url).query).get("jk") or [None])[0]
    if not key:
        rid = _text(rec.get("id")) or ""
        key = rid[3:] if rid.startswith("in-") else None
    return key if key and JOB_KEY.match(key) else None


def salary(rec):
    """{lo, hi, type, visible} in HUF/month, or None. Other currencies are
    omitted rather than converted at a guessed rate."""
    if (_text(rec.get("currency")) or "").upper() != "HUF":
        return None
    factor = PER_MONTH.get(_text(rec.get("interval")) or "")
    lo, hi = _value(rec.get("min_amount")), _value(rec.get("max_amount"))
    if factor is None or (lo is None and hi is None):
        return None
    lo = hi if lo is None else lo
    hi = lo if hi is None else hi
    lo, hi = sorted((round(lo * factor), round(hi * factor)))
    if lo <= 0:
        return None
    kinds = (_text(rec.get("job_type")) or "").lower()
    return {"lo": lo, "hi": hi,
            "type": "b2b" if "contract" in kinds else "permanent",
            # collect() strips Indeed's own estimates, so a figure here is
            # always the employer's.
            "visible": True}


def ad_text(v):
    """Plain description capped at 12 KB of UTF-8, cut on a character boundary."""
    s = _text(v)
    if not s:
        return None
    return s.encode("utf-8")[:AD_TEXT_BYTES].decode("utf-8", "ignore")


def posted_at(v):
    v = _value(v)
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()[:10]
    s = _text(v)
    return s[:10] if s and re.match(r"^\d{4}-\d{2}-\d{2}", s) else None


def to_candidate(rec):
    """One JobSpy record (DataFrame row as a dict) -> candidate row, or None
    when it has no usable job key or title."""
    key, role = job_key(rec), _text(rec.get("title"))
    if not key or not role:
        return None
    row = {
        "id": f"in-{key}",
        "source": "Indeed",
        "role": role,
        "company": _text(rec.get("company")),
        "location": _text(rec.get("location")),
        # Canonical, no tracking parameters: JobSpy's job_url already is this
        # for country_indeed="hungary", but it is rebuilt from the key anyway.
        "url": f"https://hu.indeed.com/viewjob?jk={key}",
    }
    for name, value in (("postedAt", posted_at(rec.get("date_posted"))),
                        ("salary", salary(rec)),
                        ("adText", ad_text(rec.get("description")))):
        if value is not None:
            row[name] = value
    return row


def records(frame):
    """DataFrame -> list of plain dicts (NaN handled by _value)."""
    return frame.to_dict("records")


def _employer_pay_only(indeed_module):
    """JobSpy falls back to Indeed's salary ESTIMATE when the ad states no pay,
    and its output cannot tell the two apart (salary_source is 'direct_data'
    either way). An estimate presented as posted would be shown as HIRDETETT,
    so the estimate is removed before JobSpy reads it. Fails loudly (the run
    goes 'undetermined') if a JobSpy upgrade moves the hook."""
    original = indeed_module.get_compensation
    if getattr(original, "_employer_only", False):
        return

    def employer_only(compensation):
        return original(compensation.model_copy(update={"estimated": None}))

    employer_only._employer_only = True
    indeed_module.get_compensation = employer_only


def collect(scrape=None, queries=QUERIES, now=None):
    """-> document. `scrape(query) -> (records, error|None)` is injectable for
    tests; the default calls JobSpy."""
    now = now or (lambda: dt.datetime.now(dt.timezone.utc))
    failures, per_query, truncated, rows = [], [], [], {}
    if scrape is None:
        try:
            scrape = _jobspy_scraper()
        except Exception as e:  # missing venv, changed JobSpy internals
            failures.append(f"jobspy unavailable: {type(e).__name__}: {e}")
            queries = []
    for q in queries:
        seen = got = fresh = 0
        try:
            recs, error = scrape(q)
            seen = len(recs)
            if error:
                failures.append(f"{q}: {error}")
            for rec in recs:
                cand = to_candidate(rec)
                if cand is None:
                    continue
                got += 1
                if cand["id"] not in rows:
                    rows[cand["id"]] = cand
                    fresh += 1
        except Exception as e:
            failures.append(f"{q}: {type(e).__name__}: {e}")
        capped = seen >= RESULTS_WANTED
        if capped:
            truncated.append(q)
        per_query.append({"q": q, "got": got, "fresh": fresh, "capped": capped})

    doc = {"collectedAt": now().isoformat().replace("+00:00", "Z"), "state": "ok"}
    if failures:
        doc |= {"state": "undetermined", "reason": f"indeed collection degraded: {failures[0]}"[:300]}
    elif not rows:
        doc |= {"state": "undetermined", "reason": "indeed returned zero rows across all queries"}
    doc |= {"lookbackHours": LOOKBACK_HOURS, "queries": per_query,
            "truncatedQueries": truncated, "queryFailures": failures,
            "rows": list(rows.values())}
    return doc


def _jobspy_scraper():
    import jobspy
    import jobspy.indeed

    _employer_pay_only(jobspy.indeed)

    def scrape(query):
        frame = jobspy.scrape_jobs(
            site_name=["indeed"], search_term=query, location=LOCATION,
            distance=DISTANCE_MILES, country_indeed="hungary",
            hours_old=LOOKBACK_HOURS, results_wanted=RESULTS_WANTED,
            description_format="plain", verbose=0)
        # JobSpy does not raise on a block: the scraper records the error and
        # returns what it had. Surface it as a failure, keep the rows.
        error = (frame.attrs.get("errors") or {}).get("indeed")
        return records(frame), error

    return scrape


def main(argv):
    if argv == ["--help"]:
        print("fetch-indeed.py [-o FILE] — Indeed Hungary via JobSpy, "
              f"{LOOKBACK_HOURS}-hour lookback; always exits 0 (degraded = state undetermined)")
        return 0
    if argv and (len(argv) != 2 or argv[0] != "-o" or not argv[1]):
        print("fetch-indeed: expected -o FILE or --help", file=sys.stderr)
        return 2
    out = Path(argv[1]) if argv else DEFAULT_OUT
    doc = collect()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"fetch-indeed: queries={len(QUERIES)} rows={len(doc['rows'])} "
          f"lookback_hours={LOOKBACK_HOURS} state={doc['state']}"
          + (f" truncated={len(doc['truncatedQueries'])}" if doc["truncatedQueries"] else "")
          + (f" failed={len(doc['queryFailures'])}" if doc["queryFailures"] else ""))
    for q in doc["queries"]:
        print(f"  {q['got']:3} seen {q['fresh']:3} new  {q['q']}"
              + ("  <-- CAPPED" if q["capped"] else ""))
    for f in doc["queryFailures"]:
        print(f"  !! {f}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
