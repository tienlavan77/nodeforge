<!-- Tài liệu tóm tắt thảo luận thiết kế luồng Architecture Plan JSON-first từ nguồn Markdown tới Sprint Plan. -->
# Thảo luận: Luồng Architecture Plan JSON-first (`.md` → AM `.json` → SL Sprint Plan `.json`)

Tài liệu ghi lại quyết định thiết kế theo luồng owner đã chốt. Đây là tài liệu thảo luận/summary, **không** phải plan đã duyệt và **không** tạo quyền RUN/dispatch.

## 1. Mục tiêu

- **Vấn đề:** Hiện tại khi chạy `/plan`, AM xuất Markdown tự do rồi Node và SL dùng regex bóc tách (`owner-chat-command-service.js`, `markdown-sprint-scope.js`); chỉ lệch một dấu `|`, thiếu heading hoặc khác ngôn ngữ là fail ở `ARCHITECTURE_PLAN_INVALID`, `DISCOVERY_INCOMPLETE`, `SPRINT_MARKDOWN_SCOPE`.
- **Kết quả:** Giữ đầu vào `/plan` là file `.md` tại `workflows/`; AM đọc `.md` và xuất plan `.json` chuẩn schema vào `.forge/runtime/nf/plans/`; sang bước Coding, SL đọc thẳng file `.json` đó để tạo Sprint Plan vào `.forge/runtime/nf/sprint-plan/`.
- **Giá trị:** Không phải sửa thói quen viết summary `.md` ở `workflows/`, nhưng loại bỏ hoàn toàn lỗi regex/parse bảng Markdown giữa AM, Node và SL.

## 2. Phạm vi

### In scope

- Chuẩn hóa luồng 3 chặng: nguồn thảo luận `.md` (`workflows/`) → Architecture Plan `.json` (`.forge/runtime/nf/plans/`) → Sprint Plan `.json` (`.forge/runtime/nf/sprint-plan/`).
- JSON Schema (Ajv) cho Architecture Plan (outcomes, guardrails, affected areas, evidence, risks/assumptions).
- Cập nhật tầng lưu trữ/handoff để Node lưu bản `.json` của AM và SL đọc trực tiếp bản `.json` đã approve khi tạo Sprint Plan.
- Giữ khả năng render/hiển thị Markdown deterministic từ JSON (nếu UI `/approve` hoặc gate hiện hữu cần đọc).

### Out of scope

- Không đổi quy tắc phân quyền AM vs SL trong `workflows/agents/architecture/README.md` (AM chốt outcomes/guardrails, SL tự phân rã tickets).
- Không tự thực thi code hoặc sửa `.forge/` trực tiếp từ phiên thảo luận của AM.

## 3. Quyết định Placement & Luồng dữ liệu (Decisions)

`statePath()` trong hệ thống trỏ về `.forge/runtime` [Evidence: backend/src/infrastructure/filesystem/forge-paths.js]. Luồng 3 bước cụ thể:

1. **Bước 1 — File thảo luận nguồn (`.md`):**
   - **Vị trí:** `workflows/<tên-file>.md` (ví dụ `workflows/plan-gate-architecture-json-first.md`).
   - **Căn cứ:** `architecture-planning-service.js:14` kiểm tra `sourcePath` khớp `/^[A-Za-z0-9_./-]+\.md$/i` [Evidence: backend/src/application/architecture-planning-service.js]. Giữ đầu vào là `.md` giúp tương thích ngay với lệnh `/plan <file.md>` hiện có.
   - **Ai tạo file `.md` này:** Do chính agent AM soạn nội dung và ghi vào `workflows/` khi owner yêu cầu trực tiếp qua chat. `/plan` **không** tạo ra file `.md` này; nó chỉ là bước **sau đó** đọc file `.md` đã có để sinh `.json`. (Ví dụ: file `workflows/plan-gate-architecture-json-first.md` bạn đang đọc chính là sản phẩm AM ghi theo yêu cầu chat, không phải do `/plan` xuất ra.)
