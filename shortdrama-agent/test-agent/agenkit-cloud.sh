#!/usr/bin/env bash
set -euo pipefail

echo "Blocked: test-agent must not generate or launch a direct cloud runtime." >&2
echo "Use the authenticated platform backend and controlled Worker path after P0 closure." >&2
exit 1
