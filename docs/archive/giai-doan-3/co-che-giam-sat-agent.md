# Cơ chế giám sát agent — Chống khám phá quá mức (search/read lan man)

> Mục tiêu: “đọc đúng & đủ” — cho phép đủ discovery để xác định target và hiểu context, nhưng buộc agent chuyển sang `edit_diff`/`write_diff` ngay khi thông tin đã hội tụ. Không chỉ hạ `discovery_budget` cho xong.

## 1. Vấn đề & bối cảnh

### Triệu chứng thực tế

Ticket `TICKET-PROJECT-NODEFORGE-1789491448083` (thuần UI, `complexity=simple`, `discovery_budget=6`, `max_turns=15`) đã tiêu **10 discovery calls** trước lần `edit_diff` đầu tiên:

- `select_code_graph_candidates` × 6
- `search_code` × 3
- `read_file` × 1

Chỉ nhờ cơ chế escalation `+50%` (6 → 9) mới không bị chặn cứng. Kết quả edit thì **đúng file** — tức agent “làm đúng nhưng quá nhiều”.

### Cơ chế hiện tại (chỉ phản ứng, chưa chủ động nhắc)

- `backend/src/tools/exploration-state.js`
  - `assertDiscoveryBudget(context)` — chặn cứng sau `discovery_limit` calls (mặc định 8, override bởi `complexity.discovery_budget`), cho **1 lần** escalation `+ceil(limit*0.5)` chỉ khi `unproductive_streak===0`; lần sau ném `EXPLORATION_BUDGET_EXHAUSTED` (“Your ONLY next action is edit_diff or write_diff”).
  - `recordSearch` — productive = query mới AND ≥1 unseen path; ngược lại `countUnproductive()` → streak 3 ném `EXPLORATION_STAGNANT`.
  - `recordRead` — key `${path}#${window}`; đọc lại cùng window → unproductive.
  - Phase gate: discovery chỉ bị đếm trước `edit_started`; sau `markEditStarted()` (gọi trong `write_diff`/`edit_diff`) thì gate mở vĩnh viễn.
- `backend/src/tools/agent-lifecycle-tools.js` — `createReadFileTool` chỉ trả `deadline_warning` ở nhánh **preview** (>500 lines, chưa có window), không nhắc ở `search_code`/graph.
- `backend/src/tools/ticket-complexity.js` — `COMPLEXITY_CONFIG`: simple 6/15, moderate 12/25, complex 18/40.
- Prompt khởi tạo chỉ nêu tổng budget một lần, không cập nhật live count.

Hệ quả: agent không biết mình còn bao nhiêu lượt, cứ search/read tới khi **đụng tường** mới dừng. Cần chuyển từ “trừng phạt khi quá hạn” sang “nhắc liên tục để tự dừng trước hạn”.

---

## 2. Nhóm giải pháp (12 nhóm, từ nhẹ → cứng)

### 2.1. Nhắc ngân sách động sau mỗi lần discovery

**Mô tả:** Sau mỗi `select_code_graph_candidates` / `search_code` / `read_file` / `read_code`, trả thêm khối budget.

**Ví dụ payload:**
```json
{
  "discovery_budget": {
    "used": 5,
    "limit": 9,
    "remaining": 4,
    "edit_started": false,
    "message": "Identify the target file and start editing now."
  },
  "exploration_guidance": {
    "new_information_required": true,
    "duplicate_paths": [],
    "suggested_next_action": "edit_diff"
  }
}
```

**Ngưỡng thông báo:**
- `remaining > 50%` — thông báo thường
- `remaining ≤ 50%` — cảnh báo
- `remaining ≤ 2` — “your next calls must be edit_diff/write_diff”
- `remaining == 0` — chỉ cho `edit_diff`/`write_diff`

**Ưu điểm:** ít phá hành vi, agent thấy trạng thái thật, dễ debug qua checkpoint/log.  
**Nhược điểm:** phụ thuộc agent có tuân thủ; payload phình nhẹ (~vài chục byte/lần) nhưng net-lợi vì giảm tổng calls.  
**Điểm chạm:** `backend/src/tools/index.js` (dispatch) hoặc từng tool wrapper; nguồn dữ liệu đã có `discoveryCount(context)`.

