#!/usr/bin/env bash
# Installs a general-purpose Claude Code skill set from ECC and Anthropic's skills repo.
# Only skill folders are copied. No hooks, rules, agents or plugins are installed.
#
# Usage:
#   ./install-skills.sh             installs to ~/.claude/skills (works in all your projects)
#   ./install-skills.sh --project   installs to ./.claude/skills (commit it so teammates get the same set)
set -euo pipefail

DEST="$HOME/.claude/skills"
[ "${1:-}" = "--project" ] && DEST="$(pwd)/.claude/skills"

# Pinned commits, so everyone on the team gets identical files.
ECC_SHA="76aaa77df6adc5b889e689007bf99b9a4f74af34"
ANTH_SHA="dbd4588f9e1033efb41dad4bef2f7947c8993d44"

ECC_SKILLS=(
  # Core, useful on every project
  search-first documentation-lookup coding-standards codebase-onboarding
  verification-loop security-review agent-introspection-debugging
  # Backend and data
  api-design backend-patterns postgres-patterns database-migrations deployment-patterns
  # Frontend
  frontend-patterns
  # AI and agent projects
  eval-harness cost-aware-llm-pipeline
)
ANTH_SKILLS=(frontend-design webapp-testing mcp-builder claude-api)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() { # url sha dir
  git init -q "$3"
  git -C "$3" remote add origin "$1"
  git -C "$3" fetch -q --depth 1 origin "$2"
  git -C "$3" checkout -q FETCH_HEAD
}

echo "Downloading skill sources..."
fetch https://github.com/affaan-m/ECC.git "$ECC_SHA" "$TMP/ecc"
fetch https://github.com/anthropics/skills.git "$ANTH_SHA" "$TMP/anth"

mkdir -p "$DEST"
copy() {
  local name; name="$(basename "$1")"
  if [ -e "$DEST/$name" ]; then echo "skip   $name (already installed)"; return; fi
  cp -R "$1" "$DEST/$name"
  echo "added  $name"
}

for s in "${ECC_SKILLS[@]}"; do copy "$TMP/ecc/skills/$s"; done
for s in "${ANTH_SKILLS[@]}"; do copy "$TMP/anth/skills/$s"; done

echo
echo "Installed to $DEST"
echo "documentation-lookup needs the Context7 MCP server. Add it once with:"
echo "  claude mcp add context7 -- npx -y @upstash/context7-mcp@latest"
