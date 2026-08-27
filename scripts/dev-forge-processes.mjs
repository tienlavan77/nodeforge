import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

const runtimeDir = process.env.NODE_CONTROL_DATA_DIR ?? join(process.cwd(), ".forge", "runtime", "nf");
const processDir = join(runtimeDir, "processes");
const definitions = {
  api: { args: ["scripts/start-control-api.mjs"], log: "api.log" },
  vite: { args: ["./node_modules/vite/bin/vite.js", "--config", "web/vite.config.js"], log: "vite.log" },
};
const command = process.argv[2];
const [, service, action] = command?.match(/^(api|vite):(start|stop|restart)$/) ?? [];

if (command === "start") { start("api"); start("vite"); }
else if (command === "shutdown" || command === "shutdow") { stop("vite"); stop("api"); }
else if (service && action === "start") start(service);
else if (service && action === "stop") stop(service);
else if (service && action === "restart") { stop(service); start(service); }
else { console.error("Usage: api|vite:(start|stop|restart), start, shutdown"); process.exitCode = 2; }

function pidPath(name) { return join(processDir, `${name}.pid`); }
function readPid(name) { try { const pid = Number(readFileSync(pidPath(name), "utf8")); return Number.isInteger(pid) && pid > 0 ? pid : null; } catch { return null; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function start(name) {
  const oldPid = readPid(name);
  if (oldPid && alive(oldPid)) { console.log(`${name}: already running (pid ${oldPid})`); return; }
  if (oldPid) try { unlinkSync(pidPath(name)); } catch {}
  mkdirSync(processDir, { recursive: true });
  const def = definitions[name];
  const log = openSync(join(processDir, def.log), "a");
  const child = spawn(process.execPath, def.args, { detached: true, stdio: ["ignore", log, log], env: { ...process.env, ...(name === "vite" ? { VITE_WEB_HOST: process.env.VITE_WEB_HOST ?? "0.0.0.0" } : {}) } });
  closeSync(log); child.unref(); writeFileSync(pidPath(name), `${child.pid}\n`);
  console.log(`${name}: started (pid ${child.pid})`);
}
function stop(name) {
  const pid = readPid(name);
  if (!pid) { console.log(`${name}: not running`); return; }
  if (alive(pid)) { try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } console.log(`${name}: stopped (pid ${pid})`); }
  else console.log(`${name}: stale pid removed (pid ${pid})`);
  try { unlinkSync(pidPath(name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
