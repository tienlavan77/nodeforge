// Implements versioned lifecycle commands as a remote HTTP client with no project filesystem access.
// Explicit request keys survive uncertain mutation outcomes. Following status only reads backend
// receipts; callers must invoke retry separately and stopping observation never cancels admission.

// Parses explicit opt-in commands and keeps all lifecycle ownership, indexing and storage on the server.
export async function runLifecycleCli(args, { env, fetchImpl, stdout, stderr }) {
  const action = args[1];
  const options = {};
  const positionals = [];
  for (let i = 2; i < args.length; i++) {
    const value = args[i];
    if (value === "--lifecycle-v1" || value === "--follow") options[value] = true;
    else if (["--server", "--request-key", "--expected-attempt"].includes(value) && args[i + 1] && !args[i + 1].startsWith("--")) options[value] = args[++i];
    else if (value.startsWith("--")) { stderr.write("Invalid lifecycle option.\n"); return 1; }
    else positionals.push(value);
  }
  const mutation = ["create", "add"].includes(action);
  const retry = action === "retry";
  const status = action === "status";
  if (!mutation && !retry && !status && action !== "directory" ||
      positionals.length !== (mutation ? 1 : 0) || mutation && !positionals[0].startsWith("/") ||
      action !== "directory" && !options["--request-key"] ||
      retry && (!Number.isSafeInteger(Number(options["--expected-attempt"])) || Number(options["--expected-attempt"]) < 1)) {
    stderr.write("Usage: forge project create|add <server-root> --request-key <key> --lifecycle-v1; directory; status --request-key <key>; retry --request-key <key> --expected-attempt <n>. Supply --server <url>; --follow observes only.\n");
    return 1;
  }
  let base;
  try {
    base = new URL(options["--server"] ?? env?.NODEFORGE_CONTROL_API_URL);
    if (!["http:", "https:"].includes(base.protocol)) throw new Error("Expected HTTP server URL.");
  } catch (error) { stderr.write("Invalid Control API server URL: " + error.message + "\n"); return 1; }
  const requestKey = options["--request-key"];
  const endpoint = new URL(action === "directory" ? "/lifecycle/directory" :
    "/lifecycle/operations/" + (status ? "status" : action), base);
  if (status) endpoint.searchParams.set("request_key", requestKey);
  const body = mutation ? { root: positionals[0], request_key: requestKey } :
    retry ? { request_key: requestKey, expected_attempt: Number(options["--expected-attempt"]) } : undefined;
  const init = { method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-nodeforge-lifecycle": "1" },
    ...(body ? { body: JSON.stringify(body) } : {}) };
  try {
    let payload = await fetchJson(endpoint, init, fetchImpl);
    stdout.write(JSON.stringify(payload) + "\n");
    if (!options["--follow"] || !payload.operation) return payload.operation?.status === "failed" ? 2 : 0;
    for (let i = 0; i < 200; i++) {
      if (["succeeded", "failed", "cancelled"].includes(payload.operation.status)) return payload.operation.status === "succeeded" ? 0 : 2;
      await new Promise((resolve) => setTimeout(resolve, 25));
      const url = new URL("/lifecycle/operations/status", base);
      url.searchParams.set("request_key", requestKey);
      payload = await fetchJson(url, { method: "GET", headers: init.headers }, fetchImpl);
      stdout.write(JSON.stringify(payload) + "\n");
    }
    stderr.write("Observation ended; backend work continues. Reload status with the same request key.\n");
    return 2;
  } catch (error) {
    stderr.write(error.message + (requestKey ? " Reconcile using status --request-key " + requestKey + "; do not replay the mutation." : "") + "\n");
    return 1;
  }
}

// Performs one HTTP exchange only; transport failures never trigger an implicit mutation retry.
async function fetchJson(url, init, fetchImpl) {
  const response = await fetchImpl(url, init);
  const payload = JSON.parse(await response.text());
  if (!response.ok) throw new Error(payload?.error?.message ?? "Lifecycle request failed.");
  return payload;
}
