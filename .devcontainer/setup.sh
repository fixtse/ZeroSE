#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
npm install --global pnpm@11.28.6
pnpm install --frozen-lockfile

# Keep the test runtime outside the source checkout and production environments.
ha_test_venv="${TMPDIR:-/tmp}/assistant-ha-venv"
python3.14 -m venv "$ha_test_venv"
"$ha_test_venv/bin/python" -m pip install --disable-pip-version-check -r test/ha_runtime/requirements.txt
"$ha_test_venv/bin/python" -c 'from homeassistant.components.ai_task import AITaskEntity, GenDataTaskResult'
