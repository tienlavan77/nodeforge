// Launches real filesystem checks in a disposable container without mounting a
// host socket or changing project permissions. The project is read-only and all
// fixture data lives in a bounded tmpfs destroyed when the container exits.
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rmdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { REPOSITORY_ROOT } from "../src/shared/repository-root.js";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const cwd = args[0] === "--cwd" ? resolve(args[1]) : resolve(REPOSITORY_ROOT);
const argv = separator >= 0 ? args.slice(separator + 1) : [process.execPath, "--test", "backend/tests/integration/project-filesystem-environment.test.js"];
const local = relative(REPOSITORY_ROOT, cwd);
if (local === ".." || local.startsWith(`..${sep}`) || local.startsWith(sep) || !argv.length || !/^(?:.*\/)?node(?:\.exe)?$/.test(argv[0])) {
  throw new Error("VERIFICATION_BLOCKED: runner requires a Node command inside this project");
}
const engine = process.env.NODEFORGE_FILESYSTEM_CONTAINER_ENGINE ?? "docker";
if (!["docker", "podman"].includes(engine)) throw new Error("VERIFICATION_BLOCKED: select docker or podman");
const image = process.env.NODEFORGE_FILESYSTEM_CONTAINER_IMAGE ?? "nodeforge-filesystem-fixtures:node26";
const available = spawnSync(engine, ["image", "inspect", image], { encoding: "utf8", timeout: 15000 });
if (available.error || available.status !== 0) {
  console.error(`VERIFICATION_BLOCKED: ${engine} runner/image unavailable (${available.error?.code ?? available.stderr?.trim()}). Build backend/test-environments/filesystem first.`);
  process.exitCode = 1;
} else {
  const imageId = JSON.parse(available.stdout)[0]?.Id;
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId ?? "")) throw new Error("VERIFICATION_BLOCKED: engine returned an invalid image identity");
  const scratch = join(REPOSITORY_ROOT, ".forge/scratch");
  await mkdir(scratch, { recursive: true });
  const fixtures = await mkdtemp(join(scratch, "filesystem-fixtures-"));
  const name = `nodeforge-filesystem-${randomUUID()}`;
  const launch = ["run", "--rm", "--init", "--name", name, "--network=none", "--read-only", "--memory=512m", "--memory-swap=512m", "--pids-limit=128",
    "--user=0", "-e", `NODEFORGE_FILESYSTEM_TEST_UID=${process.geteuid?.() || 1000}`,
    "-e", `NODEFORGE_FILESYSTEM_TEST_GID=${process.getegid?.() || 1000}`,
    "--cap-drop=ALL", ...["SYS_ADMIN", "SETUID", "SETGID", "SETPCAP", "CHOWN", "FOWNER"].map(cap => `--cap-add=${cap}`),
    "--security-opt=no-new-privileges", "--security-opt=apparmor=unconfined",
    "--mount", `type=bind,src=${resolve(REPOSITORY_ROOT)},dst=${resolve(REPOSITORY_ROOT)},readonly`,
    "--tmpfs", `${fixtures}:rw,size=32m,nosuid,nodev,mode=0755`];
  // A verification archive is disposable and already guarded by source hashes;
  // its tests may create local scratch without gaining writes to the live tree.
  if (/^\.forge\/runtime\/(?:tickets\/)?ticket-verification\/archives\/nodeforge-ticket-archive-[^/]+$/.test(local)) {
    launch.push("--mount", `type=bind,src=${cwd},dst=${cwd}`);
  }
  launch.push(imageId, fixtures, cwd, ...argv);
  let child;
  // Forwards cancellation to the engine so its init process can stop descendants.
  const stop = signal => child?.kill(signal);
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    console.log(JSON.stringify({ event: "filesystem-runner", engine, image, imageId, cwd, argv }));
    process.exitCode = await new Promise((resolveStatus, reject) => {
      child = spawn(engine, launch, { stdio: "inherit" });
      child.once("error", reject);
      child.once("close", code => resolveStatus(code ?? 1));
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    const cleanup = spawnSync(engine, ["rm", "--force", name], { encoding: "utf8", timeout: 15000 });
    if (cleanup.error || (cleanup.status !== 0 && !/no such container/i.test(cleanup.stderr ?? ""))) console.error(`Container cleanup: ${cleanup.error?.message ?? cleanup.stderr}`);
    await rmdir(fixtures);
  }
}
