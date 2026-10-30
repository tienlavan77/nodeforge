# Sprint 6 — "Anvil-Chorus" (Workflow Engine)


> Tên mã: **Anvil-Chorus** — nhiều tiếng búa (Builder/Reviewer/Sprint Leader) gõ theo đúng
> nhịp 1 bản nhạc chung (state machine), không tự ý gõ lệch nhịp. Tài liệu tham khảo:
> `ARCHITECTURE.md` mục 51 (flow Builder→Test→Reviewer), mục 55 (source of truth), mục
> 63.1–63.2 (Commit↔Task, PLAN/STATE), mục 66.1/66.5/66.7/66.8 (quyết định đã chốt khi đối
> chiếu `FORGE_WORKFLOW_v2.md`).

**Mục tiêu:** đồ thị trạng thái cho Task/Commit — Node kiểm tra rule (Sprint 5) + transition
hợp lệ trước khi ghi state, không hard-code control flow bằng if/else (STRUCTURE.md
"Boundaries": `rules/`+`workflows/` là data validate theo schema, không phải logic cứng).

> **3 quyết định đã chốt từ trước, bắt buộc tuân theo — không tự ý làm khác:**
> 1. **`status.json` = `.forge/runtime/state.json`** (mục 66.1) — không tạo file mới, dùng
>    đúng file đã build ở Sprint 2. Bảng nháp cũ còn ghi "trước khi ghi `status.json`" — đã
>    sửa thành `state.json` trong bảng dưới.
> 2. **`rules/forge-sprint-delivery.rules.json` cần vá trước khi engine đọc nó** (mục 66.5,
>    ticket NF-059 — Sprint 0 mở lại lần 2, có thể đang chạy song song) — 4/8 rule
>    (`WF-002/003/005/006`) hard-code artifact sai (`status.json`/`COMMIT.md`/
>    `builder-report.md`/`review.md` kiểu cũ). **Không code Workflow Engine đọc ruleset này
>    trước khi xác nhận NF-059 đã Done** — nếu chưa, Workflow Engine sẽ tự khoá cứng mọi
>    Commit ngay từ đầu.
> 3. **Kết quả luôn qua Node, không có kênh Agent↔Agent/Agent↔Owner trực tiếp** (mục 66.7–66.8)
>    — Reviewer trả verdict qua Event có cấu trúc (`review-result`), không viết file trung
>    gian. Owner Gate (`WF-008`) là nơi Workflow Engine tạm dừng transition, chờ quyết định
>    Project Owner đi qua Node → Transport (Sprint 8) → người, không tự mở kênh riêng.

### Bảng phụ thuộc trong-sprint

```
NF-059 (vá rules/forge-sprint-delivery.rules.json — CHẶN, phải Done trước)
Sprint 5 (Rule Engine — CHẶN, phải tồn tại để đọc ruleset)
Sprint 3 (Agent Protocol — Done, tái dùng cho Reviewer verdict + Sprint Leader loop)
   │
   ├─▶ NF-070 (review baseline workflow.schema.json + workflows/forge-sprint-delivery.workflow.json)
   │        │
   │        ▼
   │      NF-071 (State-machine executor core: đọc workflow.states tự do, không hard-code)
   │        │
   │        ├─▶ NF-072 (Transition gate: check rule trước khi ghi state.json)
   │        ├─▶ NF-073 (Flow Builder→Test→Reviewer, theo mục 51)
   │        ├─▶ NF-074 (Owner Gate: WF-008, tạm dừng chờ Project Owner)
   │        └─▶ NF-075 (Node↔Sprint Leader loop: yêu cầu Sprint mới khi hoàn tất, mục 66.8)
   │                 │
   │                 ▼
   │       NF-072+063+064+065 hội tụ ──▶ NF-076 (integration test: 1 task chạy hết vòng thật)
   │                                                │
   └────────────────────────────────────────────────▼
                                              NF-077 (exit check tổng hợp)
```

### Backlog

