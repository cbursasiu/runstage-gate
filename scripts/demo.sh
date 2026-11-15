#!/usr/bin/env bash
# Same as `npm run demo`.
set -euo pipefail
cd "$(dirname "$0")/.."
exec npx tsx scripts/demo.ts
