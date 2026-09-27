// Hosts the production Forge HTTP router and project cache in an isolated integration-test process.
import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createCodeCacheService } from "../../src/modules/context/code-cache-service.js";
import { createWatcherCacheEvents } from "../../src/modules/context/watcher-cache-events.js";
import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";
import { createHttpApi } from "../../src/transport/http/server.js";

const [root, ready, result] = process.argv.slice(2);
const fileService = createFileService({ projectRoot: root });
const codeCache = createCodeCacheService({ projectId: "P", fileService, codeSearch: { fileMetadata: () => null } });
const onEvent = createWatcherCacheEvents({ projectId: "P", codeCache });

// Returns a scoped read result or its error code for cross-process cache assertions.
async function probe(path) {
  try { return await codeCache.read({ path }); }
  catch (error) { return { error_code: error.code ?? "READ_FAILED" }; }
}

const router = createForgeV1Router({
  projectStream: { ingest: () => ({ accepted: true }) },
  onWatcherEvent: async (event) => {
    const cacheEventStatus = await onEvent(event);
    const current = await probe(event.payload.path);
    const old = event.payload.old_path ? await probe(event.payload.old_path) : null;
    const temporary = `${result}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...current, event_type: event.type, event_sha256: event.payload.sha256 ?? null, cache_event_status: cacheEventStatus, cache_stats: codeCache.stats(), old }));
    await rename(temporary, result);
  }
});
const server = createHttpApi({ forgeV1Router: router }).createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const initial = await codeCache.read({ path: "src/example.js" });
await writeFile(`${ready}.cache-status`, initial.cache.status);
await writeFile(ready, String(server.address().port));
process.once("SIGTERM", () => { codeCache.close(); server.close(() => process.exit(0)); });
