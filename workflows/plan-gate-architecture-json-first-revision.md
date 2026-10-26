<!-- Tài liệu thảo luận: điều khiển luồng Architecture Plan hoàn toàn bằng câu từ tự nhiên trong chat, kèm cơ chế revision JSON Merge Patch. Đây không phải plan đã duyệt và không mở quyền RUN. -->
# Plan: Điều khiển Architecture Plan bằng câu từ tự nhiên trong chat (revision hóa, JSON Merge Patch)

**Trạng thái tài liệu:** thảo luận/summary giữa Owner và Architecture Manager. Chưa phải plan đã approve, chưa tạo quyền RUN/dispatch.
Repository discovery complete.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** Luồng tạo và duyệt plan hiện buộc Owner thao tác bằng lệnh cố định (`/plan <file.md>`, `/approve <plan_id>`) hoặc nút UI, đồng thời nguồn plan bị khóa vào một file `.md` trên đĩa. Owner muốn làm việc **hoàn toàn bằng chat thường**, chỉ nói ý định bằng lời.
- **Kết quả:** Owner gõ ba câu từ đã thống nhất trong hội thoại và Node tự nhận diện ý định, tự ghép `plan_id`/`revision`/`sha256`, không phải gõ path, không phải copy hash, không bấm nút.
- **Giá trị:** Bỏ toàn bộ ma sát cú pháp lệnh và lỗi parse bảng Markdown; giữ nguyên cổng governance (revision + SHA-256 + owner authentication) phía sau.

## 2. Phạm vi

### In scope

- Bộ **câu từ trigger** trong chat cho ba hành vi: tạo kế hoạch, cập nhật kế hoạch, chấp nhận kế hoạch; ánh xạ sang intent phía Node.
- **Create và update dùng chung một cơ chế:** bản vá JSON Merge Patch (RFC 7396) trên `base`; `base` rỗng cho lần đầu, `base` = revision hiện hành cho lần cập nhật.
- Quy tắc khóa `revision` và ràng buộc an toàn khi một câu chat chứa nhiều ý định.
- Giữ tương thích ngược: cú pháp lệnh hiện hành vẫn hoạt động như alias.

### Out of scope

- Không đổi phân quyền AM/SL, không bỏ gate `Review Gate`, không bỏ owner authentication, không cho AM tự ghi `.forge/`.
- Không sửa validator UI/trang Coding trong tài liệu này (chỉ ghi dependency).
- Không tự triển khai code từ phiên thảo luận.

## 3. Hướng tiếp cận và guardrails

### 3.1. Bộ câu từ đã thống nhất (Owner nói — Node hiểu — AM làm)

| Câu từ trong chat (Owner) | Intent code đề xuất | Hành vi mong đợi | Mở RUN? |
| --- | --- | --- | --- |
| `tạo kế hoạch` | `plan_create` | AM khảo sát + trả plan JSON đầy đủ; Node canonicalize → khóa `r1` + `sha256`, render bản cho Owner xem | ❌ |
| `cập nhật kế hoạch` | `plan_update` | AM trả JSON Merge Patch trên revision hiện hành; Node merge → khóa `r<n>` mới, render lại | ❌ |
| `chấp nhận kế hoạch` | `plan_approve` | Node approve **đúng** `revision`/`sha256` của bản vừa render trong hội thoại này → handoff SL | ✅ sau approve |

Ranh giới lớp: **prose là tầng đàm phán ý định, JSON là tầng contract**. Node chỉ parse JSON do **AM** đặt trong message; Node không tự "đoán" nội dung plan từ prose thuần của Owner (đoán = lossy = phá WYSIWYG và phá authority của `sha256`).

### 3.2. Ràng buộc bắt buộc

