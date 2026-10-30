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

`npm run dev:forge` uses the `node` executable resolved from the current shell
`PATH`; it does not guarantee the required Node version. An SSH session can
still resolve Node 18, which cannot load the built-in `node:sqlite` module and
will crash before the API starts. On the VPS, use the pinned Node 26.3.1
binary explicitly for every restart:

```sh
NODE26=/home/tienlavan/.nvm/versions/node/v26.3.1/bin
"$NODE26/node" scripts/dev-forge.mjs --restart
```

Verify before starting:

```sh
"$NODE26/node" --version   # v26.3.1
```

The supervisor should eventually grow a startup guard that checks
`process.versions.node` and exits with an explicit diagnostic when the major
version is unsupported, rather than allowing a later `node:sqlite` crash. That
guard is a separate runtime ticket; the pinned command above is the current
safe procedure.

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
