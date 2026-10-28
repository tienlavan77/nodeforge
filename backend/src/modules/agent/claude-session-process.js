// Confirms local Claude subprocess termination before a timed-out ticket releases its launch.
// Agent markers isolate concurrent profiles; unmarked legacy runners remain conservatively owned.
import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { ForgeError } from "../../shared/errors.js";

// Checks the OS as well as the gateway's active invocation, including after an API restart.
export function assertClaudeSessionStopped(agentId, active, procRoot = "/proc", sessionId, endedAt) {
  if (active || process.platform !== "linux") throw new ForgeError("Claude invocation has not been confirmed stopped.", { code: "EXECUTION_SESSION_BUSY" });
  for (const pid of readdirSync(procRoot)) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const args = readFileSync(join(procRoot, pid, "cmdline"), "utf8").split("\0");
      if (basename(args[0] || "") !== "claude" && !args.some((arg) => /claude-agent-sdk\/cli\.js$/.test(arg))) continue;
      const env = readFileSync(join(procRoot, pid, "environ"), "utf8").split("\0");
      const marker = env.find((entry) => entry.startsWith("FORGE_CLAUDE_AGENT_ID="));
      const resume = args.find((arg) => arg.startsWith("--resume="))?.slice(9) ?? args[args.indexOf("--resume") + 1];
      if (!marker && sessionId && args.some((arg) => arg === "--resume" || arg.startsWith("--resume=")) && resume !== sessionId) continue;
      if (!marker && resume !== sessionId && Number.isFinite(Date.parse(endedAt)) && processStartedAfter(procRoot, pid, endedAt)) continue;
      if (!marker || marker === `FORGE_CLAUDE_AGENT_ID=${agentId}`) throw new ForgeError("Claude subprocess still owns this or an unmarked legacy invocation.", { code: "EXECUTION_SESSION_BUSY" });
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
    }
  }
}

// Excludes legacy runners launched after the recorded terminal event without trusting process names alone.
function processStartedAfter(procRoot, pid, endedAt) {
  const ticks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));
  const boot = Number(readFileSync(join(procRoot, "stat"), "utf8").match(/^btime (\d+)$/m)?.[1]);
  const stat = readFileSync(join(procRoot, pid, "stat"), "utf8");
  const started = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
  if (!(ticks > 0 && boot > 0 && started > 0)) throw new ForgeError("Cannot establish Claude subprocess start time.", { code: "EXECUTION_SESSION_UNAVAILABLE" });
  return (boot + started / ticks) * 1000 > Date.parse(endedAt) + 1000;
}
