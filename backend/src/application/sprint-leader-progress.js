// Reports Sprint Leader planning progress without printing owner context or generated plan content.

// Starts a bounded heartbeat so operators can see when the Sprint Leader SDK is still working.
export function startSprintLeaderProgress({ logger, kind, agentId, correlationId }) {
  const started = Date.now();
  const details = { agent_id: agentId, correlation_id: correlationId, task_id: correlationId, kind };
  logger.info?.("sprint_leader.started", { ...details, elapsed_seconds: 0 });
  const timer = logger.info ? setInterval(() => logger.info("sprint_leader.waiting", { ...details, elapsed_seconds: Math.floor((Date.now() - started) / 1000) }), 30_000) : null;
  timer?.unref?.();
  return (status, extra = {}) => {
    clearInterval(timer);
    if (status === "success") logger.info?.("sprint_leader.completed", { ...details, ...extra, elapsed_seconds: Math.floor((Date.now() - started) / 1000) });
  };
}
