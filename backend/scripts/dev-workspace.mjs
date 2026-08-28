import { spawn } from "node:child_process";
import process from "node:process";

const root = new URL("../..", import.meta.url).pathname;
const commands = [
  ["api", process.execPath, ["backend/scripts/start-control-api.mjs"]],
  ["watcher", process.execPath, ["backend/scripts/start-project-watcher.mjs"]],
  ["next", "pnpm", ["--filter", "@nodeforge/ui-nextjs", "dev"]],
];
const children = [];
let stopping = false;
for (const [name, command, args] of commands) {
  const child = spawn(command, args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.on("exit", (code, signal) => {
    if (!stopping && (code ?? 0) !== 0) process.stderr.write(`[${name}] exited (${code ?? signal})\n`);
  });
}
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
await new Promise((resolve) => {
  let remaining = children.length;
  for (const child of children) child.once("exit", () => { remaining -= 1; if (remaining === 0) resolve(); });
});
