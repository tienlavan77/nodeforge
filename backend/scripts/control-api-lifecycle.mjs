export function startControlApi({ api, port, host, indexDb, controlDb, processLock, logger = console } = {}) {
  const server = api.createServer().listen(port, host, () => {
    process.stdout.write(`Node Control API listening on http://${host}:${port}\n`);
  });
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    await new Promise((resolve) => server.close(resolve));
    await indexDb.close();
    await controlDb.close();
    processLock.release();
  }
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => shutdown().then(() => process.exit(0)).catch((error) => {
      logger.error?.("Control API shutdown failed", error);
      process.exit(1);
    }));
  }
  return { server, shutdown };
}
