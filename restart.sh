#!/usr/bin/env bash
set -Eeuo pipefail
DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
"${DIR}/stop.sh" >/dev/null 2>&1 || true
sleep 0.3
exec "${DIR}/start.sh"
