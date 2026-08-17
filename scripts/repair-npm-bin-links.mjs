import { chmod, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binDirectory = join(projectRoot, "node_modules", ".bin");
const nodeModulesRoot = resolve(projectRoot, "node_modules");
let repaired = 0;

for (const entry of await directoryEntries(binDirectory)) {
  const launcherPath = join(binDirectory, entry.name);
  const metadata = await lstat(launcherPath);
  if (!metadata.isFile()) continue;

  const marker = await readFile(launcherPath, "utf8");
  const target = xSymTarget(marker);
  if (!target) continue;

  const targetPath = resolve(binDirectory, target);
  if (targetPath !== nodeModulesRoot && !targetPath.startsWith(`${nodeModulesRoot}${sep}`)) {
    throw new Error(`Refusing to repair ${entry.name}: target escapes node_modules.`);
  }

  const relativeTarget = relative(binDirectory, targetPath).split(sep).join("/");
  const wrapper = `#!/bin/sh\nexec "\$(dirname "\$0")/${relativeTarget}" "\$@"\n`;
  try {
    await writeFile(launcherPath, wrapper, { mode: 0o775 });
    await chmod(launcherPath, 0o775);
  } catch (error) {
    console.warn(`Warning: repaired ${entry.name} content, but could not set executable mode (${error.code}).`);
  }
  repaired += 1;
}

console.log(repaired === 0 ? "npm bin launchers are healthy." : `Repaired ${repaired} npm XSym launcher(s).`);

async function directoryEntries(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function xSymTarget(content) {
  const [signature, mode, hash, target] = content.split("\n", 4);
  if (signature !== "XSym" || !/^\d+$/.test(mode) || !/^[0-9a-f]+$/i.test(hash) || !target) return null;
  return target;
}
