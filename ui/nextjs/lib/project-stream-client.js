// Shares one project SSE connection across workspace panels and recovers subscriptions.
import { isProjectStreamEvent, PROJECT_EVENT_TYPES } from "./project-stream-event.js";

// Creates a reference-counted project stream so Sprint panels do not exhaust browser connections.
export function createProjectStreamClient(forgeV1) {
  const streams = new Map();
  return function connectProjectStream({ projectId, afterEventId, onEvent, onOpen, onError } = {}) {
    if (typeof projectId !== "string" || !projectId.trim()) throw new Error("Project stream requires a project id.");
    if (typeof onEvent !== "function") throw new Error("Project stream requires an onEvent handler.");
    if (typeof EventSource !== "function") throw new Error("Project stream requires EventSource support.");
    const key = `${projectId}\0${afterEventId ?? ""}`;
    let stream = streams.get(key);
    if (!stream) {
      const source = new EventSource(forgeV1("/stream", { project: projectId, ...(afterEventId ? { after: afterEventId } : {}) }));
      stream = { source, subscribers: new Set(), delivered: new Set(), lastEventId: afterEventId ?? null };
      streams.set(key, stream);
      const shared = stream;
      const notifyError = (error) => { for (const subscriber of shared.subscribers) subscriber.onError?.(error); };
      const handleEvent = (event) => {
        if (event.lastEventId) shared.lastEventId = event.lastEventId;
        let data;
        try { data = JSON.parse(event.data); }
        catch (error) { notifyError(Object.assign(new Error("Project stream returned invalid JSON.", { cause: error }), { code: "STREAM_INVALID_JSON" })); return; }
        if (!isProjectStreamEvent(data, projectId)) { notifyError(Object.assign(new Error("Project stream returned an invalid event."), { code: "STREAM_INVALID_EVENT" })); return; }
        if (shared.delivered.has(data.event_id)) return;
        shared.delivered.add(data.event_id);
        if (shared.delivered.size > 5000) shared.delivered.delete(shared.delivered.values().next().value);
        for (const subscriber of shared.subscribers) subscriber.onEvent(data);
      };
      PROJECT_EVENT_TYPES.forEach((type) => source.addEventListener(type, handleEvent));
      source.onopen = () => { for (const subscriber of shared.subscribers) subscriber.onOpen?.(); };
      source.onerror = (error) => {
        const reconnecting = source.readyState === 0;
        notifyError(Object.assign(new Error(reconnecting ? "Project stream is reconnecting." : "Project stream connection failed.", { cause: error }), { code: reconnecting ? "STREAM_RECONNECTING" : "STREAM_CONNECTION_FAILED" }));
      };
    }
    const subscriber = { onEvent, onOpen, onError };
    stream.subscribers.add(subscriber);
    if (stream.source.readyState === 1) queueMicrotask(() => { if (stream.subscribers.has(subscriber)) onOpen?.(); });
    return Object.freeze({
      close: () => { stream.subscribers.delete(subscriber); if (!stream.subscribers.size) { stream.source.close(); streams.delete(key); } },
      getLastEventId: () => stream.lastEventId
    });
  };
}