2. **Bước 2 — Khi chạy `/plan workflows/<tên-file>.md` (AM tạo Architecture Plan `.json`):**
   - **Vị trí đích:** `.forge/runtime/nf/plans/<plan_id>/` (ví dụ `plan-r<revision>.json`, song song hoặc thay thế `ke-hoach-r<revision>.md`).
   - **Căn cứ hiện trạng:**
     - `architecture-planning-service.js:59-64` hiện yêu cầu AM trả Markdown rồi gọi `markdownPlanStore.createRevision` lưu `.forge/runtime/nf/plans/<plan_id>/ke-hoach-r<revision>.md` [Evidence: backend/src/modules/governance/markdown-plan-store.js].
     - `human-plan-store.js:10,44` cũng dùng gốc `statePath("nf/plans")` (`.forge/runtime/nf/plans/<planId>/<revision>.json`) [Evidence: backend/src/modules/governance/human-plan-store.js].
   - **Thay đổi cần làm:** Đổi prompt/validator ở `architecture-planning-service.js` + `architecture-plan-generation.js` để AM trả JSON khớp schema Ajv; Node lưu file `.json` vào `.forge/runtime/nf/plans/<plan_id>/` (và có thể render bản `.md` deterministic từ chính JSON đó để giữ tương thích UI `/approve`).
3. **Bước 3 — Sang Coding (SL tạo Sprint Plan `.json`):**
   - **Vị trí đích:** `.forge/runtime/nf/sprint-plan/<sprint_id>.json`.
   - **Căn cứ hiện trạng:**
     - Lúc handoff sang SL, `sprint-plan-draft-persistence.js:12-14` đang lấy `approvedMarkdown` từ `markdownPlanStore.assertApproved` và kiểm tra scope bằng `assertMarkdownSprintScope(approvedMarkdown.markdown, sprint)` [Evidence: backend/src/modules/governance/sprint-plan-draft-persistence.js] [Evidence: backend/src/modules/governance/markdown-sprint-scope.js].
     - `sprint-orchestration-service.js:203-207` có sẵn hàm `persistSprintPlanArtifact(plan, sprintPlanDirectory)` ghi `<sprintPlanDirectory>/<plan.id>.json` sau khi validate `schemas/governance/sprint-plan.schema.json` [Evidence: backend/src/application/sprint-orchestration-service.js] [Evidence: schemas/governance/sprint-plan.schema.json].
   - **Thay đổi cần làm:** SL nhận trực tiếp cấu trúc JSON từ `.forge/runtime/nf/plans/<plan_id>/`, đối chiếu coverage theo mảng `outcomes[]` trong JSON, và cố định `sprintPlanDirectory = statePath("nf/sprint-plan")` (tức `.forge/runtime/nf/sprint-plan`).

## 4. Mẫu JSON Architecture Plan (AM xuất ở Bước 2)

