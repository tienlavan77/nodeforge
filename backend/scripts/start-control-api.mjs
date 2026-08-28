// Notification contract support for indexed context requests.
// This helper keeps invalid or unavailable index results actionable without exposing
// filesystem access or internal error details to the agent.
const createContextNotification = ({ code, message, suggestedAction, targetPath, source = "index" }) => ({
  source,
  context_pack: null,
  notification: {
    code,
    message,
    suggested_action: suggestedAction,
    ...(targetPath ? { target_path: targetPath } : {})
  }
});

const normalizeIndexedContextResult = ({ result, targetPath }) => {
  if (result?.status === "ready" || result?.context_pack) {
    return {
      source: "index",
      context_pack: result.context_pack ?? result,
      notification: null
    };
  }

  const status = result?.status ?? "unavailable";
  if (status === "invalid_target") {
    return createContextNotification({
      code: "INVALID_TARGET",
      message: "The requested context target is invalid.",
      suggestedAction: "List indexed files and choose a valid project-relative path.",
      targetPath
    });
  }
  if (status === "missing") {
    return createContextNotification({
      code: "CONTEXT_MISSING",
      message: "The requested file is not present in the project index.",
      suggestedAction: "List indexed files, choose another path, or create the file before requesting context.",
      targetPath
    });
  }
  if (status === "stale") {
    return createContextNotification({
      code: "CONTEXT_STALE",
      message: "The indexed context is stale.",
      suggestedAction: "Refresh the index and retry the context request.",
      targetPath
    });
  }
  return createContextNotification({
    code: "INDEX_UNAVAILABLE",
    message: "The project context index is currently unavailable.",
    suggestedAction: "Retry later or list project files and choose a different indexed target.",
    targetPath
  });
};

const rejectOutsideProjectGuard = (targetPath) => ({
  source: "index",
  context_pack: null,
  notification: {
    code: "PATH_DENIED",
    message: "The requested path is outside the project boundary.",
    suggested_action: "Use a project-relative path within the guarded workspace.",
    target_path: targetPath
  }
});
