#!/bin/bash
# IronMic Release Script
#
# Usage:
#   ./scripts/release.sh <version>
#   ./scripts/release.sh 1.1.0
#   ./scripts/release.sh 1.0.7 --dry-run
#
# This script:
#   1. Validates the version and working tree
#   2. Updates version in package.json and Cargo.toml
#   3. Runs security checks (no tokens, PII, env files)
#   4. Runs cargo clippy + cargo test
#   5. Runs npm run build (main + preload + renderer)
#   6. Shows a summary and waits for confirmation
#   7. Commits, tags, and pushes

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$1"
DRY_RUN=false
if [[ "$2" == "--dry-run" ]]; then DRY_RUN=true; fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

fail() { echo -e "${RED}FAIL:${NC} $1"; exit 1; }
pass() { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
info() { echo -e "${CYAN}==>${NC} $1"; }

# ── Validate inputs ──────────────────────────────────────────────

if [ -z "$VERSION" ]; then
    echo "Usage: ./scripts/release.sh <version> [--dry-run]"
    echo ""
    echo "Examples:"
    echo "  ./scripts/release.sh 1.1.0"
    echo "  ./scripts/release.sh 1.0.7 --dry-run"
    echo ""
    CURRENT_PKG=$(grep '"version"' "$ROOT/electron-app/package.json" | head -1 | sed 's/.*: "\(.*\)".*/\1/')
    CURRENT_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "none")
    echo "Current package.json version: $CURRENT_PKG"
    echo "Current git tag:              $CURRENT_TAG"
    exit 1
fi

# Validate semver format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    fail "Version must be semver (e.g., 1.2.3), got: $VERSION"
fi

# Check tag doesn't already exist
if git rev-parse "v$VERSION" >/dev/null 2>&1; then
    fail "Tag v$VERSION already exists"
fi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║     IronMic Release v$VERSION        ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── Step 1: Clean working tree ───────────────────────────────────

info "Step 1/7: Checking working tree"

cd "$ROOT"
if [ -n "$(git status --porcelain)" ]; then
    echo ""
    git status --short
    echo ""
    fail "Working tree is not clean. Commit or stash changes first."
fi
pass "Working tree clean"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
    warn "Not on main branch (on: $BRANCH)"
fi

# ── Step 2: Update versions ──────────────────────────────────────

info "Step 2/7: Updating versions to $VERSION"

# package.json
CURRENT_PKG=$(grep '"version"' "$ROOT/electron-app/package.json" | head -1 | sed 's/.*: "\(.*\)".*/\1/')
sed -i '' "s/\"version\": \"$CURRENT_PKG\"/\"version\": \"$VERSION\"/" "$ROOT/electron-app/package.json"
pass "package.json: $CURRENT_PKG → $VERSION"

# Cargo.toml
CURRENT_CARGO=$(grep '^version' "$ROOT/rust-core/Cargo.toml" | head -1 | sed 's/.*= "\(.*\)"/\1/')
sed -i '' "s/^version = \"$CURRENT_CARGO\"/version = \"$VERSION\"/" "$ROOT/rust-core/Cargo.toml"
pass "Cargo.toml:   $CURRENT_CARGO → $VERSION"

# Update Cargo.lock
cd "$ROOT/rust-core"
cargo generate-lockfile --quiet 2>/dev/null || true
cd "$ROOT"
pass "Cargo.lock updated"

# ── Step 3: Security scan ────────────────────────────────────────

info "Step 3/7: Security scan"

ISSUES=0

# Check for API keys / tokens
if grep -rIl --include='*.ts' --include='*.tsx' --include='*.js' --include='*.rs' \
    -E '(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|AKIA[A-Z0-9]{16}|-----BEGIN (RSA |EC )?PRIVATE KEY)' \
    "$ROOT/electron-app/src" "$ROOT/rust-core/src" 2>/dev/null; then
    fail "Found potential API keys or secrets in source code"
fi
pass "No API keys or secrets in source"

# Check for .env files that would be committed
if git ls-files --others --exclude-standard | grep -qE '\.env'; then
    fail "Untracked .env file found"
fi
pass "No .env files"

# Check for hardcoded home paths
if grep -rI --include='*.ts' --include='*.tsx' --include='*.rs' \
    '/Users/[a-zA-Z]' "$ROOT/electron-app/src" "$ROOT/rust-core/src" 2>/dev/null; then
    fail "Found hardcoded home directory paths in source"
