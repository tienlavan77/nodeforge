# FORGE-NOTIFY-004 - Agent Payload Audit

## Runtime assignment

- `builder`: provider `codex`, model `gpt-5.6-sol`, gateway `https://sv.devquote.shop`.
- `architecture-manager`: provider `claude`, model `claude-haiku-4-5`.
- The `FORGE-NOTIFY-004` dispatch was sent to `builder`, not directly to the Claude architecture-manager agent.

## Payload sent by Node

The dispatch message sent to Builder was equivalent to:

```json
{
  "task_id": "FORGE-NOTIFY-004",
  "conversation_id": "CONV-BUILDER",
  "text": "Ticket FORGE-NOTIFY-004: Render unified Node notifications in Next.js UI\nObjective: Hiển thị notification backend bằng ngôn ngữ dễ hiểu trong chat và ticket cards, không phụ thuộc hoàn toàn vào SSE để báo trạng thái.\nAcceptance criteria:\n- Chỉ sửa ui/nextjs/app/NodeForgeApp.jsx, helper dưới ui/nextjs/lib và test dưới ui/nextjs/tests.\n- Tạo formatter dùng notification.code/status/severity/message/suggested_action, có fallback cho response legacy.\n- Ticket creation, dispatch, retry failed, context missing và verification failure đều hiển thị thông báo rõ ràng cho người dùng.\n- Nút Run hiển thị accepted/pending/error từ HTTP response ngay cả khi SSE chưa phát event; SSE vẫn cập nhật trạng thái live khi có.\n- Thông báo không render raw JSON hoặc stack trace; severity có styling/accessibility phù hợp.\n- Chạy lint, typecheck, Next build, test formatter và git diff --check; commit riêng sau khi pass.\nDependencies: FORGE-NOTIFY-002, FORGE-NOTIFY-003\n\nSubmission format: return agent_tool submit_code with a concrete target_path, module_system=esm, change_format=full_content, and the complete content of every submitted file. Do not return unified diff or apply_patch syntax.",
  "task": {
    "id": "FORGE-NOTIFY-004",
    "project_id": "PROJECT-NODEFORGE",
    "roadmap_id": "ROADMAP-NODEFORGE",
    "sprint_id": "SPRINT-FORGE-NOTIFY-001",
    "title": "Render unified Node notifications in Next.js UI",
    "status": "failed",
    "priority": "high",
    "dependencies": ["FORGE-NOTIFY-002", "FORGE-NOTIFY-003"]
  }
}
```

## Observed result

The successful retry returned `submit_code` with `change_format: "full_content"` and wrote:

```text
ui/nextjs/lib/notification-formatter.js
```

The earlier failure used an invalid target path (`ui/nextjs`), which is a directory rather than a file. It was rejected by the Node path guard before writing.

## Contract note

The ticket did not include `payload.response_format`. The Node prompt therefore supplied the default `full_content` contract. A ticket can explicitly request another format, but the runtime must pass that preference into the Builder prompt and validate the returned `change_format` before applying it.
