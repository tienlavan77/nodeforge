<!-- Architecture proposal: analyze conversation content into syntax nodes before rendering, without assigning a document MIME type from syntax. -->
# Plan: UI phân tích nội dung conversation trước khi render

- **Identity:** conversation-content-analysis
- **Revision:** r1
- **Trạng thái:** Draft — chờ human duyệt; không phải quyền RUN/dispatch.
- **Ngày:** October 8, 2026
- **Decision owner:** Human owner; Architecture giữ boundary; SL phân rã delivery, Coder triển khai.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** UI hiện chọn renderer theo `content_type`; nhánh plain chỉ nhận code/link hẹp, nhánh Markdown dùng parser regex giới hạn. Người dùng muốn tự phân tích nội dung thay vì tick Markdown hoặc ép toàn bộ reply vào một format.
- **Kết quả:** Reply agent đi qua phân tích block/inline; UI render từng node có cấu trúc và giữ văn bản không có định dạng. Không yêu cầu `content_type: text/markdown` để nhận heading/list/emphasis/code.
- **Giá trị:** Một reply có prose, heading, list, code và prose kết thúc hiển thị tự nhiên cả khi live và tải lại history.
- **Giới hạn phải nói đúng:** Đây là nhận diện cú pháp theo grammar đã chọn, không phải AI đoán ý định. `**abc**` hợp lệ được hiểu là strong; muốn xem dấu nguyên văn có chế độ raw. Không hứa phân biệt ý định từ một chuỗi nhập nhằng.

## 2. Phạm vi

### In scope

- Phân tích và render nội dung text của reply agent trong các conversation surfaces dùng `MessageContent`.
- Grammar đề xuất: CommonMark block/inline + GFM tables; không phát triển một grammar riêng bằng regex.
- Bảo toàn raw text, xuống dòng; renderer node, code copy, local `.md` preview, raw view, streaming/history parity và security tests.
- Bỏ checkbox `Markdown reply` khỏi vai trò điều kiện để hiển thị định dạng tự động; ngừng gửi opt-in cho lượt gửi mới nếu không còn mục đích khác sau discovery.
- Giữ dữ liệu/metadata cũ và các API export/write hiện có; tách chúng khỏi kết quả phân tích để không mở rộng quyền ghi file.

### Out of scope

- Thay backend generation, prompt, MIME contract, schema, SSE, database hoặc migration/backfill.
- Auto-format owner input, system/error/tool/activity và JSON/structured payloads.
- Tự đổi `content_type`, gán typed spans vào protocol hoặc dùng syntax detection để cấp quyền Download/Write file.
- HTML/MDX execution, remote images, syntax highlighting mới, math và refactor toàn bộ file-preview renderer.

## 3. Hướng tiếp cận và guardrails

### 3.1 Luồng đề xuất

```text
Raw message.text (canonical; không sửa)
  -> Eligibility: đúng reply text của agent, không phải error/tool/structured payload
  -> Parser block + inline -> AST có source positions
  -> View projection: literal text / formatted node / code node
  -> React UI + raw toggle
```

- **Không ép MIME:** `content_type` vẫn là metadata producer gửi; UI không ghi đè nó thành Markdown vì gặp dấu cú pháp. Với reply agent thuộc scope, `text/plain` hoặc thiếu metadata vẫn được phân tích; không dùng MIME đó làm nhánh chặn parser.
- **Eligibility không phải format detection:** Cần truyền ngữ cảnh message role/kind từ caller, không tự suy role từ `content_type` hay từ chuỗi. Nội dung không thuộc scope giữ hành vi hiện tại.
- **Parser trước, UI sau:** Nhận toàn bộ input để giải quyết nesting/reference links; không cắt chuỗi bằng regex rồi parse các đoạn độc lập. AST là cấu trúc hiển thị nội bộ, không phải typed segments của public protocol.
- **Hướng parser:** Đề xuất pipeline `unified` + `remark-parse` + `remark-gfm` hoặc mdast equivalent, renderer React kiểm soát node. Có thể dùng `react-markdown` nếu SL chứng minh đạt source-position/literal/affordance contract mà không parse trùng. Không hardcode version trước khi kiểm tra runtime và dependency policy.
- **Phân loại node:** Heading, list, quote, thematic break, table, emphasis, strong, link, inline/fenced/indented code render theo node. Paragraph/root/text không tự được coi là bằng chứng có định dạng.
- **Không có cấu trúc định dạng:** Render nguyên input dạng escaped text, giữ xuống dòng, khoảng trắng và dòng trống; không stringify AST vì có thể thay đổi bytes.
- **Có cấu trúc định dạng:** Render cây nội dung theo reading order; text thường bên trong node vẫn là text. Giữ soft line breaks của paragraph thành xuống dòng theo policy conversation. Khoảng trắng có ý nghĩa trong code phải giữ; spacing giữa blocks là layout, không cam kết pixel-identical với raw.
- **Unsupported/HTML:** Không chạy hoặc bỏ im lặng nội dung HTML; hiển thị literal escaped bằng source slice. Node không hỗ trợ cũng fallback source literal, không mất nội dung.
- **Code:** Không diễn giải tiếp Markdown trong code. Copy lấy giá trị code node, không DOM text chứa label/Copy; `.md` preview chỉ theo affordance local-path đã xác minh, không biến nội dung cả code block thành action.
- **Raw view:** Toggle cục bộ mỗi message, không đổi metadata/backend và không phải checkbox trước khi gửi. Copy whole reply lấy raw text ở cả hai view.

