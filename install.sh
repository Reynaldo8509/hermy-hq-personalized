#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null || { echo "Install the Node.js version required by package.json first." >&2; exit 2; }
command -v npm >/dev/null || { echo "npm is required." >&2; exit 2; }
if [[ ! -f "$repo_dir/.env" ]]; then echo "Create a private .env from your deployment secret manager before building." >&2; exit 2; fi
( cd "$repo_dir" && npm ci )
echo "Dependencies installed. Apply Prisma migrations and build only after checking database and environment settings."
