import { spawn } from "node:child_process";
import process from "node:process";

const address = process.argv[2];
if (!address || !/^[a-zA-Z0-9.-]+$/.test(address)) {
  console.error("Usage: npm run dev:web:vps -- <VPS-IP-or-hostname> [port]");
  process.exit(2);
}

const port = process.argv[3] ?? "3100";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error("VPS port must be between 1 and 65535.");
  process.exit(2);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npm, ["run", "dev:web"], {
  stdio: "inherit",
  env: { ...process.env, VITE_NODE_API_URL: `http://${address}:${port}` }
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
