# Hermes Bridge

Two-way sync between **Hermy HQ** (the deployed website) and **Hermes** (your local agent on the Mac mini), using the shared Postgres as a message bus. Nothing is exposed to the internet — the bridge only needs outbound access to Postgres and the local `hermes` CLI.

```
website  ──insert AgentRequest──▶  Postgres  ◀──poll & run──  bridge ──▶ hermes CLI
website  ◀──read HermesTask/────   Postgres  ◀──mirror───────  bridge ◀── hermes CLI
             AgentEvent/DataStore
```

## What it does
- **Pull (Hermes → website):** mirrors the kanban board into `HermesTask`, cron list + health into `DataStore`, and writes activity to `AgentEvent`.
- **Push (website → Hermes):** runs `AgentRequest` rows that are `queued` (safe) or `approved` (you approved a side-effecting one) via the `hermes` CLI, then writes results back. It never runs `awaiting_approval` rows.

## Setup (on the Mac mini)
1. Copy this folder to the mini (or `git pull` the repo there).
2. Install the one dependency:
   ```sh
   cd hermes-bridge && npm install
   ```
3. Make sure `hermes` is on PATH: `which hermes` should resolve (e.g. `~/.local/bin/hermes`).
4. Try it once, pointing at your DB:
   ```sh
   DATABASE_URL='postgres://…' HERMES_BOARD=default node bridge.mjs
   ```
   You should see `hermes-bridge up …`, and a "Bridge connected" event appear in the website's activity feed.
5. Run it forever with launchd:
   ```sh
   # edit the placeholders in ai.hermyhq.bridge.plist first (path, DATABASE_URL, PATH)
   cp ai.hermyhq.bridge.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/ai.hermyhq.bridge.plist
   ```
   Logs: `/tmp/hermes-bridge.out.log`, `/tmp/hermes-bridge.err.log`.

## Config (env)
| var | default | meaning |
|---|---|---|
| `DATABASE_URL` | — (required) | same Postgres the website uses |
| `HERMES_BOARD` | `default` | kanban board slug to mirror |
| `HERMES_BIN` | `hermes` | path to the CLI if not on PATH |
| `BRIDGE_POLL_MS` | `5000` | how often to check for new requests |
| `BRIDGE_MIRROR_MS` | `30000` | how often to mirror kanban/cron/health |
| `BRIDGE_RUN_TIMEOUT_MS` | `240000` | max time for one agent run |

## Notes / assumptions
- CLI arg shapes (`hermes kanban create <title>`, `hermes cron create <schedule> <prompt>`) are best-effort for Hermes v0.17.x — if your build differs, tweak `runRequest()` in `bridge.mjs`.
- The bridge writes to Postgres with plain SQL, so it doesn't need Prisma.
- Safe by design: side-effecting work waits for your approval in the website's Approval Inbox before the bridge will touch it.