### 2.2. Luật hội tụ: xác định được file thì phải chuyển sang edit

**Mô tả:** Khi đã xác định target file + đọc đủ vùng liên quan, phải bắt đầu `edit_diff`/`write_diff`. Không search lại chỉ để xác nhận.

**Prompt convergence rule:**
```
Convergence rule:
- Stop discovery once the ticket target file and relevant symbol are identified.
- Read only the minimum surrounding context needed to edit safely.
- Do not re-search a path already returned by search or candidate selection.
- Do not perform verification searches before the first edit.
- Begin edit_diff/write_diff no later than the next turn after identifying the target.
```

**Enforcement (governance):** nếu `search_code` đã trả target path và `read_file` đã đọc target mà tool tiếp theo vẫn là discovery → cảnh báo/từ chối.

**Ưu điểm:** xử lý đúng nguyên nhân “đã tìm thấy nhưng vẫn tìm tiếp”, không cần giảm budget.  
**Nhược điểm:** cần định nghĩa “đủ hiểu”; enforcement quá cứng có thể khiến sửa sớm ở ticket phức tạp. Nên bắt đầu ở mức warning.

### 2.3. Tách ngân sách theo loại discovery

**Mô tả:** Thay vì một budget chung, tách hoặc trọng số:

```js
{ candidate_calls: 2, search_calls: 3, read_calls: 3, total_calls: 7 }
// hoặc trọng số
{ select_code_graph_candidates: 1, search_code: 1, read_file: 2 }
```

Ticket đơn giản: 1–2 candidate, 2–3 search, 1–2 read rồi bắt buộc edit. Ticket phức tạp dùng hạn mức lớn hơn.

**Ưu điểm:** ngăn một loại tool chiếm hết budget, buộc chuyển từ “tìm vị trí” sang “đọc nội dung”.  
**Nhược điểm:** cần tinh chỉnh theo loại ticket; ticket không theo trình tự candidate→search→read có thể gặp giới hạn không phù hợp.

### 2.4. Dùng target path để bỏ qua / rút ngắn discovery

**Phân cấp theo độ rõ của target:**

- **Target là file chính xác** (`ui/src/architecture-manager-selection.js`): budget rất thấp (2) — `read target` → `read test liên quan` → `edit`. Không cần graph/search toàn repo.
- **Target là thư mục:** cho search giới hạn trong thư mục đó.
- **Không có target:** cho graph search + search rộng.

**Ưu điểm:** giảm mạnh lượt với ticket UI / ticket mô tả file rõ.  
**Nhược điểm:** `ticketTargetPath` extractor phải chính xác; nếu path sai cần cơ chế báo “target không tồn tại” thay vì quay lại search toàn repo.  
**Liên quan:** `backend/src/modules/supervisor/nodeforge-task-integration.js` (`ticketTargetPath`, `prefixForPath`, `ticketAllowedPrefixes`).

### 2.5. Giảm / loại bỏ escalation tự động

Hiện tại 1 lần `+50%` có thể hợp thức hóa khám phá quá lâu ở ticket `simple`.

**Biến thể:**
- **A. Không escalation cho simple:** `simple: 0, moderate: 1, complex: 1`
- **B. Chỉ escalation khi có tiến triển:** `discovery sắp hết AND lần gần nhất có path mới AND không lặp query/path AND chưa có target rõ`
- **C. Escalation phải được xin:** trả `EXPLORATION_BUDGET_EXHAUSTED` kèm `escalation_available: true`; agent phải nêu lý do, governance quyết định cấp.

**Ưu điểm:** không để fallback thành budget mặc định, ticket đơn giản được bảo vệ.  
**Nhược điểm:** siết quá mạnh có thể chặn ticket phức tạp; biến thể C tốn thêm 1 turn.

### 2.6. Chặn discovery lặp theo query / path / cửa sổ đọc

Đã có `seen_queries` / `seen_paths` / `seen_reads` / `unproductive_streak`. Siết thêm:

- **Chuẩn hóa query** (lowercase, trim, bỏ từ phụ) trước so sánh.
- **Phạt search trả cùng tập path** dù query khác — `same result paths => unproductive`.
- **Giới hạn số lần đọc cùng file** (ví dụ `max_reads_per_file: 2`).

