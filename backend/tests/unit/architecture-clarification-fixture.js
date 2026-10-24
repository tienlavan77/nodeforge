// Supplies isolated real project files and a recording plan registry for Architecture clarification contract tests.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createOwnerChatCommandService } from "../../src/application/owner-chat-command-service.js";

export const question = { id: "STORAGE", title: "Lưu trạng thái ở đâu?", reason: "Phạm vi lưu trữ ảnh hưởng khôi phục", options: [{ id: "LOCAL", label: "Trình duyệt", description: "Lưu trong trình duyệt, không đồng bộ thiết bị" }, { id: "SERVER", label: "Server", description: "Theo tài khoản, cần API và quyền truy cập" }], recommended_option_id: "LOCAL" };
export const planMarkdown = "# Plan: Restore panels\n\n## 1. Mục tiêu\n\nRepository discovery complete. [Source: workflows/input.md]\n\n## 5. Tickets\n\n| Thứ tự | Nhóm việc | Implementation type | Mục tiêu | Phụ thuộc | Mutable-file budget | Acceptance criteria |\n| --- | --- | --- | --- | --- | --- | --- |\n| 1 | Restore | frontend | Restore panels | — | 4 files | Panel restores |\n\n## 6. Risks\n\nUnverified: runtime behavior requires browser verification.\n\n## 7. Nghiệm thu\n\nPanel restores.\n";

// Builds a source-bound command service whose provider calls and persisted Markdown can be inspected safely.
export async function clarificationFixture(context, questions = [question]) {
  await mkdir(join(process.cwd(), ".forge/scratch"), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".forge/scratch/architecture-choices-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "workflows/agents/architecture"), { recursive: true });
  await writeFile(join(root, "workflows/agents/architecture/README.md"), "# Architecture frame\n## 1. Goals\n## 7. Acceptance\n");
  await writeFile(join(root, "workflows/input.md"), "Restore Coding panels. Decide storage before implementation.\n");
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true });
  const records = []; const prompts = []; const events = [];
  const markdownPlanStore = {
    list: () => records,
    getRevision: async ({ planId }) => records.find((record) => record.plan_id === planId),
    createRevision: async ({ planId, markdown, summaryPath, summarySha256, conversationId }) => {
      const filePath = `.forge/runtime/nf/plans/${planId}/ke-hoach-r1.md`;
      await fileService.atomicCreate({ path: filePath, content: markdown });
      const record = { plan_id: planId, project_id: "PROJECT-A", revision: 1, sha256: createHash("sha256").update(markdown).digest("hex"), format: "markdown", markdown, file_path: filePath, source_path: summaryPath, source_sha256: summarySha256, conversation_id: conversationId, status: "awaiting_human_approval" };
      records.push(record); return record;
    }
  };
  const create = () => createOwnerChatCommandService({ projectId: "PROJECT-A", fileService, markdownPlanStore, planStore: { createRevision() {}, assertExecutable() {} }, publishPlanEvent: async (event) => events.push(event) });
  const provider = async (prompt) => { prompts.push(prompt); return prompt.startsWith("Architecture clarification discovery") ? JSON.stringify({ questions }) : planMarkdown; };
  const command = create();
  const start = () => command.execute({ text: "/plan workflows/input.md", conversationId: "CONV-A", requestArchitecture: provider });
  return { root, fileService, records, prompts, events, create, provider, command, start };
}