### 3.2 Streaming và hiệu năng

- Parser nhận snapshot/prefix tích lũy, không parse từng delta độc lập. Phần cú pháp chưa hoàn chỉnh giữ literal trừ khi grammar đã nhận diện thành node (ví dụ fence mở có thể là code tới cuối snapshot).
- Cho phép tail đổi presentation khi cú pháp hoàn tất; không hứa mọi node đã hiện luôn bất biến vì reference/nesting có thể phụ thuộc nội dung sau.
- Khi stream kết thúc, kết quả phải trùng parse toàn bộ final text và trùng history reload; không tự thêm marker đóng vào raw.
- Cache theo text revision + parser policy; chỉ parse message thay đổi. Không parse lại mỗi render không liên quan hoặc vừa parse phân loại vừa parse render cùng snapshot.
- SL benchmark fixture lớn và reveal tick hiện có (~32 ms); nếu không đạt tương tác mượt thì coalesce updates, giữ final flush. Không khai báo performance đạt khi chưa đo.

### 3.3 Security, compatibility và dependency thật sự

- Không `dangerouslySetInnerHTML`, không raw HTML plugin/MDX; URL active chỉ `http:`, `https:`, `mailto:`. Unsafe links hiển thị inert/literal; remote images không tự tải.
- Source AST/raw không được log full message hoặc persist thêm ngoài contract hiện có; lỗi parser log tối thiểu và fallback escaped raw, không swallow exception.
- Long token wrap; code/table scroll ngang trong block, không làm tràn bubble; conversation auto-height, preview không đổi behavior ngoài scope.
- **Thay đổi semantics có chủ ý:** Reply agent `text/plain` hiện literal sẽ được phân tích cú pháp. Không thay wire schema, nhưng không gọi đây là hoàn toàn backward-compatible về presentation.
- `workflows/plan-markdown-review.md` đang quy định plain-by-default và cấm infer từ bytes: plan này đề xuất thay policy presentation đó trong scope reply agent. Không sửa/ghi đè plan cũ hoặc chuyển approval cũ sang revision này.
- **Dependency bắt buộc:** Human approve thay đổi policy presentation và parser/dependency strategy trước implementation. SL xác minh tất cả callers/role context và contracts export/write trước khi chốt manifest. Nếu phát hiện server cần đổi contract, escalate revision riêng.
- Rollback bằng revert riêng UI presentation/composer; raw/history/MIME giữ nguyên nên không cần data migration. SL chọn rollout mechanism, không mở rộng feature-flag infrastructure.

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Khu vực đã khảo sát | Vai trò / evidence | Mức chắc chắn |
| --- | --- | --- |
| `ui/nextjs/components/conversation-message-content.jsx:8–43` | `MessageContent` rẽ nhánh exact Markdown MIME; plain dùng parser code/inline hẹp. SHA-256 `85c47283afa60b04b43982e2beae6553e029bdb7a8a1100249ab2fd5e91b86e8`. | Đã đọc source |
| `ui/nextjs/components/markdown-preview-content.jsx:5–65` | Regex block/inline, paragraph join bằng space; chưa phải parser AST đầy đủ. SHA-256 `7895938ebba354d3260f130540a6d526c06ed1be086ee6fe0224a3dac681e980`. | Đã đọc source |
| `ui/nextjs/components/conversation-response-reveal.jsx:9–51` | Render prefix đang tăng, tick 32 ms, truyền contentType; cần eligibility/revision rõ. SHA-256 `ed04dd06536f9914389ec66978be3c7a041aef64f00f36d5fb51a69d94c7503c`. | Đã đọc source |
| `ui/nextjs/package.json` | Next/React có sẵn, chưa khai báo Markdown dependency. SHA-256 `acf3fc01b023b987f6f0fc500e580dd1dc360c6789c11bb65e073b4d6845ae61`. | Đã đọc source |
| Composer, message actions, callers, event/history adapters và tests conversation | Search xác định checkbox `markdownReply`, actions dựa MIME, live/history giữ type; SL cần đọc sâu trước triển khai. | Chỉ content search/file listing; chưa audit hoàn chỉnh |
| `workflows/plan-markdown-review.md` | Policy opt-in cũ xung đột hướng mới. SHA-256 `5e892ac0db1a754ad83a161bfbf17300dcf5cca9693d79b42c41f639f81ba993`. | Đã đọc phần policy/outcomes; approval runtime chưa xác minh |

