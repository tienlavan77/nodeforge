/**
 * Provides project-bound Notebook CRUD without involving conversation messages or agent execution.
 * Collection requests carry the selected project; item requests address independent Notebook IDs.
 */
import { requestJson } from "./node-client-request.js";
import { forgeV1 } from "./node-client-url.js";

/** Build the Notebook transport methods with injectable HTTP dependencies for contract verification. */
export function createNotebookClient({ url = forgeV1, request = requestJson } = {}) {
  /** Send a JSON mutation containing only fields accepted by the Notebook resource contract. */
  const mutate = (path, method, body) => request(url(path), {
    method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return {
    /** List both active and completed Notebook entries so users can reopen completed work. */
    listNotebook({ projectId, status = "all" }) {
      return request(url(`/notebook?project_id=${encodeURIComponent(projectId)}&status=${encodeURIComponent(status)}`));
    },
    /** Capture quick-entry content in the selected project without sending a conversation message. */
    createNotebook({ projectId, content }) {
      return mutate("/notebook", "POST", { project_id: projectId, content });
    },
    /** Read an independently addressed Notebook entry while project binding guards the caller context. */
    getNotebook({ id }) { return request(url(`/notebook/${encodeURIComponent(id)}`)); },
    /** Update only content, status, and position; project context must never enter the PATCH payload. */
    updateNotebook({ id, content, status, position, expected_version }) {
      return mutate(`/notebook/${encodeURIComponent(id)}`, "PATCH", {
        expected_version,
        ...(content === undefined ? {} : { content }),
        ...(status === undefined ? {} : { status }),
        ...(position === undefined ? {} : { position })
      });
    },
    /** Delete a confirmed Notebook entry through its independent item endpoint. */
    deleteNotebook({ id, expected_version }) {
      return mutate(`/notebook/${encodeURIComponent(id)}?expected_version=${encodeURIComponent(expected_version)}`, "DELETE");
    }
  };
}
