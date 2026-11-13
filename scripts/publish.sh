#!/usr/bin/env bash
# Publishes @spredr/sdk, checking first everything that can make `npm publish` fail halfway or say something misleading
# (npm answers «404 Not Found» to a publish with no npm login: 13 Nov). Each check says what to do; nothing is published
# unless all pass, and what the registry serves is read back after.
#
#   bash scripts/publish.sh            from the sdk folder
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf 'publish: %s\n' "$*"; }
fail() { say "$*" >&2; exit 1; }

name="$(node -p "require('./package.json').name")"
version="$(node -p "require('./package.json').version")"
say "$name $version"

# 1. the tree is a commit, and that commit is on GitHub
[ -z "$(git status --porcelain)" ] || fail "uncommitted changes: commit first (git status)"
git fetch -q origin main || fail "could not reach GitHub (git fetch)"
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "this commit is not origin/main: git push origin main first"

# 2. signed in to npm, as someone who may publish this package
who="$(npm whoami 2>/dev/null)" || fail "not signed in to npm: run «npm login» (it opens the browser), then this again"
say "npm: signed in as $who"
published="$(npm view "$name" version 2>/dev/null || true)"
if [ -n "$published" ]; then
  rights="$(npm access list collaborators "$name" 2>/dev/null || true)"
  if [ -n "$rights" ] && ! grep -Eq "\"?$who\"?: *\"?read-write" <<<"$rights"; then
    fail "$who may not publish $name (npm access list collaborators $name): sign in with the account that owns it (npm logout; npm login)"
  fi
fi

# 3. a version not out yet
if npm view "$name@$version" version >/dev/null 2>&1; then fail "$version is already on npm: raise the version in package.json, commit, push"; fi
say "registry has ${published:-nothing yet}; publishing $version"

# 4. publish (prepublishOnly runs the checks, coverage and the package's own build first)
npm publish

# 5. read back what people now install
for _ in 1 2 3 4 5 6; do
  [ "$(npm view "$name" version 2>/dev/null)" = "$version" ] && { say "✓ npm serves $name $version"; exit 0; }
  sleep 5
done
fail "published, but npm does not serve $version yet: check «npm view $name version» in a minute"
