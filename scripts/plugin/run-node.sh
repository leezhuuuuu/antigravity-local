#!/bin/sh
set -eu

for candidate in "$(command -v node || true)" '/Applications/ChatGPT.app/Contents/Resources/node'; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1);
  ' >/dev/null 2>&1; then
    exec "$candidate" --disable-warning=ExperimentalWarning "$@"
  fi
done

printf '%s\n' 'Antigravity Local CLI requires Node.js 22.13 or later.' >&2
exit 1
