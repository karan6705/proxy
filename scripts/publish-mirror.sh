#!/usr/bin/env bash
# Publishes the public judge mirror (karan6705/proxy) from the private team repo (karan6705/tripwire):
#   1. a fresh bare clone of main (and the demo-v1 tag, if it exists) in a temp folder;
#   2. git filter-repo replaces the three phone numbers that are in the history with fictional 555 numbers
#      (the numbers are read from the old commits and never printed);
#   3. the secret scan must come back clean, or nothing is pushed;
#   4. commit dates, authors and messages are checked against the original;
#   5. the public repo is created if missing, and main (plus the tag) is force-pushed to it, the mirror only.
# Usage (from the repo root): scripts/publish-mirror.sh [--dry-run]   (--dry-run stops before step 5)
set -euo pipefail
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

SOURCE="https://github.com/karan6705/tripwire.git"
MIRROR_REPO="karan6705/proxy"
MIRROR="https://github.com/${MIRROR_REPO}.git"
TAG="demo-v1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

command -v git-filter-repo >/dev/null || { echo "git filter-repo is missing: pip install git-filter-repo (or brew install git-filter-repo)" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/proxy-mirror.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
umask 077

echo "1/5 cloning main from the team repo"
git clone --quiet --bare --single-branch --branch main "$SOURCE" "$WORK/mirror.git"
if git ls-remote --exit-code --tags "$SOURCE" "refs/tags/$TAG" >/dev/null 2>&1; then
  git -C "$WORK/mirror.git" fetch --quiet "$SOURCE" "refs/tags/$TAG:refs/tags/$TAG"
fi
ORIGINAL="$(git -C "$WORK/mirror.git" log main --format='%ad %cd %an %s' --date=iso-strict)"

echo "2/5 redacting phone numbers (values never printed)"
# The three numbers the secret scan found, read from the commits that added them.
extract() { git -C "$WORK/mirror.git" show "$1:$2" 2>/dev/null | grep -oE "$3" | head -1 || true; }
OLD_557="$(extract 47ad329 HANDOFF.md '\+1557[0-9]{7}')"
OLD_1428="$(extract 47ad329 HANDOFF.md '\+1[0-9]{6}1428')"
OLD_408="$(extract aa0b4c9 src/web/web.test.ts '\+1408[0-9]{7}')"

REPLACE="$WORK/replace.txt"
: > "$REPLACE"
add_rule() {
  # Every way the number may be written: +1XXXXXXXXXX, 1XXXXXXXXXX, (XXX) XXX-XXXX, XXX-XXX-XXXX, XXX.XXX.XXXX ...
  local number="$1" replacement="$2"
  [ -n "$number" ] || return 0
  local d="${number//[^0-9]/}"; d="${d: -10}"
  printf 'regex:(\\+?1[\\s.-]?)?\\(?%s\\)?[\\s.-]?%s[\\s.-]?%s(?![0-9])==>%s\n' "${d:0:3}" "${d:3:3}" "${d:6:4}" "$replacement" >> "$REPLACE"
}
add_rule "$OLD_557" "+15555550100"
add_rule "$OLD_1428" "+15555550101"
add_rule "$OLD_408" "+15555550102"
echo "   $(wc -l < "$REPLACE" | tr -d ' ') numbers to replace"
REFS=(main)
git -C "$WORK/mirror.git" rev-parse -q --verify "refs/tags/$TAG" >/dev/null && REFS+=("refs/tags/$TAG")
git -C "$WORK/mirror.git" filter-repo --quiet --force --replace-text "$REPLACE" --refs "${REFS[@]}"
rm -f "$REPLACE"

echo "3/5 secret scan on the rewritten history"
python3 -I "$ROOT/scripts/secret-scan.py" "$WORK/mirror.git"

echo "4/5 checking commit dates, authors and messages are unchanged"
REWRITTEN="$(git -C "$WORK/mirror.git" log main --format='%ad %cd %an %s' --date=iso-strict)"
if [ "$ORIGINAL" != "$REWRITTEN" ]; then
  echo "The rewrite changed commit dates, authors or messages; not pushing." >&2
  exit 1
fi
echo "   $(printf '%s\n' "$REWRITTEN" | wc -l | tr -d ' ') commits unchanged apart from the redaction"

if [ "$DRY_RUN" = 1 ]; then
  echo "5/5 skipped (--dry-run): nothing pushed"
  exit 0
fi
echo "5/5 pushing to $MIRROR_REPO (the public mirror only)"
if ! gh repo view "$MIRROR_REPO" >/dev/null 2>&1; then
  gh repo create "$MIRROR_REPO" --public --description "Proxy: the undo layer for AI agents" >/dev/null
fi
git -C "$WORK/mirror.git" push --quiet --force "$MIRROR" main
if git -C "$WORK/mirror.git" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  git -C "$WORK/mirror.git" push --quiet --force "$MIRROR" "refs/tags/$TAG"
fi
echo "Published https://github.com/${MIRROR_REPO} (main at $(git -C "$WORK/mirror.git" rev-parse --short main))"
