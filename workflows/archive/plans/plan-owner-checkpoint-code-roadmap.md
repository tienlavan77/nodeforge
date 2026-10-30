<!-- Lộ trình code theo chặng cho kế hoạch checkpoint owner-execution dùng chung: chặng nào code được ngay, chặng nào bị gate bởi quyết định P1/P2; kèm dependency bắt buộc và verification, không phải Sprint Plan. -->
# Lộ trình code: Checkpoint owner execution dùng chung cho SE và AM

> **Tài liệu phụ của** `workflows/plan-shared-owner-execution-checkpoint.md` (sha hiện hành `3ac81c18…359e`). Plan đó quyết định *mục tiêu, phạm vi, guardrail, outcome O1–O8*; tài liệu này chỉ sắp xếp **thứ tự dependency kiến trúc** để chủ sở hữu thấy code bắt đầu từ đâu. **Đây không phải Sprint Plan**: số ticket, tên ticket, DAG delivery, mutable-file manifest và criteria chi tiết thuộc quyền Sprint Leader (`workflows/agents/sprint-leader/README.md`, mục "SL planning authority"). Không phải quyền triển khai: mọi chặng vẫn cần human approve đúng identity/revision/SHA-256 của plan nguồn (`workflows/human-plan.md`, "Approval Gate").

## 1. Nguyên tắc cắt chặng

1. **Tách theo cơ chế giải quyết, không theo "có liên quan P1/P2 hay không".** Hai nhóm (plan nguồn, §8): **self-contained** = chỉ khớp nhãn với dữ liệu đã có trong record → code được ngay sau human approve; **blocked-on-decision** = cần một câu trả lời bằng văn bản của con người **trước dòng code đầu tiên**, kể cả khi chọn P1. Tiêu chí cũ ("đứng nguyên dưới cả hai phương án") đã bị bỏ vì nó phân loại sai: guard 0 đúng là không đổi shape store, nhưng composition root `backend/scripts/control-api-http.mjs:20` đang gọi factory **không tham số** (sống bằng default) nên bỏ default vẫn là quyết định wiring phải chốt.
2. **Guard trước, gỡ chốt sau.** Hai root hiện đang thực thi bốn trách nhiệm cách ly (`owner-execution-checkpoint.js:23-25,34-43,48,61,85-91`; `owner-execution-control.js:21`). Guard phải xanh **trước khi** bất kỳ chặng nào bỏ `root`, vì đó là lúc chốt chống lẫn lộn bị rút (`plan-shared-owner-execution-checkpoint.md` mục 3.5, dòng 4b).
3. **Không đổi tên file, không đổi ý nghĩa trường identity.** Tên file giữ `hash32(conversationId)-hash32(executionId).json` (`:23-25`); `execution_id`/`lineage_id`/`attempt_number`/`resume_of` giữ semantics. Ngoại lệ duy nhất: **R4b thêm một trường fencing đơn điệu** (`lease_epoch`) — additive, record cũ thiếu trường được coi là epoch 0 nên không cần migration ngược. Nhờ cả hai điều trên, mọi chặng revert được bằng git.
4. **Mỗi chặng ≤ 4 file.** Hai rulebook đang lệch nhau về giới này — `workflows/agents/sprint-leader/README.md` nói "không có trần toàn cục", `workflows/human-plan.md` và `workflows/agents/architecture/README.md` mục 6 nói "tối đa bốn mutable files". Cắt chặng theo 4 file thoả cả hai cách đọc; xem mục 7.
5. **Mỗi chặng giữ file nguồn ≤ 250 dòng.** `owner-execution-checkpoint.js` đã 223/250 — nếu một chặng guard vượt trần, SL được kéo việc tách policy module (R2) lên sớm; đó là điều chỉnh delivery, không phải đổi scope.

## 2. Bảng chặng

