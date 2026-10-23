<!-- Architecture plan: retain one declared format per logical reply; make declared Markdown read naturally as prose plus structured blocks. -->
# Plan: Markdown opt-in an toàn, tự nhiên trong conversation và export được

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** Re-audit ngày **October 8, 2026** cho thấy policy plain-by-default đã được wired: `owner-agent-stream` chọn một `content_type` từ `response_content_type`, SSE/history chuyển tiếp type đó, và `MessageContent` chọn **một** renderer cho toàn bộ logical message. Nhưng UX chưa tự nhiên: reply `text/plain` chỉ có parser code/link hẹp, còn reply `text/markdown` dùng custom line parser giới hạn và gộp các dòng paragraph bằng space. Vì vậy không có cách render *một phần* raw plain và *một phần* Markdown theo semantics khác nhau trong cùng message; Markdown reply cũng có thể trông thô/khác kỳ vọng CommonMark.
- **Kết quả:** Một logical reply vẫn có exactly one declared `content_type`. Khi được khai báo `text/markdown`, **toàn bộ reply** được render như một Markdown document tự nhiên: prose bình thường là paragraph, còn headings/lists/emphasis/links/quotes/code/tables là Markdown blocks/inline. Khi `text/plain`, toàn bộ reply là literal plain text (trừ các affordance plain-text đã duyệt như fenced-code display). Không suy format từ bytes.
- **Giá trị:** Agent có thể viết một câu trả lời tự nhiên gồm giải thích thường, heading, list và code trong **một Markdown reply**, không cần chia response thành raw text vs Markdown. Đồng thời plain reply không bị renderer diễn giải nhầm.

## 2. Phạm vi

### In scope

- Giữ plain-by-default và Markdown explicit opt-in xuyên generation, SSE, persistence/history và live UI.
- Làm rõ UX/model: `text/markdown` là document-level format cho một logical reply, không phải chỉ một “khung Markdown” hoặc một block riêng.
- Nâng renderer conversation để Markdown document gồm prose + Markdown blocks đọc tự nhiên, giữ xuống dòng/hard-break theo policy renderer và render streaming partial an toàn.
- Chỉ hiện badge, Download `.md` và Write file với effective exact `text/markdown`.
- Sửa sizing chat/preview và bổ sung test behavioral/UI/security tương ứng.

### Out of scope

- Heuristic tự nhận Markdown từ agent role, event suffix hoặc syntax bytes.
- Segment/span-level format trong một message (ví dụ `{ text, segments: [{type, text}] }`), interleave delta có type khác nhau, hoặc đổi type giữa delta/completion.
- Public contract/schema/protocol change, migration/backfill hoặc scope rollout mới.
- Render Markdown cho user/tool/progress/activity/error/structured output/unknown type.
- Arbitrary project write, overwrite im lặng, absolute/traversal/protected path write.

> **Boundary bắt buộc:** Nếu “render trộn lẫn” nghĩa là từng đoạn trong một message phải có `text/plain` và `text/markdown` riêng, yêu cầu đó **không thể được thêm** trong plan đã duyệt: event/history/UI hiện có chỉ một `content_type` cho một logical message. Nó cần public protocol/schema/persistence revision, versioning và approval mới. Trong v1, “trộn lẫn tự nhiên” nghĩa là plain prose và Markdown constructs cùng nằm trong **một declared Markdown document**.

## 3. Hướng tiếp cận và guardrails

- **Type policy:** `content_type` explicit hợp lệ thắng. Missing/unknown/ambiguous luôn `text/plain`. Generic transport/persistence không được default `text/markdown`.
- **Reply-level declaration:** Request/UI chọn Markdown mode cho đúng logical reply; producer biết declaration trước first delta, giữ immutable qua delta/completion/persistence/history. Producer không chọn từng chunk theo syntax.
- **Natural Markdown rendering:** Với exact `text/markdown`, renderer phải parse toàn bộ raw `message.text` như một document. Prose giữa blocks phải thành paragraph; inline Markdown phải hoạt động trong prose/list/table; blank line và hard-break behavior phải được định nghĩa/test; partial fence/table/link khi stream không crash hoặc inject HTML.
- **Plain rendering:** `text/plain` hiển thị literal, không biến `#`, `-`, `**`, URL Markdown notation hay backticks thành Markdown. Điều này là intentional, không phải lỗi thiếu “mixed renderer”.
- **Renderer decision:** Custom parser hiện chỉ là subset (heading/list/table/quote/fence và một số inline forms) và gộp paragraph lines với space. Human/Architecture phải chốt một renderer strategy trước implementation: (a) dependency renderer được duyệt, không raw HTML; hoặc (b) parser nội bộ được mở rộng với syntax matrix/threat model rõ. SL không tự quyết dependency/security change.
- **Renderer security:** No `dangerouslySetInnerHTML`; React escaped output; links only `https:`, `http:`, `mailto:`; unsafe URL literal/inert. Raw bytes, not rendered DOM, are canonical for download/write.
- **Sizing:** Conversation variant auto-height/content constrained; preview owns viewport scroll. Long token không vượt bubble; code/table chỉ horizontal-scroll trong block.
- **Indicator/actions:** badge/action derive solely from effective exact type. Download raw UTF-8 deterministic/sanitized `.md`; no network write.
- **Write file:** Server revalidates project/conversation/message ownership, effective Markdown type and normalized relative `.md`; reject absolute/traversal/symlink escape/`.forge`/invalid extension; atomic no-overwrite create; explicit `409` conflict + confirm/retry; audit log excludes full prose.
- **Human chốt:** (a) v1 Markdown opt-in sources and Markdown-mode UX, (b) renderer strategy, (c) write destination/overwrite UX. Without approval, generic agent reply remains plain.

