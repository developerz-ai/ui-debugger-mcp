#!/usr/bin/env bash
# Shared preflight for bin/dev and bin/check: is this checkout ready to run?
# Source it, then call `preflight`. It changes nothing and downloads nothing;
# a problem is a named `X_PREFLIGHT_*:` line on stderr, a non-zero return, and
# the fix: `bin/setup`.
#
# Checks, cheapest first: bun at the version CI pins (bin/require-bun derives
# it from ci.yml), root deps installed, dummy/web built, Chromium launches.
# On success the verified bun's directory is first on PATH.

preflight() {
  local root bun_env bun_path
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

  if ! bun_env=$("$root/bin/require-bun"); then
    echo "X_PREFLIGHT_BUN: no bun at the version CI pins — run bin/setup" >&2
    return 1
  fi
  bun_path=$(printf '%s\n' "$bun_env" | sed -n 's/^BUN_PATH=//p')
  PATH="$(dirname "$bun_path"):$PATH"
  export PATH

  if [ ! -d "$root/node_modules/playwright-core" ]; then
    echo "X_PREFLIGHT_DEPS: dependencies are not installed — run bin/setup" >&2
    return 1
  fi
  if [ ! -d "$root/dummy/web/dist" ]; then
    echo "X_PREFLIGHT_DUMMY: dummy/web is not built — run bin/setup" >&2
    return 1
  fi
  if ! (cd "$root" && bun -e '(async () => {
    const { chromium } = await import("playwright-core");
    await (await chromium.launch({ headless: true })).close();
  })().catch((err) => { console.error(String(err).split("\n")[0]); process.exit(1); })'); then
    echo "X_PREFLIGHT_CHROMIUM: Chromium does not launch — run bin/setup" >&2
    return 1
  fi
}