| Chặng | Nội dung | Gate trước khi bắt đầu | Outcome chứng minh |
| --- | --- | --- | --- |
| **R0** | Owner chốt 5 câu: P1/P2, Hiểu A/B, lease, auth gate, retention | — (chưa code) | Điều kiện để SL lập SP |
| **R1** | *self-contained*: guard identity sau merge + `locate` fail-closed + `load`/`list` đối chiếu role + assert `parent.role === this.role` trước khi seed + assert `checkpoint.role === profile.role` | Approve plan nguồn. **Không cần owner trả lời thêm** | O8 (guards 1,2,3,4) |
| **R2** | Một bảng `role → {root, display_name, policy}`, bỏ giá trị mặc định, wire lại composition root; nhãn hiển thị lấy từ bảng này | R1 merged; wiring được chốt (composition root đang sống bằng default) | O8 (guards 0,7) + guard 6 qua R1.5, O6 |
| **R3a** *(nếu P1)* | 10 dòng nhánh `role === …` đọc `current.role`; test hai root không đọc chéo | R2 | O1', O2, O3 (phần P1) |
| **R3b** | Auth gate cho đường **đọc** execution (HTTP) | Nên song song R1/R2; **bắt buộc xong trước R4b/R5b** | O3 (HTTP), Blocker auth của plan cleanup |
| **R4b** *(chỉ P2)* | Một root: `start()` nhận `role` theo lượt, fencing `ownerInstanceId` theo record, quyết định lock key | R1+R2+R3b **xanh**; owner xác thuận P2 bằng văn bản | O1, O3 (lease), guard 5 |
| **R5b** *(chỉ P2)* | Đọc fallback `rootLegacy` (read-only) rồi mới di dời record chưa terminal | R4b merged; retention đã chốt | O4 |
| **R6** | Bộ negative test chéo role + crash/race hai process + doc/ADR | Chặng cuối của nhánh đã chọn | O5, O8, plan §7 |

`R3a` và `R4b…R5b` là **hai nhánh loại trừ nhau**, không phải hai bước kế tiếp.

## 3. Chi tiết theo chặng

### R0 — Năm câu trả lời của owner (không phải việc code)

| Câu | Mặc định nếu owner im lặng | Bị block |
| --- | --- | --- |
| P1 hay P2 | **P1** (kiến trúc sư đề xuất, plan §3.2) | R4b, R5b |
| Hiểu A hay B cho `coder` | **A** — coder ở lại `agent-checkpoints/${ticketId}.json` | O7 |
| Lease tuyến tính hay đổi key sang (conversation, role) | Tuyến tính, ghi thành test | R4b |
| Auth gate cho `GET .../executions` | **Phải bật** trước R4b/R5b | R3b |
| Retention record terminal | Giữ nguyên "không cleanup tự động" của `plan-pause-resume-r2.md` | R5b |

### R1 — Guard package, code được sớm nhất

Năm mục ứng năm guard trong plan §3.5, mỗi mục 2–4 file (nguồn + test), theo đúng trần bốn ở mục 1.4. **Bốn mục đầu không cần owner trả lời thêm; R1.5 thì có một lệ thuộc wiring:**

- **R1.1** `update` ghép lại `role`/`lineage_id`/`attempt_number`/`resume_of` từ `current` sau merge, và `patch` thêm allowlist trường (`owner-execution-checkpoint.js:53,85-91`) + `tests/unit/owner-execution-checkpoint.test.js` (212 dòng, đã import `createOwnerExecutionCheckpoint`). Files: 2.
- **R1.2** `load`/`list` từ chối record có `role` khác role của store, fail-closed kèm log (`:34-43`, hiện `list` mới lọc `record.conversation_id` ở `:40`) + test cùng file. Files: 2. **Lưu ý:** R1.1 và R1.2 cùng sửa `owner-execution-checkpoint.js` — SL nên gộp thành một ticket (3 file, vẫn trong trần) hoặc xếp thứ tự merge rõ, vì hai ticket sửa song song một file sẽ đụng nhau ở change ledger.
- **R1.3** `locate` bỏ điều kiện `record.role &&` (`owner-execution-control.js:21`): record không `role` = 404 + test trong `tests/unit/architecture-execution.test.js` (167 dòng). Files: 2.
- **R1.4** Guard 3 — restart đọc nhầm lineage. Plan §3.5 ghi **bắt buộc dưới cả P1 lẫn P2** (hôm nay đường này chỉ chết nhờ ENOENT của hai root, không nhờ code): `start({resumeOf})` phải assert `parent.role === this.role` **trước khi** seed `completed_tool_calls`/`changed_paths`/`lineage_id` (`:73-79`); lệch thì `EXECUTION_RECONCILIATION_REQUIRED`. Kèm **một dòng** assert `checkpoint.role === profile.role` sau `start()` ở `owner-sdk-stream.js:37-40`. Files: 2 nguồn + 1 test = 3.
- **R1.5** Guard 6 — nhãn: `summary()` trả thêm `role`; bỏ "System Engineer" hard-code trong thông báo busy (`:65`) và thay bằng tên hiển thị **tra từ bảng role→policy**. Bảng đó là sản phẩm của guard 0 (R2), nên **R1.5 merge sau R2** — SL nào muốn đi sớm thì để nguyên nhãn cho SE-only rồi đổi một lần ở R3a/R4b, miễn không thêm hằng số role thứ hai. Files: 3 nguồn + 1 test = 4.
- R1.1/R1.2/R1.4/R1.5 **cùng sửa** `owner-execution-checkpoint.js` → SL xếp lịch merge (gộp ticket hoặc tuần tự), và canh trần 250 dòng.
- **Không thuộc cluster code-ngay (bị gate):** docstring `start` (`:59` "Reserves a single execution lease for a direct System Engineer turn.") — đổi chữ hay thừa nhận machinery đang phục vụ cả AM là **quyết định ngữ nghĩa của owner** (plan nguồn §8, cluster 2 mục 1) → kéo sang chặng của nhánh đã chọn (R3a hoặc R4b).

