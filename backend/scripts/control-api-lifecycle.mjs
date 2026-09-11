export function startControlApi({ api, port, host, indexDb, controlDb, processLock, workers = [], logger = console } = {}) {
  const server = api.createServer().listen(port, host, () => {
    process.stdout.write(`Node Control API listening on http://${host}:${port}\n`);
  });
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    for (const worker of workers) worker?.stop?.();
    // Do not let keep-alive or long-lived HTTP connections block Ctrl-C/r restart.
    server.closeIdleConnections?.();
    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => setTimeout(() => { server.closeAllConnections?.(); resolve(); }, 2000))
    ]);
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