**Ưu điểm:** chống vòng lặp tinh vi khi query đổi nhẹ.  
**Nhược điểm:** search khác query nhưng cùng kết quả đôi khi vẫn có giá trị; cần cẩn với file lớn cần nhiều window.

### 2.7. Đọc theo cửa sổ nhỏ, không lan rộng

**Quy tắc:**
- Đọc target trước, chỉ đọc khoảng dòng chứa symbol + vùng liền kề.
- Không đọc toàn file nếu không cần.
- File lớn phải nêu lý do khi đọc thêm window; sau 1–2 window liên tiếp phải edit hoặc nêu blocker.

**Ví dụ thông báo:**
```
You have read 2 windows from this file.
Read another window only if the current context cannot support a safe edit.
```

**Ưu điểm:** giảm context phình, vẫn đủ để sửa an toàn.  
**Nhược điểm:** giới hạn quá thấp có thể thiếu context; cần phân biệt file cấu hình nhỏ vs file nguồn lớn.

### 2.8. Tool result kèm hướng dẫn hành động kế tiếp

Thay vì chỉ trả dữ liệu thô, mỗi discovery result kèm `next_action`:

```json
{
  "result_paths": ["ui/src/architecture-manager-selection.js"],
  "next_action": { "type": "read_file", "path": "ui/src/architecture-manager-selection.js", "reason": "Target candidate identified" }
}
```
Sau khi target đã đọc:
```json
{ "next_action": { "type": "edit_diff", "reason": "Target and relevant implementation context identified" } }
```

**Ưu điểm:** giảm suy luận thừa, ổn định hành vi giữa các provider, log được recommendation.  
**Nhược điểm:** governance phải hiểu nhiều trạng thái hơn; không nên biến thành workflow cứng cho mọi ticket.

### 2.9. Hard gate sau khi discovery đủ điều kiện (`edit_required`)

Khi `target_identified && target_read`:

```js
{ target_identified: true, target_read: true, edit_required: true }
```

- Cho `edit_diff`/`write_diff`/`run_test`
- Cho `read_file` thêm 1 lần nếu có lý do
- Từ chối `search_code`/`select_code_graph_candidates`

**Lỗi mẫu:**
```
TARGET_CONTEXT_READY:
The target file has been identified and read.
Further repository discovery is blocked. Your next action must be edit_diff or write_diff.
```

**Ưu điểm:** hiệu quả nhất để ngăn over-exploration, lý do chặn rõ ràng.  
**Nhược điểm:** cần định nghĩa chính xác “target context ready”; có thể hỏng ticket cần tìm thêm caller/test. Nên bật warning trước, chỉ hard gate cho `simple` hoặc ticket có target chính xác.

### 2.10. Policy riêng theo provider

Codex và Claude phản ứng khác nhau với cùng prompt. Không nên một mức cho tất cả:

```js
const policy = provider === "codex"
  ? { simpleDiscoveryBudget: 4, escalation: false, convergence: "strict" }
  : { simpleDiscoveryBudget: 6, escalation: true,  convergence: "normal" };
```

Hoặc khác prompt:

```
Codex: Prefer editing after one target read. Do not perform exploratory verification searches.
Claude: Preserve one additional read window when needed for dependency context.
```

Tốt hơn là giữ chung governance nhưng thu metrics theo provider để tránh điều chỉnh theo cảm giác.

### 2.11. Giới hạn theo turn, tách discovery turn và edit turn

`max_turns` tổng không phản ánh đúng. Tách:

```js
{ max_total_turns: 15, max_discovery_turns: 5, max_pre_edit_turns: 7 }
```

Quy tắc mốc pre-edit:

- Simple: edit trước turn 4–5
- Moderate: trước turn 7
- Complex: trước turn 10

**Ưu điểm:** bảo vệ thời gian cho edit/test/report.  
**Nhược điểm:** cần thống nhất “turn” là model turn hay tool call; nên dùng discovery budget làm giới hạn chính, pre-edit làm safety net.

### 2.12. Tự động dừng run nếu không hội tụ

Phát hiện:

