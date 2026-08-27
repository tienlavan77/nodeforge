import process from "node:process";
import { readLogEvents } from "../src/core/project-log-service.js";
const args = parseArgs(process.argv.slice(2));
try {
  const result = await readLogEvents({ logPath: args.log_path, project_id: args.project_id, task_id: args.task_id, ticket_id: args.ticket_id, conversation_id: args.conversation_id, event_name: args.event_name, from: args.from, to: args.to });
  process.stdout.write(`${JSON.stringify(result.events)}\n`);
  if (result.warnings.length) process.stderr.write(`${JSON.stringify({ warnings: result.warnings })}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]; if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replaceAll("-", "_"); const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}.`); result[key] = value; index += 1;
  }
  return result;
}
