<!-- Architecture plan only; chưa triển khai runtime, tool registration hoặc test. -->
# Plan: Tool search web cho agent

**Trạng thái:** `PLANNED — CHƯA CODE`

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** Agent hiện chỉ có retrieval nội bộ. Built-in `WebSearch`/`WebFetch` bị chặn theo `docs/forge-mcp-tools-spec.md`, nên agent không thể tự tra cứu tài liệu ngoài repo.
- **Kết quả:** Agent được cung cấp Forge MCP tool `web_search`; Node gọi provider, giữ secret, giới hạn quota và trả kết quả bounded.
- **Giá trị:** Mở rộng retrieval mà vẫn giữ Node làm boundary, authorization, budget và verifier.

## 2. Phạm vi

### In scope

- `web_search` cho owner conversation, có provider abstraction và mock provider cho test.
- Cấu hình provider, secret, timeout, quota và cache TTL qua bootstrap config/env.
- Đăng ký definition/implementation qua Forge registry hiện có; kiểm tra role/capability và logging/redaction.
- Chuẩn hóa kết quả thành danh sách `title`, `url`, `snippet`, `source` với kích thước giới hạn.

### Out of scope

- Browser automation, crawl nhiều trang, chạy JavaScript hoặc trả full-page HTML.
- Cho agent giữ key, tự chọn endpoint, gọi provider trực tiếp, hoặc mở built-in web/network tools.
- `web_fetch` trong phase đầu; UI hiển thị kết quả; sửa workflow approval/ticket.

## 3. Hướng tiếp cận và guardrails

- **Ràng buộc bắt buộc:** API key chỉ tồn tại ở Node/env; không đưa vào prompt, tool result hay log. Kết quả web là dữ liệu không tin cậy, không phải instruction.
- **Quota:** giới hạn theo turn và theo ngày; timeout; cache cùng query trong TTL. Vượt quota hoặc lỗi cấu hình phải trả `isError: true` với mã ổn định, không trả danh sách rỗng giả.
- **Authorization:** tool chỉ được expose cho role được human chốt, đi qua `authorizeTool` và `authorizeOwnerTool`; capability phải xuất hiện trong `definitions`.
- **Context budget:** giới hạn số result, độ dài snippet và tổng output; phase đầu không đọc full page.
- **Compatibility:** giữ `webSearchMode: "disabled"`, `networkAccessEnabled: false` và danh sách built-in bị chặn; chỉ thêm Node-owned MCP capability.
- **Hướng đề xuất:** tạo service/provider adapter nhận dependency qua constructor; tạo tool module; wire vào `owner-conversation-tools.js`, policy, config và stream prompt. SL được điều chỉnh tên file/chi tiết delivery trong các guardrails này.

### Dependency thật sự

- Human phải chốt provider, key và ngân sách/quota trước khi bật provider thật.
- Human phải chốt phase đầu chỉ `web_search` và role nào được dùng.
- Production wiring phải truyền service/config vào owner SDK; chưa có dependency injection thì chỉ được test mock.

### Quyết định chưa chốt

