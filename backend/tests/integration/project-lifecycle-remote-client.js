// Runs the shipped CLI inside a separate mount namespace and rejects project filesystem access.
// The namespace hides the server's entire project parent. A pre-import probe proves separation;
// guards then fail any attempted CLI stat, mkdir, identity, database or indexing access to that tree.
import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const [serverRoot, ...args] = process.argv.slice(2);
assert.throws(() => fs.statSync(serverRoot), { code: "ENOENT" });
for (const target of [fs, promises]) {
  for (const name of ["stat", "statSync", "lstat", "lstatSync", "realpath", "realpathSync", "mkdir", "mkdirSync", "open", "openSync", "readFile", "readFileSync", "writeFile", "writeFileSync", "readdir", "readdirSync"]) {
    if (typeof target[name] !== "function") continue;
    const original = target[name];
    // Blocks lifecycle access after the namespace probe while allowing Node to load shipped modules.
    target[name] = function guarded(path, ...rest) {
      if (String(path).startsWith(serverRoot)) throw new Error("CLI attempted server project filesystem access: " + name);
      return original.call(this, path, ...rest);
    };
  }
}
syncBuiltinESMExports();
const executable = new URL("../../src/transport/cli/index.js", import.meta.url);
process.argv = [process.execPath, fileURLToPath(executable), ...args];
await import(executable.href);