**Nghiệm thu chặng (đối chiếu từng criterion của §3.5 vào đúng chặng):** trong năm negative test của plan §3.5, **ba test xanh ngay sau R1** — record role này nằm ở root kia phải bị `list`/`load` từ chối; `start({resumeOf})` trỏ record role khác phải bị chặn; `locate` trên record thiếu `role` phải 404. Hai test còn lại **không thuộc R1**: "store thiếu `root`/`role` ném lỗi lúc khởi tạo" là guard 0 → xanh sau R2; "thông báo busy nêu đúng role" cần tên hiển thị từ bảng → xanh sau R1.5. Tiêu chí R1 phải ghi ba test, không ghi năm — criteria sai chặng là nguồn test đỏ oan. `npm test` không thêm lỗi mới; `owner-execution-checkpoint.js` chưa vượt 250 dòng.

### R2 — Một bảng role, bỏ mọi giá trị mặc định

- Module mới `backend/src/application/owner-execution-role-policy.js`: `role → { root, display_name, mutation_set, run_check_settlement, single_mutation_guard, delete_file_semantics, reconcile_owner_auth }`. Tên theo `owner-role-tool-policy.js` đã có sẵn trong repo (`backend/src/tools/`, 35 dòng) và giữ `role`/`policy` như plan §3.1; kebab-case; **không** đụng `vocabulary/glossary.md`.
- Factory `createOwnerExecutionCheckpoint` chỉ nhận `role`, thiếu role → `ConfigurationError` lúc khởi tạo (`owner-execution-checkpoint.js:19` bỏ cả `root = ROOT` lẫn `role = "system_engineer"`).
- Wire lại composition root: `backend/scripts/control-api-http.mjs:20` hiện gọi factory **không tham số** (sống bằng default), `:21` truyền tường minh `root` + `role`, `:22` và `:27` truyền cả hai instance vào stream và control → chuyển sang một bảng tra. Files: module mới + checkpoint.js + control-api-http.mjs + 1 test = 4.
- **R2 xong là đã đạt P1 ở tầng wiring**: vẫn hai root, nhưng không còn khả năng ghép sai cặp.

**Nghiệm thu:** khởi tạo với `role: "unknown_role"` và với thiếu `role` đều ném lỗi trước khi nhận request; test cũ giả định hai root phải xanh mà **không** đổi assertion hành vi, chỉ đổi cách instantiate (plan §6, dòng test).

### R3a — Nhánh P1: policy đọc từ record

- Đổi 10 dòng chứa 11 biểu thức `role === …` sang `current.role` (`:88,98,114,115,117,119,130,139,163,200`) và ba cổng `owner_instance_id` (`:112,128,137,190`). Nhánh nào không suy được role từ record → `manual_required`, không đoán.
- Test "không đường nào ghép `root` của role khác vào `pathFor`" (thay cho O4 của P2).
- Rủi ro còn lại duy nhất: `record.role &&` fail-open — đã bị R1.3 bịt. Files: checkpoint.js + 1–2 test.
- **Đây là điểm kết thúc công việc nếu owner chọn P1.**

