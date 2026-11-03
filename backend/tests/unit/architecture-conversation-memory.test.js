// Verifies durable AM conversation continuity across repeated compaction and provider changes.
// Owner requirements outlive the eight-turn SDK tail without promoting assistant proposals.
import test from "node:test";
import assert from "node:assert/strict";
import { buildArchitectureConversationMemory, formatArchitectureConversationMemory } from "../../src/application/architecture-conversation-memory.js";

test("older owner decisions and plan references survive repeated memory reconstruction", () => {
  const owner = { role: "User", text: "Chỉ trao đổi kế hoạch, chưa code. PLAN-PROJECT-A r2. Đã bác bỏ phương án B." };
  let memory = buildArchitectureConversationMemory(null, [owner, { role: "Assistant", text: "Đề xuất C, chờ Owner quyết định." }]);
  for (let round = 0; round < 5; round += 1) {
    memory = buildArchitectureConversationMemory(JSON.parse(JSON.stringify(memory)), Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "Assistant" : "User", text: "Round " + round + " discussion " + i })));
  }
  assert.deepEqual(memory.entries[0], owner);
  const prompt = formatArchitectureConversationMemory(memory);
  assert.ok(prompt.includes(owner.text));
  assert.match(prompt, /never approval by themselves/);
});

test("repeated owner corrections keep their latest chronological authority", () => {
  const memory = buildArchitectureConversationMemory(null, [
    { role: "User", text: "Chọn A" }, { role: "User", text: "Chọn B" }, { role: "User", text: "Chọn A" }
  ]);
  assert.equal(memory.entries.at(-1).text, "Chọn A");
  assert.equal(memory.entries.length, 2);
});

test("bounded memory evicts assistant prose first and explicitly discloses omissions", () => {
  const owner = { role: "User", text: "Không tự triển khai; giữ câu hỏi đang mở." };
  const memory = buildArchitectureConversationMemory(null, [owner, ...Array.from({ length: 180 }, (_, i) => ({ role: "Assistant", text: String(i) + "x".repeat(1000) }))]);
  assert.ok(memory.entries.some((turn) => turn.text === owner.text));
  assert.ok(memory.entries.length <= 160);
  assert.ok(memory.entries.reduce((sum, turn) => sum + turn.text.length, 0) <= 64000);
  assert.equal(memory.truncated, true);
  assert.match(formatArchitectureConversationMemory(memory), /Some older discussion was omitted/);
});