| ID | Ticket | Thư mục | Phụ thuộc | Est. | Acceptance criteria | Trạng thái |
|---|---|---|---|---|---|---|
| NF-070 | Review baseline `project/workflow.schema.json` (đã có, xác nhận `states` là mảng string tự do — không hard-code enum trạng thái) + `workflows/forge-sprint-delivery.workflow.json` (đồ thị trạng thái mặc định, README nhắc tới nhưng chưa từng được đọc kỹ trong hội thoại này). Không sửa nếu đã đúng, chỉ báo cáo gap | `schemas/project/`, `workflows/` (review only) | NF-013-CLOSE | S | Báo cáo dứt khoát: đồ thị trạng thái trong file có khớp flow mục 51 (`PLANNED→IN_PROGRESS→READY_FOR_REVIEW→REVIEWING→APPROVED/BLOCKED`, tên state có thể khác nhưng ý nghĩa phải đủ) không; nếu thiếu state/transition nào, liệt kê path:line cụ thể | Chưa bắt đầu |
| NF-071 | State-machine executor core (`src/modules/workflows/`): đọc `workflow.states` (tự do theo từng workflow), thực thi transition — **không** hard-code if/else theo tên state cụ thể nào (đúng nguyên tắc STRUCTURE.md) | `src/modules/workflows/` | NF-070 | L | Nạp `workflows/forge-sprint-delivery.workflow.json` → executor chạy đúng theo state graph trong file, không có logic gắn cứng tên state trong code; đổi tên 1 state trong file → executor vẫn chạy đúng không cần sửa code | Chưa bắt đầu |
| NF-072 | Transition gate: trước khi ghi `state.json` (đúng tên đã chốt mục 66.1, KHÔNG phải `status.json`), kiểm tra qua Rule Engine (Sprint 5) — actor được phép chuyển trạng thái, artifact bắt buộc, dependency gate, allowlist thay đổi, bằng chứng test (đúng `WF-001`→`007` sau khi NF-059 vá xong) | `src/modules/workflows/` | NF-071, NF-059 (Done — ruleset đã vá), Sprint 5 (Rule Engine tồn tại) | M | Transition vi phạm rule (vd. Reviewer thử tự chuyển sang `APPROVED` không qua đủ điều kiện `WF-006`) → bị chặn, `state.json` không đổi; transition hợp lệ → ghi đúng | Chưa bắt đầu |
| NF-073 | Flow Builder→Test→Reviewer (mục 51): Task → Builder code → Node Watcher (Sprint 1) → Node Test Runner (Sprint 4) → FAIL quay lại Builder / PASS → Reviewer → APPROVE hoặc CHANGES quay lại Builder. Reviewer trả verdict qua Event có cấu trúc (`results/review-result.schema.json`, đã có) — **không viết file trung gian** (đúng mục 66.7–66.8) | `src/modules/workflows/` | NF-071, Sprint 3 (Agent Protocol, Done), Sprint 4 (Verification, chưa bắt đầu — có thể cần chờ) | L | Task giả lập chạy hết vòng: Builder ghi file lỗi → Test FAIL → quay lại Builder; Builder sửa đúng → Test PASS → Reviewer nhận diff → CHANGES 1 lần → Builder sửa → APPROVE; xác nhận không có file `review.md`/tương đương nào được tạo trong suốt quá trình | Chưa bắt đầu |
| NF-074 | Owner Gate (`WF-008`, mục 66.8): phát hiện thay đổi thuộc nhóm cần Project Owner duyệt (scope/architecture/API/dependency/acceptance-criteria) → **tạm dừng** transition, phát Event yêu cầu quyết định, chờ phản hồi qua Node (kênh Transport thật là Sprint 8 — Sprint 6 chỉ cần cơ chế tạm dừng + chờ, không tự dựng UI) | `src/modules/workflows/` | NF-072 | M | Transition thuộc 5 nhóm `WF-008` → workflow dừng ở trạng thái chờ, không tự tiến; giả lập Node nhận phản hồi (mock, vì Transport chưa có) → workflow tiếp tục đúng | Chưa bắt đầu |
| NF-075 | Node↔Sprint Leader loop (mục 66.8): thêm đúng 1 cặp Command/Event mới vào Agent Protocol vocabulary (domain nối tiếp `sprints.*`, tên chốt trước khi code — đúng quy trình NF-047b) cho "yêu cầu lập Sprint mới"/"trả kế hoạch Sprint mới". Payload Event validate qua `roadmap/sprint.schema.json`+`commit.schema.json` đã có (NF-033–035, không tạo schema mới) | `src/modules/agents/`, `src/modules/workflows/` | NF-071, Sprint 3 (Agent Protocol, Done) | M | Sprint hiện tại đạt trạng thái hoàn tất → Node tự phát Command yêu cầu Sprint Leader (fixture) → nhận Event có payload đúng shape `sprint.schema.json` → validate pass | Chưa bắt đầu |
| NF-076 | Integration test: 1 task chạy hết vòng thật qua Workflow Engine (exit criteria gốc) | `tests/integration/` | NF-072, NF-073, NF-074, NF-075 | M | Task thật → Builder → Test → Reviewer → Approve, mọi transition đều qua rule check trước khi ghi `state.json`, đo được, không mock tầng nào ngoài Agent fixture | Chưa bắt đầu |
| NF-077 | Exit check Sprint 6: tổng hợp toàn bộ | Tất cả trên | — | S | `npm test` xanh 100%, lint/typecheck/`validate:schemas`/`git diff --check` đều xanh — đúng format Gate đã dùng từ Sprint 0; rà soát rủi ro mang từ Sprint 1-5 còn hiệu lực không | Chưa bắt đầu |

