// Saves agent edits with bounded requests and verifies that the API persisted the requested tool mode.
import { requestJson } from "./node-client-request.js";

// Returns a confirmed agent profile or an actionable error without leaving Save indefinitely pending.
export async function saveAgentSettingsForm({ url, agentId, settings, fetchTimeoutMs = 15000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const profile = await requestJson(agentId ? `${url}/${agentId}` : url, {
      method: agentId ? "PUT" : "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(settings), signal: controller.signal, fallbackError: "Could not save agent settings."
    });
    if (!profile?.agent_id || (agentId && profile.agent_id !== agentId)) throw new Error("API returned an invalid agent profile.");
    if (settings.tool_mode && profile.tool_mode !== settings.tool_mode) throw new Error("Control API chưa nạp bản hỗ trợ Tool mode. Restart API rồi kiểm tra lại agent trước khi lưu lại.");
    return profile;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Lưu agent quá thời gian chờ. Kiểm tra lại trạng thái agent trước khi thử lại.", { cause: error });
    throw error;
  } finally { clearTimeout(timer); }
}
