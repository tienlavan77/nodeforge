export function startControlApi({ api, port, host, indexDb, controlDb, processLock, codeCache, ticketWorkspaceService, projectLifecycle, workers = [], logger = console } = {}) {
  const server = api.createServer().listen(port, host, () => {
    process.stdout.write(`Node Control API listening on http://${host}:${port}\n`);
  });
  let closing;
  const signalHandlers = new Map();
  function shutdown() {
    closing ??= release();
    return closing;
  }
  // Drains the approved in-process foundation and all legacy resources, even after one close fails.
  async function release() {
    const errors = [];
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    for (const cleanup of [
      closeServer,
      () => projectLifecycle?.close(),
      ...workers.map((worker) => () => worker?.stop?.()),
      () => codeCache?.close?.(),
      () => ticketWorkspaceService?.close?.(),
      () => indexDb.close(),
      () => controlDb.close(),
      () => processLock.release()
    ]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Control API shutdown failed.");
  }
  // Bounds long-lived HTTP shutdown and clears its fallback timer after normal completion.
  async function closeServer() {
    let timer;
    server.closeIdleConnections?.();
    try {
      await Promise.race([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => { timer = setTimeout(() => { server.closeAllConnections?.(); resolve(); }, 2000); })
      ]);
    } finally { clearTimeout(timer); }
  }
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => shutdown().then(() => process.exit(0)).catch((error) => {
      logger.error?.("Control API shutdown failed", error);
      process.exit(1);
    });
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  return { server, shutdown };
}
