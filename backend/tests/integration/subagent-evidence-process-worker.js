// Business purpose: exercises evidence updates from independently initialized project processes.
// Technical description: waits at an IPC barrier, then records retrieval, source and worker
// completion attempts against the same role store, using unique identities for loss detection.
import { createSubagentEvidenceStore } from "../../src/tools/discovery/subagent-evidence-store.js";

const [projectRoot, projectId, workerId] = process.argv.slice(2);
const store = createSubagentEvidenceStore({ projectRoot, projectId });
const scope = { projectRoot, projectId, role: "system_engineer", conversationId: projectId, delegationId: workerId, workerId };
store.startWorker({ ...scope, objective: "Concurrent evidence persistence" });
process.send({ ready: true });
process.once("message", async () => {
  try {
    for (let index = 0; index < 15; index++) {
      const identity = workerId + ":" + index;
      const receipt = store.recordCandidateReceipt({ ...scope, path: "shared.js", sha256: "sha256:shared", attempt_id: identity, reasons: ["concurrent"] });
      if (!receipt.durable) throw Error("Receipt was not persisted");
      const evidence = store.recordDirectEvidence({ ...scope, path: "shared.js", sha256: "sha256:shared", attempt_id: identity + ":source", symbols_read: [workerId] });
      if (!evidence.durable) throw Error("Source evidence was not persisted");
    }
    const result = await store.complete({ ...scope, summary: workerId, observedFiles: [{ path: workerId + ".js", sha256: "sha256:worker" }] });
    if (!result.durable) throw Error("Worker completion was not persisted");
    process.send({ done: true });
    process.disconnect();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    process.disconnect();
  }
});
