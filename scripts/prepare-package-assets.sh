#!/usr/bin/env bash
set -euo pipefail

# Materialize generated and copied files declared by publishable package
# manifests. Both formal releases and managed Git installs must run this step
# before direct package assembly, which bypasses npm prepack hooks.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

bash "$REPO_ROOT/scripts/prepare-server-ui-dist.sh"

for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
  rm -rf "$REPO_ROOT/$pkg_dir/skills"
  cp -r "$REPO_ROOT/skills" "$REPO_ROOT/$pkg_dir/skills"
done

echo "  -> Prepared publishable package assets"