### R3b — Auth gate cho đường đọc (độc lập, làm sớm)

Evidence đã xác nhận trực tiếp trong lượt này: `backend/src/transport/http/forge-v1-conversation-routes.js:15` trả `ownerExecutionControl.list(...)` mà **không** gọi verifier; chỉ `reconcile` gọi `planOwnerAuth.verify(headers)` (`:19-22`, lời gọi tại `:21`), còn `pause` (`:23`), `continue`/`restart`/`discard` (`:25`) cũng không verify. Route chỉ kiểm tra `conversation.project_id !== projectId` (`:13-14`). File 144 dòng, đã nhận `planOwnerAuth` làm tham số (`:7`) → gate không cần đổi contract. Files: routes + 1 test HTTP (`tests/unit/architecture-execution.test.js` đã import `createPlanOwnerAuth` và `createForgeV1ConversationRoutes` tại `:153`). **Style = `security`**, tách ticket riêng theo rulebook SL.

Không phụ thuộc P1/P2, nhưng **bắt buộc xong trước R4b/R5b**: một list gộp hai role mà không gate là kênh lộ record chéo.

### R4b — Nhánh P2: một root

Chỉ bắt đầu khi owner xác thuận P2 **và** R1+R2+R3b đã merge.

- `start()` nhận `role` theo lượt (Node suy từ conversation), ghi vào record một lần; `storeFor()` của control không còn chọn store nhị phân (`owner-execution-control.js:8-35`).
- `ownerInstanceId` sinh theo instance (`:19`, `randomUUID()`) và là điều kiện của `patch` (`:88`) / `markStopped` (`:190`) — một UUID **không so sánh được theo thứ tự**, nên fencing phải đổi thành **token đơn điệu**: `lease_epoch` (hoặc `fencing_token`) tăng dần theo mỗi lần acquire, lưu trong record, và mỗi mutation đi kèm token đó; record từ chối token nhỏ hơn token đã lưu. Chỉ dựng lại "lease thuộc về ai" bằng `role` + instance thì chưa đủ: hai lượt cũ/mới vẫn có thể có instance bằng nhau hoặc token không so được.
- **Tiền lệ ngay trong repo** — SL không phải phát minh cơ chế: `backend/tests/unit/ticket-execution-fencing.test.js` (188 dòng, sha `fbf18012…2788`) đã test "stale-event fencing" cho Ticket execution qua `createTicketRunDispatch` (`backend/src/application/ticket-run-dispatch.js`) và `createApprovedTicketDispatch`. R4b nên **vay cùng kiểu bất biến** (event/turn cũ không được hoàn thành work của lượt mới) thay vì thiết kế một cơ chế fencing thứ hai; test của R4b nên đặt cạnh file đó để sau này chỉ có **một** fencing contract để bảo trì.
- Lock key: hiện `<root>/<hash(conversationId)>.lock` (`:61`) và `<path>.lock` (`:48`) → hai role cùng conversation **đang chạy song song hợp pháp**. Nếu owner giữ song song: thêm `role` vào key; nếu chấp nhận tuyến tính: giữ key, đổi thông báo busy (đã ở R1.5) và viết test `EXECUTION_BUSY` chéo role. **Không được để ngỏ cả hai.**
- Guard 4b không còn là ENOENT (`:73-74`) vì R1.4 đã dựng assert `parent.role === this.role` bằng code; việc còn lại của R4b chỉ là **test ghi thẳng `role` qua `patch` phải bị từ chối** (plan §3.5, cột P2 của dòng 4b) — chính là bất biến R1.1 đã đặt, được kiểm chứng lại ở bối cảnh một root.
- Files dự kiến: checkpoint.js, control.js, stream.js + test (4). Nếu cần file thứ 5, SL split — không phải lý do replan.

### R5b — Nhánh P2: chuyển tiếp record

- Bước 1: `load`/`list` nhận `rootLegacy` read-only — **không** cho `pathFor`, để không record mới bị viết vào root cũ.
- Bước 2 (chỉ khi owner muốn di dời): code migration quét root cũ, giữ nguyên `execution_id`/`lineage_id`/`attempt_number`/`resume_of`/receipts; idempotent qua hai lần restart; **cấm xóa** trong cùng đợt; không đụng record `manual_required`.
- Retention chưa chốt → migration chỉ đọc fallback, không di dời. `.forge/` không thao tác tay.