- Cùng tập path sau nhiều search
- Không có edit sau N discovery calls
- `discovery_count` tăng nhưng `seen_paths` không tăng
- Target đã đọc nhưng vẫn search rộng

→ cảnh báo mạnh → chuyển edit-only → dừng run + checkpoint → resume với prompt ngắn yêu cầu sửa.

```
The run is not converging. Discovery produced no new paths in the last 3 calls.
Continue only with edit_diff/write_diff.
```

**Ưu điểm:** tiết kiệm tài nguyên, không để agent tiêu hết turn budget.  
**Nhược điểm:** false positive có thể ngắt điều tra hợp lệ; cần checkpoint tốt để resume an toàn (`backend/src/modules/supervisor/nodeforge-task-integration.js` checkpoint per-tool đã có).

---

## 3. Gói triển khai (theo độ ưu tiên)

### Gói 1 — Ít rủi ro, làm ngay

1. Budget động trong mọi discovery result (2.1)
2. Prompt convergence rule (2.2 ở mức warning)
3. Hiển thị `used / remaining / suggested_next_action`
4. Không cho đọc/search trùng không lý do (2.6)
5. Tắt escalation cho `simple` (2.5-A)

### Gói 2 — Enforcement vừa

1. Nếu target path rõ → bỏ qua candidate search (2.4)
2. Nếu target đã đọc → search tiếp phải có lý do (2.2 enforcement + 2.9 warning)
3. Giới hạn riêng cho candidate/search/read (2.3)
4. Discovery phải kết thúc trước mốc pre-edit (2.11)

### Gói 3 — Hard enforcement

1. Bật `edit_required` gate sau khi target đã đọc (2.9 hard)
2. Chặn search khi không còn thông tin mới (2.6 hard)
3. Chuyển edit-only khi không hội tụ (2.12)
4. Chỉ cho escalation qua yêu cầu có lý do (2.5-C)

---

## 4. Bảng cấu hình mẫu

```js
// backend/src/tools/ticket-complexity.js — COMPLEXITY_CONFIG mở rộng
simple:   { totalDiscovery: 5,  candidateCalls: 1, searchCalls: 2, readCalls: 2, escalation: false, editMustStartBy: 5  }
moderate: { totalDiscovery: 10, candidateCalls: 2, searchCalls: 4, readCalls: 4, escalation: true,  editMustStartBy: 8  }
complex:  { totalDiscovery: 16, candidateCalls: 4, searchCalls: 6, readCalls: 6, escalation: true,  editMustStartBy: 12 }
```

Áp cho ticket UI có target rõ:

```
target path rõ hoặc target nằm trong ui/
→ tối đa 1 candidate call
→ tối đa 2 search/read calls
→ bắt đầu edit
→ không quay lại khám phá repository sau khi đã đọc target
```

---

## 5. Kết luận nguyên tắc

Không nên chỉ giảm `discovery_budget` từ 6 xuống 3 — cách đó khiến agent sửa sớm nhưng **không khiến nó đọc thông minh hơn**. Mục tiêu đúng:

> Cho phép đủ discovery để xác định target và hiểu context, nhưng buộc agent chuyển sang edit ngay khi thông tin đã hội tụ.

Tài liệu này là tham khảo thiết kế; thứ tự triển khai khuyến nghị là **Gói 1 → đo qua checkpoint/log → Gói 2 → Gói 3** khi có đủ dữ liệu provider-specific.

## 6. Tham chiếu mã nguồn

- `backend/src/tools/exploration-state.js` — `assertDiscoveryBudget`, `recordSearch`, `recordRead`, `EXPLORATION_STAGNANT`, `EXPLORATION_BUDGET_EXHAUSTED`
- `backend/src/tools/agent-lifecycle-tools.js` — `discoveryCount`, `deadline_warning` trong `createReadFileTool`
- `backend/src/tools/ticket-complexity.js` — `COMPLEXITY_CONFIG`, `classifyTicketComplexity`
- `backend/src/tools/index.js` — `createForgeToolRegistry` dispatch + `formatToolLogEvent`
- `backend/src/modules/supervisor/nodeforge-task-integration.js` — `ticketTargetPath`, `prefixForPath`, `ticketAllowedPrefixes`, checkpoint per-tool, prompt “Budget discipline”
