#!/usr/bin/env python3
"""Print the next release tag from `git tag --list` lines on stdin.

Used by auto-release.yml on the runner's system Python (stdlib only). Releases use
calendar versioning, `vYYYY.M.N`: UTC year, month WITHOUT zero padding, and a
per-month counter that starts at 0 (v2026.11.0, v2026.11.1, ..., v2026.12.0),
the same scheme as notification-digest and Flodni. The month is not padded
because release.yml's tag check (and SemVer) rejects leading zeros.

The next tag is the highest existing tag with its counter incremented, unless that
would not reach the current month: `vYYYY.M.0` is the floor. So a new month starts
at `.0`, and the legacy `v1.0.x` tags sort below the floor and need no bootstrap
tag. A tag pushed by hand (for example a hotfix `vYYYY.M.N`) is respected and
continued from, and a clock behind the latest tag never moves the version backwards.
Anything that is not `vX.Y.Z` (rc tags, other names) is ignored, and with no valid
tag it fails instead of guessing: an empty list means a broken checkout.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections.abc import Iterable, Sequence
from datetime import UTC, date, datetime

TAG_RE = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")


def _versions(tags: Iterable[str]) -> list[tuple[int, int, int]]:
    return [
        tuple(int(part) for part in match.groups())
        for tag in tags
        if (match := TAG_RE.fullmatch(tag.strip()))
    ]


def next_release_tag(tags: Iterable[str], today: date) -> str:
    """Return the next `vYYYY.M.N` tag for `today` (UTC), continuing from `tags`."""
    versions = _versions(tags)
    if not versions:
        raise ValueError("no existing vX.Y.Z tag to continue from")
    floor = (today.year, today.month, 0)
    highest = max(versions)
    if highest >= floor:
        year, month, counter = highest
        return f"v{year}.{month}.{counter + 1}"
    return f"v{today.year}.{today.month}.0"


def existing_tag(tags: Iterable[str]) -> str:
    """Highest valid release tag already attached to a commit; empty if absent."""
    versions = _versions(tags)
    return "v{}.{}.{}".format(*max(versions)) if versions else ""


def main(argv: Sequence[str] | None = None) -> int:
    """Read tags from stdin and print the next (or `--existing`) one; exit 1 on failure."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--existing", action="store_true", help="Reuse a release tag on this commit")
    parser.add_argument("--date", type=date.fromisoformat,
                        help="override today's date (YYYY-MM-DD, UTC); for tests and ops")
    args = parser.parse_args(argv)
    today = args.date or datetime.now(UTC).date()
    try:
        tags = sys.stdin.read().splitlines()
        print(existing_tag(tags) if args.existing else next_release_tag(tags, today))
    except ValueError as exc:
        print(f"Cannot compute the next release: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