- **Nhận diện ý định phải deterministic ở Node**, không giao cho LLM suy đoán: trigger phải là câu độc lập dạng mệnh lệnh ngắn (ví dụ đứng đầu dòng, không phải câu hỏi, không nằm trong dấu trích dẫn). Tiền lệ cơ chế phân loại bằng regex trong repo: `inferLegacyIntent` và `hasJsonCandidate`/`isParsableJsonCandidate` [Evidence: backend/src/application/owner-chat-service.js#L186-L209]; field `payload.intent` hiện chỉ nhận `normal_chat`/`ticket_create` [Evidence: backend/src/application/owner-chat-service.js#L59-L61].
- **`chấp nhận kế hoạch` không được gộp chung câu với `tạo kế hoạch`/`cập nhật kế hoạch`.** Nếu một message chứa đồng thời ý định duyệt và ý định tạo/cập nhật, Node chỉ thực hiện tạo/cập nhật và báo rõ: duyệt cần một câu riêng **sau khi** đã thấy bản render. Lý do: giá trị của `sha256` là Owner duyệt đúng thứ Owner đã nhìn; gộp một câu = duyệt mù.
- **Owner authentication vẫn bắt buộc**: intent approve chỉ được xử lý khi transport cung cấp `approved_owner_id` hợp lệ, giữ nguyên lỗi `PLAN_OWNER_UNAUTHORIZED` [Evidence: backend/src/application/owner-chat-command-service.js#L70-L74].
- **Fence chống bản cũ vẫn giữ**: nếu `revision`/`sha256` Node đang giữ khác bản được duyệt → `PLAN_APPROVAL_STALE` [Evidence: backend/src/application/owner-chat-command-service.js#L76-L77]. Message chứa payload plan bị Owner sửa/supersede sau khi đã khóa revision → từ chối, vì `supersedes_message_id` đã được kiểm tra trong cùng hội thoại [Evidence: backend/src/application/owner-chat-service.js#L47-L55].
- **`chấp nhận kế hoạch` nhắm revision chờ gần nhất đã render trong chính hội thoại**: khi có hơn một revision đang chờ (nhiều bản `cập nhật kế hoạch` chưa duyệt), Node mặc nhiên chọn **bản mới nhất** — vì đó đúng là thứ Owner vừa thấy, nên luật này là hệ quả trực tiếp của fence WYSIWYG, không phải cơ chế mới. Node **thông báo rõ** mình sắp duyệt revision nào; nhưng **không tự gộp** nhiều revision chờ thành một (gộp = hợp nhất các bản vá phân kỳ = tái sinh mơ hồ). Muốn hợp nhất, Owner phải nói `cập nhật kế hoạch` với một bản vá tường minh.
- **AM KHÔNG tự patch plan, và KHÔNG được mở quyền ghi runtime.** Quyền tạo/merge revision là của **Node**, không phải của AM: `markdownPlanStore.createRevision` chỉ được gọi từ mã Node trong `architecture-planning-service.js` (đường `/plan`), còn AM chỉ được invoke qua `requestArchitecture(prompt, conversationId)` để **trả nội dung** [Evidence: backend/src/modules/governance/markdown-plan-store.js#L21-L42; backend/src/application/architecture-planning-service.js#L65; backend/src/application/owner-chat-command-service.js#L57-L59]. Ranh giới quyền File Service đã khóa: AM chỉ ghi được `docs/`, `Skills/`, `workflows/`, `ARCHITECTURE.md`; **không** ghi `.forge/` (chỉ `system_engineer` mới có `forgeAccess`) [Evidence: backend/src/infrastructure/filesystem/file-service-role-policy.js#L10-L15; backend/src/infrastructure/filesystem/file-service-role-policy.js#L27-L33]. Vì vậy `cập nhật kế hoạch` = AM **xuất bản vá JSON Merge Patch trong message**, Node mới là bên merge + khóa `r<n+1>`. Mở quyền đọc/ghi `.forge/` cho AM sẽ phá vỡ ba bất biến: anchor `sha256` do Node cấp, fence WYSIWYG, và cổng `assertApproved` trước handoff.
- **Merge patch phải hết mơ hồ:** `nullable:false` + **whole-array replacement** (mảng được thay nguyên khối, không hợp nhất từng phần tử), theo JSON Merge Patch RFC 7396 (https://datatracker.ietf.org/doc/html/rfc7396).
- **Tương thích ngược (additive):** giữ `/plan <file.md>` và `/approve <plan_id>` như alias trong thời gian chuyển tiếp; chuỗi nhận lệnh hiện tại là regex `PLAN_RE`/`APPROVE_RE` trong `isCommand` và `submit` [Evidence: backend/src/application/owner-chat-command-service.js#L8-L9; backend/src/application/owner-chat-command-service.js#L40; backend/src/application/owner-chat-service.js#L55].

### 3.3. Hướng đề xuất

1. Trong `submit()`, trước khi stream thường: phân loại câu Owner sang `plan_create`/`plan_update`/`plan_approve`; nếu khớp, đi vào đường planning (`commandService.execute`) thay vì chỉ `normal_chat`.
2. `plan_create` = Merge Patch trên base rỗng; `plan_update` = Merge Patch trên revision gần nhất. **Một máy merge duy nhất**, không hai gate, không hai pipeline.
3. Node là nguồn duy nhất của `revision` + `sha256` + path lưu trữ; Owner và AM không bao giờ phải gõ các giá trị này. Việc lưu snapshot do Node đảm nhiệm, theo đúng quy tắc `.forge/` [Evidence: workflows/agents/architecture/README.md#L1-L20].
4. Payload plan của AM nằm trong message chat — cùng khuôn precedent mà pha discovery đã dùng (`{"questions":[...]}`) [Evidence: workflows/agents/architecture/README.md#L24-L34; backend/src/application/architecture-planning-service.js#L18-L22].
5. Anchor có hai vai trò tách bạch: `sha256`/`revision` là **authority** (quyết định được duyệt), `conversation_id` + `message_id` là **provenance** (bằng chứng nó đến từ đâu). Không dùng provenance để thay authority.

### 3.4. Dependency thật sự

- Phải chốt JSON Schema của Architecture Plan + quy tắc Merge Patch **trước** khi sửa tầng nhận intent, vì intent `plan_create`/`plan_update` cần một validator để dựa vào.
- Trang Coding UI và `/approve` đang đọc bản Markdown từ `markdownPlanStore`; nếu JSON là gốc thì Node phải render Markdown deterministic từ JSON để UI không gãy [Evidence: backend/src/modules/governance/markdown-plan-store.js].

### 3.5. Quyết định chưa chốt

Xem mục 6 (câu hỏi mở).

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `backend/src/application/owner-chat-service.js` | Cửa nhận message chat, phân loại intent, routing sang command service | Đã khảo sát, `submit`/`inferLegacyIntent` [Evidence: backend/src/application/owner-chat-service.js#L38-L110] |
| `backend/src/application/owner-chat-command-service.js` | Thực thi planning command, gate approve, handoff SL | Đã khảo sát `isCommand`/`execute`/`approvePlan` [Evidence: backend/src/application/owner-chat-command-service.js#L34-L93] |
| `backend/src/application/architecture-planning-service.js` | Pha discovery + generate plan từ nguồn | Đã khảo sát `start`/`resume`/`generate` [Evidence: backend/src/application/architecture-planning-service.js#L9-L75] |
| `backend/src/modules/governance/markdown-plan-store.js` | Lưu revision + snapshot nguồn, cổng approve | **Đã mở và xác minh trong phiên này**: `createRevision` khóa `expectedRevision` và sinh `sha256` phía Node, có cột `conversation_id`; `list()` chỉ trả revision MAX mỗi plan; `assertApproved` đòi đúng `sha256` + decision `approved` [Evidence: backend/src/modules/governance/markdown-plan-store.js#L22-L42; backend/src/modules/governance/markdown-plan-store.js#L74-L76; backend/src/modules/governance/markdown-plan-store.js#L96-L101] |
| `workflows/agents/architecture/README.md` | Khung plan và ranh giới quyền | Đã đọc toàn file [Evidence: workflows/agents/architecture/README.md] |

Các khu vực trên là hướng dẫn discovery, không phải mutable-file allowlist cố định; SL xác minh đường thực tế trước khi chốt manifest.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Owner tạo plan lần đầu chỉ bằng câu `tạo kế hoạch` trong chat | Không cần gõ path/hash/lệnh; Node trả `plan_id`, `revision`, `sha256` và nội dung render trong hội thoại; trạng thái `awaiting_human_approval`; chưa RUN | Merge Patch trên base rỗng; AM là tác giả JSON |
| O2 | Owner cập nhật plan chỉ bằng câu `cập nhật kế hoạch` | Payload của AM là JSON Merge Patch hợp lệ (RFC 7396, `nullable:false`, whole-array replacement); Node tạo `r<n+1>`; bản cũ vẫn truy vết được | Một máy merge dùng chung O1/O2 |
| O3 | Owner chấp nhận plan chỉ bằng câu `chấp nhận kế hoạch` | Node approve đúng `revision`/`sha256` của bản vừa render; có owner authentication; approve bản cũ trả `PLAN_APPROVAL_STALE` | Fence revision; không gộp câu create+approve |
| O4 | Luồng lệnh cũ vẫn chạy | `/plan <file.md>` và `/approve <plan_id>` hành xử y như trước trong toàn bộ test hiện có | Additive, không breaking |
| O5 | Prose không bao giờ được Node "đoán" thành plan | Message không chứa payload JSON đạt chuẩn → không sinh revision; Node phản hồi yêu cầu AM xuất payload | WYSIWYG invariant |

**Gợi ý delivery (không bắt buộc):** tách (a) bộ nhận diện intent + test, (b) máy Merge Patch + schema, (c) đường approve từ revision hiện hành trong hội thoại. (a) và (c) có thể chạy song song sau khi (b) chốt schema.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| Câu trigger nằm trong câu hỏi hoặc trong trích dẫn bị hiểu nhầm thành lệnh | Major | Giả định (chưa kiểm chứng bằng test hiện có); xử lý bằng luật "câu độc lập dạng mệnh lệnh" ở Node | AM chốt luật nhận diện; SL thêm test |
| Nhiều hội thoại/plan treo cùng lúc → `chấp nhận kế hoạch` ám chỉ bản nào | Major | **Đã xác minh:** `markdown_plan_revisions` có cột `conversation_id` và `list()` trả đúng `MAX(revision)` của từng `plan_id` theo `created_at` [Evidence: backend/src/modules/governance/markdown-plan-store.js#L39-L40; backend/src/modules/governance/markdown-plan-store.js#L74-L76] | ĐÃ CHỐT: `chấp nhận kế hoạch` nhắm **revision chờ gần nhất** của `conversation_id` hiện tại (Node lọc theo `conversation_id` lấy phần tử cuối, thông báo rõ bản sắp duyệt, **không tự gộp**). Muốn gộp, Owner nói `cập nhật kế hoạch` với bản vá tường minh |
| Bỏ hẳn slash command làm gãy UI/CLI/test cũ | Major | Facts: regex `PLAN_RE`/`APPROVE_RE` được dùng cả ở service và ở `submit` | Giữ alias, chỉ thêm đường chat |
| Duyệt mù khi gộp create + approve trong một câu | Blocker nếu chấp nhận | Decision đã chốt ở mục 3.2: tách câu là bắt buộc | AM enforce; Owner muốn gộp phải yêu cầu rõ và ghi thành quyết định riêng |
| Mở quyền cho AM tự đọc/ghi `.forge/` để tự patch plan | Blocker nếu chấp nhận | Facts: `file-service-role-policy.js` chỉ cấp `forgeAccess` cho `system_engineer`; AM chỉ ghi `docs/`, `Skills/`, `workflows/`, `ARCHITECTURE.md` [Evidence: backend/src/infrastructure/filesystem/file-service-role-policy.js#L10-L33] | ĐÃ CHỐT: **Không mở runtime cho AM**. AM chỉ xuất bản vá JSON trong chat; Node là bên duy nhất đọc base, merge và ghi revision vào `.forge/runtime/nf/plans/` |
| Tên code cho intent | Minor | Đề xuất `plan_create`/`plan_update`/`plan_approve`, nhất quán kiểu `ticket_create`; **chưa có** mapping trong glossary | Theo quy tắc vocabulary, mapping mới đi qua pipeline gợi ý riêng, không tự sửa `vocabulary/glossary.md` |

**Giả định chưa kiểm chứng (assumptions / unknown):** nội dung `markdown-sprint-scope.js` được tham chiếu từ vòng thảo luận trước, chưa mở lại trong phiên này; UI trang Coding đọc Markdown hay JSON chưa được xác minh bằng source code.

## 7. Acceptance criteria của plan

- [ ] Mục tiêu, in/out scope và outcomes nhất quán với yêu cầu "chỉ chat, không lệnh, không nút".
- [ ] Facts repository-specific có evidence; assumptions và vùng unverified ghi rõ.
- [ ] Guardrails (intent deterministic, fence revision, owner auth, additive alias) tách khỏi gợi ý delivery.
- [ ] Outcomes có tiêu chí kiểm tra được, đủ để SL tự lập Sprint Plan.
- [ ] Không áp đặt số lượng/tên ticket hay mutable-file manifest khi chưa cần Owner quyết định.
- [ ] SL chứng minh coverage và tuân thủ policy ticket hiện hành trước dispatch.
- [ ] Approval đúng identity/revision/SHA-256; lập Sprint Plan không tự RUN/dispatch.

## 8. Năm quyết định đã chốt (tổng hợp các vòng)

1. **Không có nút bấm, không có slash command** cho trải nghiệm mới — chỉ chat thường, với bộ câu từ ở mục 3.1.
2. **Tách hai hành vi "khóa revision" và "duyệt"** bằng hai câu riêng (`tạo/cập nhật kế hoạch` rồi `chấp nhận kế hoạch`) để giữ fence WYSIWYG.
3. **JSON Merge Patch (RFC 7396)** cho mọi cập nhật, kèm `nullable:false` và whole-array replacement; create = merge trên base rỗng.
4. **Nhiều revision chờ trong cùng hội thoại**: `chấp nhận kế hoạch` mặc nhiên duyệt **bản mới nhất đã render** (Node thông báo rõ revision nào); Node **không tự gộp** nhiều revision chờ — muốn gộp phải qua `cập nhật kế hoạch` với bản vá tường minh.
5. **AM không tự patch plan, không mở quyền đọc/ghi runtime (`.forge/`) cho AM.** AM chỉ xuất bản vá JSON trong message chat; Node là thành phần duy nhất đọc base hiện hành, merge, khóa `r<n+1>` và ghi snapshot. Đây là ràng buộc quyền đã tồn tại trong `file-service-role-policy.js`, không phải quy định mới — giữ nguyên để bảo toàn anchor `sha256` và cổng `assertApproved`.
