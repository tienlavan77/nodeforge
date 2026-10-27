/**
 * Provides project-bound Ideas CRUD without involving conversation messages or agent execution.
 * Collection requests carry the selected project; item requests address independent Idea IDs.
 * Explicit request bodies preserve the backend PATCH allowlist while the outer project binding
 * keeps callbacks associated with the immutable workspace selection.
 */
import { forgeV1 } from "./node-client-url.js";
import { requestJson } from "./node-client-request.js";

/** Build the Ideas transport methods with injectable HTTP dependencies for contract verification. */
export function createIdeasClient({ url = forgeV1, request = requestJson } = {}) {
  /** Send a JSON mutation containing only fields accepted by the Ideas resource contract. */
  const mutate = (path, method, body) => request(url(path), {
    method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return {
    /** List both active and completed Ideas so users can reopen completed work. */
    listIdeas({ projectId, status = "all" }) {
      return request(url(`/ideas?project_id=${encodeURIComponent(projectId)}&status=${encodeURIComponent(status)}`));
    },
    /** Capture quick-entry content in the selected project without sending a conversation message. */
    createIdea({ projectId, content }) {
      return mutate("/ideas", "POST", { project_id: projectId, content });
    },
    /** Read an independently addressed Idea while project binding guards the caller context. */
    getIdea({ id }) { return request(url(`/ideas/${encodeURIComponent(id)}`)); },
    /** Update only content and status; project context must never enter the PATCH payload. */
    updateIdea({ id, content, status, expected_version }) {
      return mutate(`/ideas/${encodeURIComponent(id)}`, "PATCH", {
        expected_version, ...(content === undefined ? {} : { content }), ...(status === undefined ? {} : { status })
      });
    },
    /** Delete a confirmed Idea through its independent item endpoint. */
    deleteIdea({ id, expected_version }) {
      return mutate(`/ideas/${encodeURIComponent(id)}?expected_version=${encodeURIComponent(expected_version)}`, "DELETE");
    }
  };
}
