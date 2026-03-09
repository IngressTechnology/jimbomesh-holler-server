#!/bin/bash
#
# Automated release pipeline for JimboMesh Holler.
#
# Usage:
#   ./scripts/release.sh 0.3.2
#

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

VERSION="${1:-}"
VERSION_FILES_CHANGED=0
COMMIT_CREATED=0

usage() {
    echo "Usage: $0 <version>"
    echo ""
    echo "Example:"
    echo "  $0 0.3.2"
}

fail() {
    local message="$1"
    echo "ERROR: ${message}" >&2
    if [ "${VERSION_FILES_CHANGED}" -eq 1 ] && [ "${COMMIT_CREATED}" -eq 0 ]; then
        echo "Version files were updated but the release did not complete." >&2
        echo "Run 'git checkout .' to reset." >&2
    fi
    exit 1
}

run_step() {
    local description="$1"
    shift
    echo "==> ${description}"
    "$@" || fail "${description} failed."
}

working_tree_clean() {
    git diff --quiet &&
        git diff --cached --quiet &&
        [ -z "$(git ls-files --others --exclude-standard)" ]
}

ensure_clean_worktree() {
    while ! working_tree_clean; do
        echo "Working tree has uncommitted changes."
        echo "Commit or stash them, then press Enter to re-check."
        read -r -p "Type 'q' to exit, or press Enter to continue: " response
        case "${response}" in
            q|Q)
                fail "Release aborted because the working tree is not clean."
                ;;
        esac
    done
}

update_json_version() {
    local file_path="$1"
    local version="$2"

    node - "${file_path}" "${version}" <<'NODE'
const fs = require('fs');

const [filePath, version] = process.argv.slice(2);
const raw = fs.readFileSync(filePath, 'utf8');
const data = JSON.parse(raw);

data.version = version;

fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
NODE
}

update_cargo_version() {
    local file_path="$1"
    local version="$2"

    node - "${file_path}" "${version}" <<'NODE'
const fs = require('fs');

const [filePath, version] = process.argv.slice(2);
const raw = fs.readFileSync(filePath, 'utf8');
const updated = raw.replace(
  /^version\s*=\s*"[^"]+"$/m,
  `version = "${version}"`
);

if (updated === raw) {
  console.error(`Could not find a version field in ${filePath}`);
  process.exit(1);
}

fs.writeFileSync(filePath, updated);
NODE
}

if [ -z "${VERSION}" ]; then
    usage
    exit 1
fi

cd "${REPO_ROOT}" || fail "Could not change to repository root."

ensure_clean_worktree

run_step "Running lint" npm run lint
run_step "Running unit tests" npm test
run_step "Updating package.json version" npm version "${VERSION}" --no-git-tag-version
VERSION_FILES_CHANGED=1
run_step "Updating desktop Tauri version" update_json_version "desktop/src-tauri/tauri.conf.json" "${VERSION}"
run_step "Updating Cargo version" update_cargo_version "desktop/src-tauri/Cargo.toml" "${VERSION}"
run_step "Staging release files" git add -A
run_step "Creating release commit" git commit -m "release: v${VERSION}"
COMMIT_CREATED=1
run_step "Tagging release" git tag "v${VERSION}"
run_step "Pushing main and tags" git push origin main --tags

echo "🔥 v${VERSION} tagged and pushed! Watch the build: https://github.com/IngressTechnology/jimbomesh-holler-server/actions"