```json
{
  "title": "Nâng cấp gate Architecture Plan theo hướng JSON-first",
  "discovery_complete": true,
  "objective": {
    "problem": "AM xuất Markdown tự do làm Node và SL dễ lỗi khi parse bằng regex.",
    "outcome": "AM đọc .md ở workflows/ và xuất .json vào .forge/runtime/nf/plans/; SL đọc .json đó để sinh sprint plan vào .forge/runtime/nf/sprint-plan/.",
    "value": "Loại bỏ lỗi cú pháp bảng/heading, giữ nguyên luồng /plan <file.md>."
  },
  "in_scope": [
    "JSON Schema cho Architecture Plan",
    "Lưu JSON plan của AM vào .forge/runtime/nf/plans/",
    "SL đọc JSON plan để tạo Sprint Plan vào .forge/runtime/nf/sprint-plan/"
  ],
  "out_of_scope": [
    "Thay đổi phân quyền AM và SL trong README"
  ],
  "guardrails": {
    "mandatory_constraints": [
      "Giữ cơ chế human approval theo revision và SHA-256 trước khi SL chạy"
    ],
    "proposed_approach": [
      "Validate output của AM bằng Ajv rồi lưu JSON (kèm bản render Markdown nếu cần cho UI)"
    ],
    "true_dependencies": [
      "Chốt JSON Schema của Architecture Plan trước khi sửa persistence và handoff SL"
    ],
    "open_decisions": []
  },
  "affected_areas": [
    {
      "component": "architecture-planning-service & architecture-plan-generation",
      "role": "Nhận .md từ workflows/, gọi AM trả JSON và validate",
      "evidence_path": "backend/src/application/architecture-planning-service.js"
    },
    {
      "component": "markdown-plan-store / human-plan-store",
      "role": "Lưu trữ revision plan trong .forge/runtime/nf/plans/",
      "evidence_path": "backend/src/modules/governance/markdown-plan-store.js"
    },
    {
      "component": "sprint-plan-draft-persistence & sprint-orchestration-service",
      "role": "SL đọc plan JSON đã duyệt và ghi sprint plan vào .forge/runtime/nf/sprint-plan/",
      "evidence_path": "backend/src/application/sprint-orchestration-service.js"
    }
  ],
  "outcomes": [
    {
      "id": "O1",
      "outcome": "/plan <file.md> tạo và lưu Architecture Plan dạng JSON hợp lệ vào .forge/runtime/nf/plans/",
      "acceptance_criteria": [
        "Input vẫn là file .md hợp lệ",
        "Output của AM được validate bằng Ajv schema và lưu file .json kèm SHA-256 trong .forge/runtime/nf/plans/<plan_id>/"
      ],
      "guardrails": ["Không bỏ bước human approval"],
      "mandatory_dependencies": []
    },
    {
      "id": "O2",
      "outcome": "SL đọc file JSON từ .forge/runtime/nf/plans/ để tạo Sprint Plan vào .forge/runtime/nf/sprint-plan/",
      "acceptance_criteria": [
        "SL kiểm tra outcome coverage trực tiếp trên JSON plan đã approve",
        "Sprint Plan hợp lệ được ghi vào .forge/runtime/nf/sprint-plan/<sprint_id>.json"
      ],
      "guardrails": ["Giữ kiểm tra acyclic dependencies và file_budget > 0"],
      "mandatory_dependencies": ["O1"]
    }
  ],
  "risks_and_assumptions": [
    {
      "item": "UI trang Coding và lệnh /approve hiện đang đọc trường markdown từ markdownPlanStore",
      "impact": "Major",
      "kind": "assumption",
      "owner": "SL"
    }
  ]
}
```

## 5. Giả định, Rủi ro và Câu hỏi mở

- **Giả định (Assumption):** Trang Coding UI và `/approve` hiện dựa vào `markdown_plan_revisions` (`markdown-plan-store.js:45-71`) để hiển thị nội dung cho human duyệt [Evidence: backend/src/modules/governance/markdown-plan-store.js].
- **Rủi ro (Major):** Nếu bỏ hẳn file `.md` trong `.forge/runtime/nf/plans/<plan_id>/`, UI duyệt plan hoặc các gate cũ (`markdown-sprint-scope.js`) có thể bị gãy nếu chưa chuyển sang đọc `.json` đồng bộ.
  - **Cách xử lý đề xuất:** Từ file `.json` chuẩn của AM trong `.forge/runtime/nf/plans/<plan_id>/`, Node vừa lưu bản `.json` (để SL đọc trực tiếp) vừa tự render ra `ke-hoach-r<revision>.md` (để UI hiển thị cho owner `/approve` mà không lo lỗi cú pháp).
- **Rủi ro va chạm tên file trong `.forge/runtime/nf/plans/<plan_id>/`:** `human-plan-store.js:44` đang dùng `<planId>/<revision>.json` cho bản draft của SL [Evidence: backend/src/modules/governance/human-plan-store.js]. Cần đặt tên tách biệt cho file JSON của AM (ví dụ `ke-hoach-r<revision>.json` hoặc `architecture-r<revision>.json`) để không đè lên `<revision>.json` của `human-plan-store`.
- **Câu hỏi mở:**
  1. Trên UI `/approve`, owner muốn duyệt trên bản **render Markdown** từ JSON hay duyệt trực tiếp cấu trúc **JSON**? (Khuyến nghị: Node lưu gốc `.json` cho SL dùng, đồng thời tự render `.md` để đọc trên UI).
  2. Tên file JSON của AM trong `.forge/runtime/nf/plans/<plan_id>/` chốt là `ke-hoach-r<revision>.json` (đi cặp với `ke-hoach-r<revision>.md`) hay tên khác?
  3. **CHƯA CHỐT (xem mục 6):** nguồn input của plan có được phép lấy trực tiếp từ **thông điệp hội thoại** thay cho file `.md` trong `workflows/` hay không, và snapshot bất biến do Node ghi ở đâu?