## 4. Audit evidence và khu vực dự kiến ảnh hưởng

| Thành phần / khu vực | Evidence đã đọc | Ý nghĩa |
| --- | --- | --- |
| `backend/src/application/owner-agent-stream.js` | `contentType` được chọn một lần từ `message.payload.response_content_type`; cùng value được gửi cho delta/received/persisted response. | Confirms reply-level, not segment-level type boundary. |
| `ui/nextjs/lib/home-page-event-stream.js` | State message có single `content_type`; every delta appends `chunk` vào one `text` field và set lại one type. | UI cannot faithfully represent mixed typed spans without contract/state redesign. |
| `ui/nextjs/lib/use-conversation-message-history.js` | `toMessage` resolves one `content_type` per persisted record; provenance fallback is narrow. | History must preserve one reply declaration. |
| `ui/nextjs/components/conversation-message-content.jsx` | Exact `text/markdown` takes an exclusive `MarkdownPreviewContent` branch; plain branch has its own narrow code parser. | Direct root cause of no two-renderer mix inside a message; this is correct under v1 boundary. |
| `ui/nextjs/components/markdown-preview-content.jsx` | Custom renderer joins paragraph lines with `" "`; syntax support is deliberately small. | Major UX candidate: declared Markdown does not yet render like a complete natural document. |
| `ui/nextjs/components/conversation-response-reveal.jsx` | Re-renders the growing visible prefix through `MessageContent`. | Streaming parser must tolerate incomplete Markdown deterministically. |
| `ui/nextjs/tests/conversation-markdown-content.test.js` | Tests exact type/security strings, not natural document fixtures or no-segment-mixing contract. | Verification gap. |

Candidate areas guide SL discovery only; they are not a mutable-file manifest.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Plain remains the safe default. | Generic agent stream/received/persisted response is `text/plain` without declaration; no generic Markdown literal default. | Human approves v1 opt-in. |
| O2 | Markdown is reply-level explicit opt-in. | Eligible response has exact `text/markdown` consistently from first delta through reload; type never changes mid-message. | O1. |
| O3 | No unsupported mixed-type semantics. | One logical message resolves exactly one effective type; state/history do not infer spans from syntax; any segment-level request is escalated as contract change. | No schema/protocol change. |
| O4 | Plain and Markdown are visibly distinct. | Plain treats Markdown tokens literal; declared Markdown parses the entire reply document, including ordinary prose between Markdown blocks. | O2–O3. |
| O5 | Markdown reply reads naturally. | Fixture with intro prose, heading, emphasis, list, quote, link, fenced code, table and closing prose renders in reading order; paragraph/newline policy is preserved and partial stream does not crash/flicker into unsafe DOM. | Approved renderer strategy. |
| O6 | Renderer is safe and bounded. | HTML/script/event attributes inert; unsafe URLs not active; long code/table scroll in block; chat auto-height and preview scroll independent, including mobile. | O4–O5. |
| O7 | Legacy fails closed. | Only explicit type or durable approved provenance yields Markdown; missing/unknown/agent-event suffix remains plain. | O1–O3. |
| O8 | Badge/export are truthful. | Accessible Markdown badge and raw UTF-8 `.md` download only for effective Markdown; plain reply has neither. | O2–O7. |
| O9 | Write file is safe. | Only effective Markdown may write; ownership/type/path revalidated server-side; atomic create, checksum, no silent overwrite, conflict/retry and abuse-path coverage. | Human UX decision, secure API boundary. |
| O10 | Verification covers live and reload. | Tests cover O1–O9 with plain-vs-declared-Markdown document fixtures, history/live equality, partial markers, XSS/link abuse, sizing and write conflict/path abuse. | O1–O9. |

**Gợi ý delivery (không bắt buộc):** O1–O4 type contract tests can proceed separately from renderer/sizing discovery. Do not expose Markdown mode/actions before O1–O7. Secure write API precedes O9 UI.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / xử lý |
| --- | --- | --- | --- |
| Requirement may mean segment-level typed content. | Blocker | Current stream, history and UI each store one type + one text value per logical message. | Human either accepts document-level Markdown v1 or approves a separate contract revision. |
| Current custom parser is too narrow for natural chat Markdown. | Major | It joins paragraph lines with spaces and implements a limited syntax subset. | Human/Architecture selects renderer strategy before SL dispatch. |
| Markdown opt-in UI is undiscovered/unclear to human. | Major | Request carries `response_content_type`; actual user-facing selector needs SL discovery. | Define v1 Markdown-mode UX and eligible sources. |
| Streaming incomplete syntax changes layout while text arrives. | Major | Reveal sends growing prefixes back through the renderer. | Fixture/test partial fences, links, tables; deterministic graceful state. |
| File write expands capability. | Blocker | Secure service exists as a candidate but path/ownership behavior needs full verification. | Security/backend enforcement and owner approval. |

## 7. Acceptance criteria của plan

- [x] Re-audit xác nhận current model là one `content_type` per logical reply, không phải per text span, vào **October 8, 2026**.
- [x] Plan phân biệt rõ Markdown document tự nhiên với unsupported mixed typed segments.
- [x] Plain-by-default, explicit opt-in, fail-closed legacy và renderer/write security guardrails được giữ.
- [x] Fit-to-content, badge, download và write-file vẫn gate bằng effective Markdown type.
- [ ] Human chốt v1 opt-in UX/source, renderer strategy, destination/overwrite; nếu yêu cầu segment-level, cần revision kiến trúc/contract riêng.
- [ ] Persist artifact immutable và owner approve exact `plan_id`, revision, SHA-256 trước Sprint Plan; approval không phải RUN/dispatch.

**Trạng thái:** Architecture audit/plan updated only; no source code, schema, protocol, dependency or runtime state was changed.