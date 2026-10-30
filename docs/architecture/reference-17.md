<!-- Preserves original architecture reference lines 2912–3098 in their original order so repository documentation remains navigable in bounded files without losing historical design detail. -->
## 66.5. `rules/forge-sprint-delivery.rules.json` — giữ nguyên tắc, viết lại field artifact

Baseline có sẵn từ đầu (nhắc trong `README.md` schemas: *"Ruleset mặc định nằm tại
`rules/forge-sprint-delivery.rules.json`"*) chứa 8 rule (`WF-001`→`WF-008`), nguồn gốc từ
`CONSTITUTION.md` + `WORKFLOW.md` (dự án Forge thất bại trước đây, xem mục 66 đầu trang).

**Quyết định:** khác với toàn bộ cấu trúc `sprints/<id>/commits/<id>/...` (đã loại bỏ hoàn
toàn, xem cảnh báo đầu mục 66) — 8 rule này **giữ lại về mặt nguyên tắc quản trị**, vì bản
thân nguyên tắc không sai:

- WF-001: chỉ Commit kế tiếp hợp lệ (theo dependency) mới được tạo/giao Builder.
- WF-002: chuyển trạng thái Commit chỉ hợp lệ đúng actor + đủ artifact bàn giao.
- WF-003: Builder chỉ được bàn giao khi có đủ bằng chứng implementation.
- WF-004: Reviewer độc lập, không được sửa code đang review.
- WF-005: file thay đổi phải nằm trong allowlist của Commit đang active.
- WF-006: Approval chỉ do Reviewer, bắt buộc có bằng chứng test đã pass.
- WF-007: bằng chứng test phải nêu rõ scope/outcome/command/kết quả; thay đổi lớn cần full suite.
- WF-008: đổi scope/architecture/API/dependency/acceptance-criteria cần Project Owner duyệt.

**Nhưng field tham chiếu artifact trong `condition` đang hard-code tên file của workflow đã
thất bại** (`status.json`, `COMMIT.md`, `builder-report.md`, `review.md`,
`status.json.allowed_change_areas`, `status.json.reviewed_at`, `status.json.findings`,
`status.json.tests`) — Nodeforge **không tạo ra bất kỳ file nào trong số này**. Nếu giữ
nguyên xi, Rule Engine (Sprint 5) sẽ enforce `blocking` trên điều kiện không bao giờ thoả
mãn được, chặn cứng mọi Commit ngay từ ticket đầu tiên.

**Việc cần làm ở Sprint 5, TRƯỚC khi Rule Engine kích hoạt ruleset này** (chưa phải ticket
ngay bây giờ — Sprint 5 chưa bắt đầu, ghi lại để không quên khi tới lượt): viết lại từng
field artifact trong 8 `condition` để trỏ đúng cơ chế Nodeforge thật đang dùng, ví dụ:

| Field cũ (sai) | Cần map lại thành (ví dụ, chốt chính thức khi code Sprint 5) |
|---|---|
| `"status.json"`, `"COMMIT.md"` | Task/Commit record trong `project/task.schema.json` (đã có `status`/`workflow_state`/`commit_id`) |
| `"builder-report.md"`, `"review.md"` | Nội dung báo cáo — hiện là chat/text, cần quyết định: lưu qua History (Sprint 7) hay field riêng trong `verification-result`/`review-result` đã có |
| `"status.json.allowed_change_areas"` | `roadmap/commit.schema.json.allowed_change_areas` (đã có sẵn, NF-033) |
| `"status.json.reviewed_at"`, `.findings`, `.tests` | `results/review-result.schema.json` + `verification/verification-result.schema.json` (đã có, NF-030 + baseline) |

Không tự ý viết lại 8 field này bây giờ (Rule Engine chưa tồn tại để test) — chỉ ghi nhận
tường minh để Sprint 5 xử lý đúng lúc, tránh quên và vô tình kích hoạt ruleset sai.

---

## 66.6. Sprint Lead là Agent spawn qua Agent Protocol — không phải role thụ động

Làm rõ: **Sprint Lead nhận nhiệm vụ từ Node, trả kết quả về cho Node điều phối tiếp tới
Builder/Reviewer** — cùng cơ chế NDJSON stdin/stdout qua Agent Protocol (NF-048) như
Builder/Reviewer, không phải vai trò "đứng ngoài" chỉ đọc tài liệu. Hệ quả:

- `agent-manifest.schema.json` (NF-058) áp dụng cho **Builder, Reviewer, và Sprint Lead** —
  cả 3 đều spawn process thật.
- **Chưa chốt:** Architecture Manager có spawn qua Agent Protocol giống 3 role trên hay
  không, hay hoạt động theo cơ chế khác (vd. 1 gate/specialist function bên trong Node, không
  phải process riêng). Cần quyết định trước khi NF-058 code xong phần Architecture Manager.
- Chỉ **Project Owner** chắc chắn không spawn process (con người, final authority) — dùng
  `role.schema.json` (NF-057) là đủ, không cần manifest.

## 66.7. Enforcement là reactive (chặn tiến độ), KHÔNG phải preventive (chặn hành động)

Trả lời câu hỏi "làm sao ngăn Agent tự do làm ngoài vai trò": kiến trúc hiện tại **không**
chặn Agent ghi file ngoài phạm vi ngay lúc xảy ra — đúng nguyên tắc đã ghi từ đầu
(*"Agent không bị Node khóa filesystem. Node chỉ quan sát và điều phối"*, kết luận cuối
`ARCHITECTURE.md`; mục 3/4/52 — Agent ghi trực tiếp, không qua `WRITE_FILE` API của Node).
**Xác nhận từ Project Owner:** giữ nguyên nguyên tắc này — không đổi sang sandbox OS-level.

Cơ chế guardrail thật sự là **reactive**, chặn ở tầng *tiến độ workflow* chứ không chặn ở
tầng *hành động*:
- Context Firewall (Sprint 5) — giảm khả năng lạc đề bằng cách không cho Agent thấy thứ
  ngoài phạm vi, không phải chặn ghi.
- `allowed_change_areas` + `WF-005` (đã có schema, Rule Engine đọc ở Sprint 5) — đối chiếu
  diff **sau khi** Agent đã ghi.
- Workflow gate (Reviewer duyệt, `WF-004`) — Commit không tiến được sang `APPROVED` nếu vi
  phạm, không phải ngăn hành động vi phạm xảy ra.
- **Kết quả/đánh giá giữa các Agent bắt buộc đi qua Node** (mục 66.8) — Builder ghi code
  trực tiếp (không đổi), nhưng Reviewer đọc code rồi trả **verdict qua Node** (Event có cấu
  trúc, `results/review-result.schema.json`), không viết file trung gian (`review.md` kiểu
  cũ) cho Agent khác đọc. Loại bỏ hẳn kênh giao tiếp Agent↔Agent ngoài Node.

## 66.8. Kết quả luôn qua Node; vòng lặp Node ↔ Sprint Leader ↔ Builder/Reviewer

**Nguyên tắc routing kết quả (xác nhận từ Project Owner):** Agent không còn giao tiếp trực
tiếp với nhau qua file trung gian (đúng lý do khiến workflow cũ thất bại — `COMMIT.md`/
`status.json`/`builder-report.md`/`review.md` là kênh Agent↔Agent ngoài tầm kiểm soát Node).
Builder ghi **code** trực tiếp (sản phẩm thật, không đổi). Mọi **kết quả/đánh giá** (review
verdict, tiến độ, findings) đi qua Node dưới dạng Command/Event có cấu trúc (Agent Protocol,
NF-048), validate được, Node lưu/điều phối tiếp — không có file "handoff" nào giữa 2 Agent.

**Vòng lặp Sprint Leader — Node tự động yêu cầu Sprint mới khi Sprint hiện tại hoàn tất:**

```
Node (theo dõi tiến độ Sprint hiện tại qua Task/Commit status)
   │  Sprint hoàn tất
   ▼
Node → Sprint Leader (Agent, spawn qua Agent Protocol giống Builder/Reviewer — mục 66.6)
   │  Command: "lập kế hoạch Sprint tiếp theo"
   ▼
Sprint Leader → Node
   │  Event: payload khớp roadmap/sprint.schema.json + commit.schema.json
   │  (ĐÃ CÓ SẴN từ Sprint 0 — NF-033–035, không cần schema mới)
   ▼
Node dispatch Commit đầu tiên của Sprint mới cho Builder → lặp lại chu trình
```

**Việc cần làm khi tới Sprint 6 (Workflow Engine) — ghi nhận, không code ngay:** thêm đúng 1
cặp Command/Event mới vào vocabulary Agent Protocol (mục 40, 12 verb hiện có chưa có verb
nào cho việc này) cho hành động "yêu cầu lập Sprint mới" / "trả về kế hoạch Sprint mới" —
chốt tên theo đúng quy trình đã dùng ở NF-047b (tên chốt trước khi code, domain nối tiếp
`sprints.*`/`roadmap.*` đã có, không phát minh casing mới).

**Việc cần sửa ngay ở Sprint 3 (NF-054 vẫn đang Backlog, chưa Done):** integration test hiện
tại chỉ test luồng kiểu Builder ("ghi file thật"). Cần bổ sung luồng kiểu Reviewer (đọc file,
trả verdict qua Node, KHÔNG viết file trung gian) trước khi coi NF-054 hoàn chỉnh — xem cập
nhật ticket bên dưới.

---

# Plan: Giao diện trò chuyện lấy cảm hứng từ Claude Desktop

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** Trang hiện tại có nhiều vùng điều khiển và dashboard; người dùng muốn trải nghiệm tập trung vào hội thoại như Claude Desktop.
- **Kết quả:** UI có sidebar cuộc trò chuyện, vùng chat trung tâm, composer phía dưới, chuyển đổi hội thoại nhanh và bố cục responsive; các luồng NodeForge hiện có vẫn hoạt động.
- **Giá trị:** Giảm nhiễu thị giác và làm thao tác chat trở thành luồng chính mà không phá vỡ governance, stream hoặc phạm vi project.

## 2. Phạm vi

### In scope

- Tái cấu trúc presentation của canonical Next.js route `/` theo mô hình sidebar–chat–composer.
- Giữ danh sách hội thoại, tạo/chọn hội thoại, lịch sử phân trang, optimistic send, retry và SSE correlation.
- Thiết kế visual tương đồng về bố cục và cảm giác sử dụng; không sao chép logo, tài sản độc quyền hoặc nhận diện thương hiệu Claude.
- Responsive desktop/tablet/mobile, trạng thái rỗng, loading, lỗi, đang stream và accessibility cơ bản.

### Out of scope

- Thay đổi backend conversation API, SSE protocol, schema, authentication hoặc persistence.
- Xóa nhánh legacy `NodeForgeApp`/`NodeForgeShell` khi chưa có migration evidence.
- Xây dựng tính năng desktop-native, MCP mới, model routing mới hoặc thay đổi governance.

## 3. Hướng tiếp cận và guardrails

- **Ràng buộc bắt buộc:** `/` và các API hiện có là contract; state phải tiếp tục scoped theo `PROJECT_ID` và conversation; event cũ không được nhập vào hội thoại mới.
- **Hướng đề xuất:** Tiến hóa `HomePage` và các component/sidebar/composer canonical hiện có; ưu tiên CSS tokens, layout grid/flex và component boundaries nhỏ thay vì viết lại state orchestration. Dashboard/process surfaces chuyển thành secondary/contextual surfaces, không bị xóa dữ liệu.
- **Dependency thật sự:** Cần xác nhận visual reference/brand guardrails và ưu tiên giữ hay ẩn dashboard trong màn hình chính trước khi chốt delivery. Cần smoke test trên desktop, tablet và mobile.
- **Quyết định chưa chốt:** Owner xác nhận mức độ giống mong muốn (bố cục lấy cảm hứng hay pixel-level) và các control nào luôn hiển thị trong header/sidebar; phần visual fidelity bị block nếu chưa chốt.

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `ui/nextjs/app/page.jsx` | Canonical route, conversation state, stream và composition | Đã đọc; route `/` và các contract hành vi được ghi trong `ui/nextjs/README.md` |
| `ui/nextjs/components/conversation-sidebar.jsx` | Sidebar responsive, collapse và navigation | Đã đọc; đang được import bởi `page.jsx` |
| `ui/nextjs/components/ConversationsAccordion.jsx` | Danh sách/tạo/chọn hội thoại | README xác nhận là active import; cần đọc chi tiết khi lập SP |
| `ui/nextjs/components/home-chat-composer.jsx` | Composer của canonical chat | README xác nhận là active import; cần đọc chi tiết khi lập SP |
| `ui/nextjs/app/styles/home-workspace.css`, `conversations.css`, `responsive-workspace.css` | Layout và responsive visual layer | README xác nhận là stylesheet canonical; cần audit selectors trước sửa |
| `ui/nextjs/app/NodeForgeApp.jsx`, `components/NodeForgeShell.jsx` | Legacy dormant path | Đã đọc; không phải target canonical route, không đổi trong scope này |

Candidate files chỉ định hướng discovery, không phải mutable-file allowlist cố định.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Bố cục hội thoại kiểu Claude-inspired | Desktop hiển thị sidebar hội thoại bên trái, chat trung tâm và composer ở cuối; vùng phụ không lấn át chat | Không đổi API/state contract |
| O2 | Điều hướng hội thoại không mất ngữ cảnh | Chọn/tạo hội thoại tải đúng history; stream cũ bị loại; optimistic send và retry vẫn hoạt động | Giữ correlation và project scope |
| O3 | Trải nghiệm responsive/accessibility | Sidebar có thể mở/đóng trên mobile; keyboard focus/labels rõ; không overflow ngang ở các breakpoint đã định | Dùng cơ chế responsive hiện có |
| O4 | Phạm vi NodeForge được bảo toàn | Agent selector, trạng thái stream, lỗi, approval và các secondary actions vẫn truy cập được theo thiết kế đã chốt | Không sửa backend/governance |

**Gợi ý delivery (không bắt buộc):** Audit active route trước; làm layout/sidebar/composer presentation; sau đó visual states và responsive smoke test. Có thể chạy song song audit CSS và kiểm tra behavior miễn không cùng sửa contract state.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| Yêu cầu “giống y hệt” chưa có screenshot/version reference | Major | Mô tả hiện chỉ nêu sidebar/chat/composer; không có pixel reference | Human owner chốt reference và mức fidelity |
| CSS canonical còn compatibility/legacy selectors | Major | `ui/nextjs/README.md` ghi migration CSS chưa hoàn tất | SL audit import/selector trước manifest |
| Legacy shell có cấu trúc tương tự nhưng không phải active route | Minor | README và code graph xác nhận dormant edge | Không sửa ngoài scope; chỉ migrate nếu evidence mới |
| Visual change có thể làm dashboard khó tìm | Major | Dashboard đang được HomePage render trong workspace | Owner chốt secondary navigation/placement trước acceptance |

## 7. Acceptance criteria của plan

- [ ] Mục tiêu, in/out scope và outcomes nhất quán với yêu cầu đã duyệt.
- [ ] Facts repository-specific có evidence; assumptions/open questions được ghi rõ.
- [ ] Giữ nguyên conversation, optimistic send, retry, stream correlation và project scope.
- [ ] Không khóa số ticket hoặc mutable-file manifest; SL được lập SP trong các guardrails trên.
- [ ] Pixel-level fidelity chỉ được cam kết sau khi có reference cụ thể.
- [ ] Approval identity được đối chiếu theo contract runtime; plan này không tự RUN/dispatch.