Candidate areas không phải mutable-file allowlist. SL đọc local Next docs theo `ui/nextjs/AGENTS.md`, giữ giới hạn 250 dòng/file và rule comments/glossary trước code.

External references đã đối chiếu: CommonMark Spec 0.31.2 (block/inline/fence); official `remarkjs/remark` và `remark-parse` README (parse -> mdast); official `remarkjs/react-markdown` README (AST rendering, plugins và security). Các tài liệu này hỗ trợ lựa chọn parser, không chứng minh compatibility của repository.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Không cần format checkbox/MIME để hiển thị reply agent | Cùng fixture có type plain/Markdown/missing cho cùng AST presentation; prose thuần giữ nguyên dòng/khoảng trắng; owner/system/error/tool không bị auto-format. Không đổi metadata. | Human duyệt policy |
| O2 | Node-level rendering đúng cú pháp | Fixture intro -> strong -> heading -> nested list -> quote -> fence -> GFM table -> outro đúng reading order; inline-only cũng render; escaped markers literal; dấu trong code không bị parse tiếp. | Parser được duyệt |
| O3 | Live và history nhất quán | Chia input tại mọi vị trí cho fixture ngắn gồm emphasis/link/fence/table, mọi prefix không crash/mất text; final render bằng full parse và history reload. Có test reveal/retry/replacement revision. | O1–O2 |
| O4 | Raw và affordances không hỏng | Toggle raw/copy giữ original text; code copy không chứa UI label; local `.md` preview vẫn hoạt động; badge/export/write không tự được cấp vì AST có formatted node. | Giữ server gates |
| O5 | Security và layout an toàn | HTML/script/event attributes inert; javascript/data URLs không active; ảnh remote không tải; long token/code/table không tràn bubble; mobile và keyboard actions dùng được. | No HTML execution |
| O6 | Có verification thực, không chỉ grep source | Unit parser/projection + component rendered-node tests + live/history integration; benchmark long message và reveal, báo số liệu; UI build/lint theo scripts hiện hành, ghi baseline failures nếu có. | SL map đầy đủ O1–O5 |

**Gợi ý delivery, không bắt buộc:** Chốt fixtures/policy trước; tách parser/projection khỏi integration/affordances để giảm risk. SL tự quyết tickets, thứ tự, dependencies và mutable manifest; mỗi ticket tuân thủ policy hiệu lực.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / xử lý |
| --- | --- | --- | --- |
| Xung đột opt-in policy cũ | Blocker trước implementation | Plan cũ cấm inference; trạng thái approval runtime chưa khảo sát. | Human duyệt identity/revision/hash mới; SL xác minh gates, không reuse approval |
| Cú pháp hợp lệ nhưng người viết muốn literal | Major | Không có signal ý định trong raw string. | Chấp nhận grammar + raw view; không hứa đoán ý định |
| Các caller chưa truyền role/kind | Major | `MessageContent` hiện chỉ nhận text/type/callback. | SL audit callers, không vô tình format error/owner |
| Parser/plugin dependency/runtime compatibility | Major | UI chưa có dependency parser; Next local rules yêu cầu đọc docs. | Architecture/human duyệt strategy; SL xác minh versions/runtime/license/security |
| Reveal reparses lớn và tail đổi layout | Major | Prefix updates hiện mỗi khoảng 32 ms. | Benchmark/coalesce; final flush và parity bắt buộc |
| Export/write server có điều kiện type riêng | Major | UI action search cho thấy gate MIME; backend chưa audit ở plan này. | Giữ gates, không dùng AST làm authorization; discovery trước integration |

## 7. Acceptance criteria của plan / handoff

- [x] Mục tiêu, phạm vi và outcomes bám yêu cầu phân tích nội dung trước khi render.
- [x] Facts có source evidence; vùng chỉ search và giả định được phân biệt.
- [x] Guardrails/security/compatibility và dependencies tách khỏi gợi ý delivery.
- [x] Không áp đặt số/tên ticket, không biến candidate areas thành manifest cố định.
- [ ] Human approve đúng identity `conversation-content-analysis`, revision `r1` và whole-file SHA-256 theo storage contract hiệu lực.
- [ ] SL chứng minh coverage O1–O6, xác minh policy ticket/contract hiện hành trước dispatch.
- [ ] Approval cho lập SP không tự RUN/dispatch; Architecture không tự approve hoặc review implementation.