### R6 — Cứng hoá nghiệm thu

- Crash giữa write và receipt → `manual_required`; lease hết hạn khi mutation active → `manual_required`/`lease_expired_tool_active`; hai process; reload trang; discard khi write active.
- HTTP negative: token thiếu/sai, conversation/agent/execution chéo role, `GET executions` sau R3b.
- ADR ngắn ghi quyết định P1/P2 + lý do (plan §7 rulebook: "Ghi quyết định quan trọng đã duyệt thành ADR/architecture note").

## 4. Dependency bắt buộc vs. gợi ý (tách rõ)

**Bắt buộc (kiến trúc):** R1.1–R1.4 → R2 → R1.5 → (R3a | R4b); R3b trước R4b/R5b; R4b trước R5b; guard 3/4b **bằng code** trước khi bất kỳ chặng nào gỡ `root`.
**Gợi ý (SL đổi được):** cách cắt/gộp R1.1–R1.5 (bốn mục cùng sửa `owner-execution-checkpoint.js`), thứ tự trong R1, gộp R6 vào ticket cuối, chọn chạy R3b song song hay sau R2, và có trì hoãn R1.5 về nhãn sang chặng của nhánh đã chọn.

## 5. Verification dùng chung mọi chặng

- `backend/package.json` (37 dòng): `npm test` = `node --test`, `npm run lint` (eslint `--rulesdir ../eslint-rules`, `--max-warnings=0`), `npm run typecheck`, `npm run validate:schemas`.
- **Ghi baseline trước chặng đầu tiên:** `report-pause-resume-architecture.md` hiện NO-GO nên có thể đã có test đỏ; SL phải lưu số pass/fail baseline để không tính lỗi cũ vào chặng mới. Architecture được đọc `backend/**` (đã đọc `owner-execution-checkpoint.js`, `owner-sdk-stream.js`, `owner-execution-control.js`, `forge-v1-conversation-routes.js`) nhưng **không có quyền ghi hay chạy test ở đó** → mọi sha, số dòng và số pass/fail trích trong tài liệu này phải được SL đọc lại trước khi dispatch.
- Bắt buộc cho mọi `catch`: log/rethrow hoặc tham chiếu lỗi (`CLAUDE.md` "Error logging"; `eslint-rules/no-silent-catch.js`, có test `tests/unit/no-silent-catch.test.js`).

## 6. Rollback

Không chặng nào đổi tên file record và không chặng nào đổi semantics của các trường identity → revert từng chặng bằng git, record cũ đọc lại được bình thường (epoch mới coi là 0). Ba điểm cần kế hoạch revert riêng: **R4b** thêm `lease_epoch` (additive, tắt kiểm tra epoch là quay lại hành vi cũ) **và** đổi phạm vi lease/lock key; **R5b** di dời file. Với R5b, giữ nguyên chiến lược "đọc fallback trước, di dời sau" để rollback chỉ là tắt fallback.

## 7. Open item về quy trình (cần owner/SL, không chặn R1)

| Vấn đề | Ảnh hưởng | Xử lý đề xuất |
| --- | --- | --- |
| Rulebook lệch nhau về trần file: SL README "without a global maximum" vs `human-plan.md` / architecture README "tối đa bốn" | Major (admission rule của ticket) | Chốt một nguồn; lộ trình này cắt chặng ≤4 file nên an toàn dưới cả hai cách đọc |
| `owner-execution-checkpoint.js` 223/250 | Major | R1 có thể buộc kéo R2 lên sớm; SL được phép, không cần replan |
| Hai instance ở composition root sống bằng default (`control-api-http.mjs:20`) | Major | R2 bỏ default; đây là guard 0 |
| Test cũ giả định hai root | Major | SL rà trước, giữ assertion khác biệt hành vi |
| Retention + cleanup plan chưa chốt | Blocker cho R5b | Không dọn/cleanup trong các chặng này |

## 8. Tóm tắt một câu cho owner

Chọn **P1** → code gồm **R1 + R2 + R3a (+ R3b nếu muốn bịt kênh HTTP)**: không migration, không đổi lease, không đụng `.forge/`.
Chọn **P2** → thêm **R3b → R4b → R5b**, tức dựng lại bằng code đúng bốn trách nhiệm mà hai thư mục đang gánh hộ hôm nay, kèm migration có test.