## 6. Đề xuất mới của Owner: "Tóm tắt trong chat" chính là Plan (bỏ bước lưu file ở `workflows/`)

**Mong muốn của Owner:** Trong lúc trao đổi với AM, khi owner nói *"tổng hợp các chi tiết"* / *"tóm tắt phần đã trao đổi"*, AM lập tức tạo bản Markdown chuẩn khung `workflows/agents/architecture/README.md`, trình bày ngay trong khung hội thoại (đã lưu trong lịch sử conversation) và **đánh dấu rõ đó là Plan** để Owner, SE, SL cùng tham chiếu — từ đó **không cần** lưu file `.md` trung gian vào `workflows/` nữa.

### 6.1. Căn cứ hiện trạng trong codebase (Facts có Evidence)

Hiện tại, toàn bộ chuỗi tạo và duyệt plan đang khóa chặt vào cặp `(source_path, source_sha256)` trỏ tới một file `.md` trên đĩa:

1. **Cổng nhận lệnh `/plan`:** `PLAN_RE = /^\/plan\s+(\S+)\s*$/i` bắt buộc có tham số đường dẫn sau `/plan` [Evidence: backend/src/application/owner-chat-command-service.js#L8].
2. **Kiểm tra đường dẫn & đọc file nguồn:** `architecture-planning-service.js` kiểm tra `sourcePath` phải khớp `/^[A-Za-z0-9_./-]+\.md$/i` rồi gọi `fileService.readFile({ path: sourcePath })` [Evidence: backend/src/application/architecture-planning-service.js#L14-L16].
3. **Khóa tính toàn vẹn nguồn trong suốt phiên clarification & generate:** `sessions.source(session)` đọc lại `session.source_path` và đối chiếu `source_sha256` cả trước lẫn sau khi gọi AM để chống sửa file giữa chừng (`ARCHITECTURE_SOURCE_MISSING`, `ARCHITECTURE_SOURCE_CHANGED`) [Evidence: backend/src/application/architecture-clarification-store.js#L68-L74].
4. **Lưu trữ revision & snapshot nguồn:** `markdownPlanStore.createRevision` bắt buộc truyền `summaryPath` + `summarySha256`, đọc lại `summaryPath` để kiểm tra SHA-256 rồi mới gọi `sources.retain(...)` chép bản bất biến vào `.forge/runtime/nf/plans/<plan_id>/summary-r<revision>.md` và bản plan vào `ke-hoach-r<revision>.md` [Evidence: backend/src/modules/governance/markdown-plan-store.js#L22-L41] [Evidence: backend/src/modules/governance/markdown-plan-source.js#L15-L25].
5. **Ranh giới quyền của AM:** Theo `workflows/agents/architecture/README.md` (mục 1, 2.6, 6), `.forge/` là runtime state do Node quản lý (AM không được tự sửa), và một bản tóm tắt/plan do AM viết trong chat **chưa phải** là plan đã approve — vẫn phải qua cổng Node validate (`validateMarkdown` + `readMarkdownSprintScope`) và human `/approve` trước khi SL tạo Sprint Plan [Evidence: workflows/agents/architecture/README.md#L1-L45].

### 6.2. Thiết kế để đạt đúng trải nghiệm Owner muốn mà không phá cổng Governance

Ý tưởng của Owner hoàn toàn khả thi nếu tách bạch **"AM không phải lưu file vào `workflows/`"** với **"Node tự động snapshot tin nhắn Plan trong hội thoại vào `.forge/runtime/`"**:

1. **Khi Owner yêu cầu "tóm tắt / tổng hợp thành plan" trong chat:**
   - AM khảo sát repo (kèm `[Evidence: ...]`) và xuất ngay bản Markdown chuẩn 7 mục của `workflows/agents/architecture/README.md` (có `# Plan: ...`, `## 1.` → `## 7.`, bảng mục 5 chuẩn `| O1 |`, trạng thái `Repository discovery complete` và mục giả định/rủi ro) ngay trong khung chat, kèm khối đánh dấu (marker) hoặc cấu trúc JSON-first để UI/Node nhận diện đây là **Draft Plan trong hội thoại**.
   - AM **không cần** gọi công cụ ghi file vào `workflows/`.
2. **Cách Node đóng dấu & neo identity cho SE / SL tham chiếu:**
   - Khi Owner bấm nút "Tạo Plan từ bản tóm tắt này" (hoặc gõ `/plan` không tham số / `/plan-from-chat`), Node lấy nội dung message plan vừa chốt trong `conversationId`, tự ghi một **immutable source snapshot** vào `.forge/runtime/nf/plans/<plan_id>/summary-r<revision>.md` (hoặc tạo `source_path` ảo kiểu `conversation://<conversation_id>/<message_id>.md` được backing bởi snapshot trong `.forge/runtime/`).
   - Nếu bản trong chat của AM đã đạt chuẩn (hoặc được render từ JSON-first qua Ajv), Node chạy thẳng `validateMarkdown` (hoặc schema validator) và gọi `markdownPlanStore.createRevision` để cấp định danh chính thức: **`plan_id` + `revision` + `sha256`**, lưu tại `.forge/runtime/nf/plans/<plan_id>/ke-hoach-r<revision>.md` (và `.json`).
   - Node trả badge/thông báo ngay trên khung hội thoại: `Đã đóng dấu Plan <plan_id> (r<revision>, sha256:...) — trạng thái: awaiting_human_approval`.
3. **Cách Owner, SE và SL tham chiếu:**
   - **Owner:** Xem trực tiếp bản plan ngay trong luồng chat (hoặc bên tab Coding) và bấm `/approve <plan_id>`.
   - **SL (Sprint Leader):** Khi nhận handoff sau `/approve`, SL đọc bản plan đã khóa SHA-256 từ `.forge/runtime/nf/plans/<plan_id>/` (cùng `conversation_id` lưu trong bảng `markdown_plan_revisions`) — không cần bất kỳ file nào trong `workflows/` [Evidence: backend/src/modules/governance/markdown-plan-store.js#L39-L40].
   - **SE / Coder / Reviewer:** Tham chiếu qua `plan_id`/`revision` đã gắn vào Sprint Plan và `conversation_id` gốc.

### 6.3. So sánh với luồng cũ & kết hợp cùng JSON-first

| Khía cạnh | Luồng hiện tại | Luồng mới theo ý Owner (+ JSON-first) |
| --- | --- | --- |
| Nơi AM trình bày bản tổng hợp | Phải lưu thành file `.md` trong `workflows/` rồi bảo owner chạy `/plan workflows/...` | Trình bày **ngay trong khung chat** theo chuẩn `architecture/README.md`, đánh dấu là Plan |
| Thư mục `workflows/` | Bắt buộc dùng làm nơi chứa file nguồn cho `/plan` | **Không cần lưu file nguồn vào `workflows/` nữa** (giữ sạch repo, không rác file thảo luận) |
| Ai chịu trách nhiệm lưu trữ để SL/SE đọc | AM ghi file vào `workflows/`, sau đó Node lại copy sang `.forge/runtime/nf/plans/` | Chỉ **Node** tự động lưu bản Plan từ conversation vào `.forge/runtime/nf/plans/<plan_id>/` |
| Tránh 3 lỗi format mục 5 | Dễ dính nếu AM viết bảng Markdown lệch khuôn | Nếu kết hợp JSON-first: AM xuất cấu trúc chuẩn, Node vừa render bảng Markdown chuẩn 100% ra khung chat vừa lưu `.json` + `.md` vào `.forge/runtime/nf/plans/` |

### 6.4. Các điểm cần chốt để đưa vào Scope triển khai

1. **Cách kích hoạt chốt Plan từ chat:**
   - *Phương án A (Tự động theo marker):* Hễ AM xuất bản tổng hợp có đánh dấu Plan hợp lệ trong chat, Node tự động validate và đăng ký luôn một `plan_id` (`awaiting_human_approval`) gắn với message đó.
   - *Phương án B (Lệnh `/plan` không cần path):* AM trình bày bản Plan trong chat; khi Owner ưng ý và gõ `/plan` (không cần truyền `workflows/...`), Node lấy bản Plan mới nhất trong `conversationId` hiện tại để khóa revision.
2. **Giữ cổng Owner Clarification khi còn quyết định mở:** Nếu trong lúc thảo luận vẫn còn tradeoff cấp owner chưa chốt, AM hỏi ngay trong chat (hoặc qua pha clarification) **trước khi** xuất bản tổng hợp Plan cuối cùng.