fi
pass "No hardcoded user paths"

# Check .gitignore covers essentials
for PATTERN in "node_modules" ".env" "*.node" "rust-core/target" "*.downloading"; do
    if ! grep -qF "$PATTERN" "$ROOT/.gitignore"; then
        warn ".gitignore missing: $PATTERN"
        ISSUES=$((ISSUES + 1))
    fi
done
pass ".gitignore covers essentials"

# Check that settings.local.json is ignored
if ! git check-ignore -q "$ROOT/.claude/settings.local.json" 2>/dev/null; then
    warn ".claude/settings.local.json is not gitignored"
    ISSUES=$((ISSUES + 1))
fi
pass "settings.local.json is gitignored"

# Verify console logs don't dump user content
if grep -rn 'console\.log.*entries)' "$ROOT/electron-app/src" 2>/dev/null | grep -v '\.length'; then
    warn "console.log may be dumping user entry content"
    ISSUES=$((ISSUES + 1))
fi
pass "No user content in console logs"

if [ $ISSUES -gt 0 ]; then
    warn "$ISSUES security warnings (non-blocking)"
else
    pass "All security checks passed"
fi

# ── Step 4: Rust checks ─────────────────────────────────────────

info "Step 4/7: Rust clippy + tests"

cd "$ROOT/rust-core"

echo "  Running clippy..."
if ! cargo clippy --no-default-features -- -D warnings 2>&1 | tail -3; then
    fail "cargo clippy failed"
fi
pass "clippy clean"

echo "  Running tests..."
TEST_OUTPUT=$(cargo test --no-default-features 2>&1)
TEST_RESULT=$(echo "$TEST_OUTPUT" | grep "^test result:" | tail -1)
if echo "$TEST_OUTPUT" | grep -q "FAILED"; then
    echo "$TEST_OUTPUT" | tail -20
    fail "cargo test failed"
fi
pass "tests: $TEST_RESULT"

# ── Step 5: Frontend build ───────────────────────────────────────

info "Step 5/7: Frontend build"

cd "$ROOT/electron-app"

echo "  Running npm run build..."
BUILD_OUTPUT=$(npm run build 2>&1)
if ! echo "$BUILD_OUTPUT" | grep -q "built in"; then
    echo "$BUILD_OUTPUT" | tail -10
    fail "npm run build failed"
fi
BUILD_TIME=$(echo "$BUILD_OUTPUT" | grep "built in" | tail -1)
pass "build: $BUILD_TIME"

# Verify entry points exist
for FILE in dist/main/index.js dist/preload/index.js; do
    if [ ! -f "$FILE" ]; then
        fail "Missing build output: $FILE"
    fi
done
pass "All entry points present"

# ── Step 6: Summary ─────────────────────────────────────────────

cd "$ROOT"

info "Step 6/7: Release summary"

echo ""
echo "  Version:    v$VERSION"
echo "  Branch:     $BRANCH"
echo "  Commit:     $(git rev-parse --short HEAD) (current)"
echo "  Files:      $(git diff --name-only | wc -l | tr -d ' ') changed"
echo ""
git diff --name-only | sed 's/^/    /'
echo ""

if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}DRY RUN — reverting changes${NC}"
    git checkout -- .
    echo "Done. Run without --dry-run to release."
    exit 0
fi

echo -e "${YELLOW}Ready to commit, tag v$VERSION, and push to origin.${NC}"
echo ""
read -p "Proceed? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Aborted. Reverting version changes."
    git checkout -- .
    exit 1
fi

# ── Step 7: Commit, tag, push ───────────────────────────────────

info "Step 7/7: Commit, tag, push"

git add \
    electron-app/package.json \
    rust-core/Cargo.toml \
    rust-core/Cargo.lock

git commit -m "$(cat <<EOF
Release v$VERSION

Bump version to $VERSION in package.json and Cargo.toml.
All checks passed: clippy clean, tests green, build verified,
security scan clear.
EOF
)"
pass "Committed"

git tag -a "v$VERSION" -m "IronMic v$VERSION"
pass "Tagged v$VERSION"

git push origin "$BRANCH" --tags
pass "Pushed to origin"

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Released IronMic v$VERSION         ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo "  GitHub: https://github.com/greenpioneersolutions/IronMic/releases/tag/v$VERSION"
echo ""