- Google Custom Search JSON API hay provider khác làm adapter mặc định.
- Chỉ owner `system_engineer` hay thêm architecture manager/Coder/Reviewer.
- Kết quả chỉ nằm trong tool response/log đã redact hay cần persistence riêng.

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần | Vai trò | Evidence / mức chắc chắn |
|---|---|---|
| `docs/forge-mcp-tools-spec.md` | Quy tắc MCP, lỗi `isError`, built-in web bị chặn | Đã đọc toàn văn; sha256 `a0d3b2fa38b3f8446a0b92b82e04c8d0ab489f7d18e42cae000eff005b0f9042` — cao |
| `docs/Nodeforge — Context Access & Agent Tool Architecture.md` | Controlled capability và Context Budget | Đã đọc 250/639 dòng, tới heading §8 (thân §8 bị cắt do giới hạn đọc); sha256 `08a618e8a4a71219f627c0cd78d3d36073960861fda6a43dc2749b8dceb81395` — trung bình–cao |
| `backend/src/tools/owner-conversation-tools.js` | Ghép definitions/implementations, capabilities, log tool call | Đã đọc 80/108 dòng; sha256 `7128b1972bbcc61867c3e170768dd73ad2e868aa21ed26d4df0451d5ef1a8cf1` — cao |
| `backend/src/tools/owner-role-tool-policy.js` | Role allowlist và authorization | Đã đọc toàn văn; sha256 `cc5782c8daea1eb8d81478fa964538520eb06d7a3dbe8227f93e728502aa1a3a` — cao |
| `backend/src/tools/tool-authorization.js` | Gate capability/task scope | Đã đọc toàn văn; sha256 `d4258de6f249988dfa9ea1a2fea34e60b61594a079438b2d450a5b7ecbb73c1c` — cao |
| `backend/src/bootstrap/config.js`, `config/env.example` | Nơi thêm config/env | Đã đọc; sha256 lần lượt `6bd3be924804f30eb1532489d05f203d0a75fda3a36535978ede0115591d6034`, `225968658b023b1611cbc5cb31e61789c414e368a69e65c1e313495265de89d3` — cao |
| `backend/src/application/owner-sdk-stream.js` | Route owner SDK, definitions và built-in network guardrail | Đã đọc toàn văn; sha256 `dbb8368748420648866e4b3c14c57781c754d4d8535f8958ea8b4e14858ec192` — cao |

Candidate files chỉ định hướng discovery; SL xác minh manifest thực tế, không phải allowlist mutable cố định.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
|---|---|---|---|
| O1 | Agent gọi được web search qua Forge | Mock provider trả `results[]` có đủ field; tool xuất hiện trong definitions/capabilities đúng role; unit test pass. | Provider và role đã chốt; authorization bắt buộc |
| O2 | Node chặn chi phí/lạm dụng | Turn/day quota, timeout và TTL cache được test; vượt ngưỡng trả lỗi ổn định; provider chỉ bị gọi đúng số lần. | O1; quota bắt buộc |
| O3 | Secret và context được bảo vệ | API key không xuất hiện trong result/log; HTML/script bị loại; số result/snippet/output bị giới hạn; không có full page. | O1; Context Budget |
| O4 | Agent hiểu đúng boundary | Prompt phân biệt repo search với web search; kết quả web được đánh dấu là dữ liệu tham khảo, không instruction. | O1; prompt-injection guardrail |
| O5 | Cấu hình thiếu thì fail-closed | Thiếu provider/key trả mã `WEB_SEARCH_UNCONFIGURED`; env example/spec cập nhật; built-in web vẫn disabled. | O1; không trả rỗng giả |

**Gợi ý delivery (không bắt buộc):** mock contract/config trước; sau đó quota/cache, redaction/sanitize; provider thật chỉ sau human chốt key/ngân sách. `web_fetch` là phase riêng.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / xử lý |
|---|---|---|
| API phát sinh chi phí ngoài dự kiến | Major | Chưa có env search/budget; bắt buộc quota và human chốt ngân sách trước production. |
| Prompt injection hoặc nguồn web sai | Major | Kết quả không tin cậy; sanitize, đánh dấu dữ liệu và Reviewer đối chiếu repo. |
| Rò rỉ key qua log/result | Major | Owner logger gọi `summarizeResult`; phải kiểm thử allowlist/redaction trước bật. |
| Chọn provider/role chưa rõ | Major | Human quyết; abstraction giữ contract ổn định. |
| `web_fetch` mở rộng SSRF/redirect risk | Minor trong phase đầu | Không làm phase đầu; cần plan/approval riêng. |

## 7. Acceptance criteria của plan

- [ ] Mục tiêu, in/out scope và O1–O5 nhất quán với yêu cầu.
- [ ] Facts repository-specific có evidence; assumptions/open questions tách rõ.
- [ ] Secret, quota, Context Budget, injection và built-in guardrails được khóa ở cấp outcome.
- [ ] Không áp đặt số ticket, tên ticket hoặc mutable-file manifest; SL tự lập SP sau approval.
- [ ] Human review phải chốt provider/key/ngân sách, phase và role trước provider thật.
- [ ] Plan này chưa được approve, chưa RUN và chưa dispatch agent.
