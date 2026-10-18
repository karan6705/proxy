#!/usr/bin/env python3
"""Scans a git repository's whole history (every ref) for added lines that look like secrets or real phone numbers.

Usage: python3 -I scripts/secret-scan.py <repo-dir>
Prints commit, file and the kind of finding only, never a matched value. Exits 1 if anything needs attention.

Real-looking phone: a +1 number whose area code and exchange are not 555 (fictional) and that is not a placeholder
like +10000000000. If HUMAN_PHONE is set in the environment, any occurrence of its digits is a finding too.
Keys: Stripe, Supabase, Inkbox, Anthropic, webhook secrets and JWTs that are long enough to be real. 40-character
hex strings are git commit ids and are not reported.
"""
import os
import re
import subprocess
import sys

repo = sys.argv[1] if len(sys.argv) > 1 else "."

KEYS = [
    ("stripe secret key", re.compile(r"(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{20,}")),
    ("stripe webhook secret", re.compile(r"whsec_[A-Za-z0-9]{20,}")),
    ("supabase secret", re.compile(r"sb_secret_[A-Za-z0-9_\-]{16,}")),
    ("inkbox key", re.compile(r"ApiKey_[A-Za-z0-9_\-]{16,}")),
    ("anthropic key", re.compile(r"sk-ant-[A-Za-z0-9_\-]{30,}")),
    ("jwt", re.compile(r"eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}")),
    ("bearer token", re.compile(r"Bearer\s+[A-Za-z0-9_\-\.]{32,}")),
    ("long hex token", re.compile(r"(?<![A-Fa-f0-9])(?:[A-Fa-f0-9]{32,39}|[A-Fa-f0-9]{41,})(?![A-Fa-f0-9])")),
]
PHONE = re.compile(r"\+1[\s.-]?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b")
human = re.sub(r"\D", "", os.environ.get("HUMAN_PHONE", ""))[-10:]


def looks_real(area: str, exchange: str, line: str) -> bool:
    digits = area + exchange + line
    if area == "555" or exchange == "555":
        return False
    if len(set(digits)) == 1 or area.startswith(("0", "1")):
        return False
    return True


log = subprocess.run(
    ["git", "-C", repo, "log", "--all", "-p", "--no-color", "--format=COMMIT %h"],
    capture_output=True, text=True, errors="replace", check=True,
).stdout

findings = set()
commit = path = None
for raw in log.splitlines():
    if raw.startswith("COMMIT "):
        commit = raw[7:]
        continue
    if raw.startswith("+++ "):
        path = raw[6:] if raw.startswith("+++ b/") else raw[4:]
        continue
    if not raw.startswith("+") or raw.startswith("+++"):
        continue
    text = raw[1:]
    for kind, rx in KEYS:
        if rx.search(text):
            findings.add((commit, path, kind))
    for m in PHONE.finditer(text):
        if looks_real(*m.groups()):
            findings.add((commit, path, "real-looking phone number"))
    if human and len(human) == 10 and human in re.sub(r"\D", "", text):
        findings.add((commit, path, "HUMAN_PHONE"))

commits = len(set(subprocess.run(["git", "-C", repo, "rev-list", "--all"], capture_output=True, text=True).stdout.split()))
if not findings:
    print(f"secret scan: clean ({commits} commits, every ref)")
    sys.exit(0)
print(f"secret scan: {len(findings)} finding(s) in {commits} commits:")
for c, p, k in sorted(findings):
    print(f"  {c}  {p}  {k}")
sys.exit(1)
