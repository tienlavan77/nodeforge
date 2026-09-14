import { spawn } from "node:child_process";
import process from "node:process";

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === "--") cliArgs.shift();
const address = cliArgs[0];
if (!address || !/^[a-zA-Z0-9.-]+$/.test(address)) {
  console.error("Usage: pnpm dev:web:vps -- <VPS-IP-or-hostname> [port]");
  process.exit(2);
}

const port = cliArgs[1] ?? "3100";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error("VPS port must be between 1 and 65535.");
  process.exit(2);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(pnpm, ["--dir", "ui/nextjs", "dev"], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_CONTROL_API_URL: `http://${address}:${port}`,
    HOSTNAME: "0.0.0.0",
  }
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
