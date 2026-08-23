# FORGE-OPS-001c - VPS Operations Runbook

The VPS runs two separate processes: Control API supervisor (`scripts/start-dev.mjs`, port `3100`) and filesystem/index watcher (`scripts/start-project-watcher.mjs`). The web client may run on macOS, but macOS PIDs are not evidence about VPS state.

## Check the VPS

SSH first and use the deployed checkout:

```sh
ssh <vps-user>@<vps-host>
cd /home/data/sites/nodeforge
ss -ltnp | grep ':3100'
curl -i http://127.0.0.1:3100/projects/PROJECT-NODEFORGE/dashboard
pgrep -af 'scripts/start-project-watcher.mjs'
tail -n 100 .forge/runtime/nf/logs/node.log
```

Expected Control API output includes `Node Control API listening on http://0.0.0.0:3100`. Any HTTP JSON response from the dashboard proves the server accepted the request (normally HTTP 200). Watcher startup output includes `Project filesystem watcher ready (polling)` and `Project root watched: ...`.

Runtime paths are separate:

- Control API data/events/logs: `.forge/runtime/nf`.
- Watcher/index database: `.forge/runtime/wc/index.db`.

## Restart on the VPS

The repository supervisor restarts Control API only:

```sh
npm run dev:forge -- --restart
```

Restart the separate watcher using the VPS process manager, or manually when appropriate:

```sh
pkill -f 'scripts/start-project-watcher.mjs' || true
npm run dev:watcher
```

Do not start a second watcher while its process lock is held. Use the existing systemd/pm2/SSH supervisor configuration for production persistence.

## Logs and PID boundaries

- Control API log: `.forge/runtime/nf/logs/node.log`.
- Watcher output: stdout/stderr log configured by its process manager.
- `.forge/runtime/nf/dev-forge.pids.json` records the VPS Control API supervisor PID.
- A PID from macOS or a mounted checkout belongs to the local process namespace and cannot prove VPS status.

## Gap found

There is no dedicated `/health` endpoint and no repository-owned systemd/pm2 unit file. The documented checks therefore use the port listener, dashboard HTTP response, process list, and logs. Adding a health endpoint or production process-manager unit is a separate ticket; this documentation change does not modify runtime code.