**Ước tính:** S=nhỏ, M=vừa, L=lớn.

### Rủi ro cần lưu ý

| Rủi ro | Ảnh hưởng | Hướng xử lý đề xuất |
|---|---|---|
| NF-072 code trước khi xác nhận NF-059 (vá ruleset) đã Done thật | Workflow Engine tự khoá cứng mọi Commit ngay từ ticket đầu tiên (đúng rủi ro đã cảnh báo ở mục 66.5) | Bắt buộc kiểm tra trạng thái NF-059 trước khi giao NF-072, không giả định |
| NF-073 phụ thuộc Sprint 4 (Verification) chưa bắt đầu | Không có Test Runner thật để chạy flow PASS/FAIL | Cân nhắc thứ tự: có thể cần làm Sprint 4 trước hoặc song song, không phải tuần tự cứng 4→5→6 như số thứ tự gợi ý |
| NF-074 (Owner Gate) cần "chờ phản hồi" nhưng Transport (Sprint 8) chưa có kênh UI thật | Chỉ test được bằng mock, chưa xác nhận hành vi thật khi có người dùng thật ở đầu kia | Chấp nhận ở Sprint 6, ghi rõ giới hạn — test thật với UI để dành Sprint 8 |
| NF-075 thêm Command/Event mới — nếu đặt tên tuỳ tiện, lặp lỗi đã sửa ở NF-047b | Domain/casing không nhất quán, phải sửa lại sau | Chốt tên trước khi code, theo đúng domain đã có (`sprints.*`), không tự đặt |
| State-machine executor (NF-071) bị hard-code ngầm theo tên state cụ thể dù không cố ý | Vi phạm nguyên tắc STRUCTURE.md, đổi workflow file không hoạt động đúng | Test bắt buộc: đổi tên state trong file rồi chạy lại, không sửa code, vẫn phải đúng |

### Exit criteria

- [ ] NF-076: 1 task chạy hết vòng Builder → Test → Reviewer → Approve qua workflow thật
- [ ] Mọi transition được kiểm tra rule trước khi ghi `state.json` (không phải `status.json`)
- [ ] NF-077 tổng hợp: toàn bộ gate xanh

---

