// Recovers conversation history reads from brief control API or proxy connection interruptions without replaying owner commands.
import { requestJson } from "./node-client-request.js";

// Retries only one failed history GET; authorization, validation and cancellation failures remain authoritative.
export async function requestConversationMessages(url) {
  const options = { cache: "no-store", fallbackError: "Node could not load conversation messages." };
  try { return await requestJson(url, options); }
  catch (error) {
    const aborted = error.name === "AbortError" || error.cause?.name === "AbortError";
    const networkFailure = error instanceof TypeError || error.status === null && error.cause instanceof TypeError;
    if (aborted || !networkFailure && ![502, 503, 504].includes(error.status)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return requestJson(url, options);
  }
}
