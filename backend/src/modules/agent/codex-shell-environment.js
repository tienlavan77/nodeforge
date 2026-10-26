// Makes the deployed Node toolchain available to Codex shell commands without
// granting access to unrelated host data or depending on user login profiles.
import { resolveRuntimePath } from "../../infrastructure/filesystem/forge-paths.js";
import { existsSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";

// Selects the shared Node 26 installation, retaining portability for deployments
// that instead run the API from a different Node installation.
export function codexNodeRuntime() {
  const bin = existsSync("/opt/node-26/bin/node") ? "/opt/node-26/bin" : dirname(process.execPath);
  return { bin, root: dirname(bin) };
}

// Pins shell PATH after caller overrides and keeps package-manager caches in
// the writable project so sandboxed checks do not depend on the owner's home.
export function codexShellEnvironment(environment, projectRoot) {
  const { bin } = codexNodeRuntime();
  const segments = (environment.PATH ?? "").split(delimiter).filter(Boolean);
  const cache = resolveRuntimePath(projectRoot, ".forge/runtime/nf/sdk-cache");
  return { PATH: [bin, ...segments.filter(segment => segment !== bin)].join(delimiter),
    npm_config_cache: resolve(cache, "npm"), XDG_CACHE_HOME: cache };
}

// Shares runtime read access across native engineering and Forge audit modes.
// Minimal platform paths provide working system-library aliases; blanket /etc
// denial masks TLS configuration, so sensitive subdirectories remain denied.
export function codexFilesystemEntries(projectRoot, access) {
  return [`":root"="deny"`, `":minimal"="read"`, `"/etc/shadow"="deny"`, `"/etc/gshadow"="deny"`,
    `"/etc/ssh"="deny"`, `"/etc/ssl/private"="deny"`, `"/etc/ld.so.cache"="read"`, `"/etc/ssl"="read"`,
    `${JSON.stringify(codexNodeRuntime().root)}="read"`, `${JSON.stringify(projectRoot)}=${JSON.stringify(access)}`];
}
