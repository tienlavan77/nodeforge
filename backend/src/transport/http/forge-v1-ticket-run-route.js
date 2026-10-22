// Routes ticket RUN aliases and authenticates explicit owner commit instructions before checkpoint recovery.
import { ConfigurationError } from "../../shared/errors.js";
import { runRequestsFresh, unavailable } from "./forge-v1-router-utils.js";

// Keeps ordinary RUN unchanged while binding renewed commit consent to the server-authenticated owner.
export async function routeTicketRun({ method, parts, projectId, body, url, headers, planOwnerAuth, dispatchTicket, requestId, correlationId }) {
  if (method !== "POST") return null;
  let ticketId;
  if (parts.length === 2 && parts[0] === "tickets" && parts[1].endsWith(":run")) ticketId = parts[1].slice(0, -4);
  else if (parts.length === 5 && parts[0] === "projects" && parts[2] === "tickets" && (parts[4] === "run" || parts[4].endsWith(":run"))) {
    projectId = parts[1];
    ticketId = parts[3];
  } else return null;
  if (typeof dispatchTicket !== "function") throw unavailable("Ticket Dispatch");
  const fresh = runRequestsFresh(url, body);
  let commitAuthorization;
  if (body.commit_authorization !== undefined) {
    const input = body.commit_authorization;
    if (fresh || !input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !["request_sha256", "reason"].includes(key))
      || !/^[a-f0-9]{64}$/.test(input.request_sha256 ?? "")
      || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 8000) {
      throw Object.assign(new ConfigurationError("Commit authorization accepts only the retained denial request SHA and explicit owner reason on Resume."), { code: "COMMIT_AUTHORIZATION_INPUT", statusCode: 400 });
    }
    if (typeof planOwnerAuth?.verify !== "function") throw unavailable("Owner authentication");
    commitAuthorization = { ...input, actor: planOwnerAuth.verify(headers) };
  }
  const result = await dispatchTicket({ projectId, ticketId, conversationId: "CONV-BUILDER", ...(fresh ? { fresh: true } : {}), ...(commitAuthorization ? { commitAuthorization } : {}) });
  return { status: 202, body: { ...result, request_id: requestId, correlation_id: correlationId } };
}
