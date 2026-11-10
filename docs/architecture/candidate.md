Đúng rồi. Bài toán cần giải không phải riêng **Ticket → Code**, mà là:

> **Forge request / Plan outcome / Ticket objective + AC → các file và symbol liên quan nhất, với số lượt tìm kiếm tối thiểu nhưng đủ tin cậy.**

Tôi đề xuất xây dựng một lớp **Semantic Candidate Retrieval** dùng chung cho:

- yêu cầu trực tiếp của Owner;
- hạng mục/outcome trong Architecture Plan;
- ticket do SL tách ra;
- phản biện của SE;
- review của RV;
- yêu cầu tiếp tục/resume.

## 1. Mô hình tổng quát

```text
Forge request
  + plan outcome
  + ticket title/objective
  + acceptance criteria
  + guardrails/constraints
  + role + scope
        │
        ▼
Semantic Query Builder
        │
        ├─ lexical terms / domain terms
        ├─ behavior intents
        ├─ contract/security terms
        └─ negative constraints
        │
        ▼
Embedding Summary Index
        │
        ▼
Hybrid Retrieval
  lexical + embedding + graph + evidence cache
        │
        ▼
Reranker
        │
        ▼
Small candidate set
  files + symbols + tests + reasons + confidence
        │
        ▼
Agent reads only selected candidates
```

Điểm quan trọng: **embedding không trả về toàn bộ code**. Nó chỉ trả về candidate có lý do, symbol và metadata; agent chỉ `Read` các candidate đã được chọn.

---

## 2. Input không chỉ là câu request

Semantic query nên được tạo từ một object thống nhất:

```js
{
  source: "owner_request | plan_outcome | ticket | se_critique | rv_review",
  title,
  objective,
  acceptance_criteria: [],
  guardrails: [],
  constraints: [],
  evidence_paths: [],
  plan_id,
  handoff_id,
  ticket_id,
  role,
  allowed_file_paths,
  allowed_prefixes,
  changed_paths
}
```

### Ví dụ

```text
Title:
"Resume handoff sau crash"

Objective:
"Cho phép tiếp tục từ checkpoint an toàn sau khi tiến trình SE bị dừng bất ngờ"

AC:
- Không chạy lại bước đã có terminal receipt hợp lệ
- Nếu execution đang unknown thì phải chuyển sang reconciliation
- Resume không được tạo handoff mới
- Workspace mismatch phải bị chặn

Guardrails:
- Giữ nguyên plan revision và SHA
- Không replay mutation chưa được xác minh
- RV vẫn phải review độc lập
```

Từ đó hệ thống không chỉ tìm chuỗi `"resume"` mà phân rã thành các intent:

```text
checkpoint recovery
terminal receipt recovery
unknown execution
workspace reconciliation
plan identity preservation
handoff state transition
```

Đây mới là cách tìm sát nghĩa.

---

## 3. Embedding Summary nên chứa gì?

Không nên embedding nguyên file. Mỗi **file**, **symbol**, **test**, và **contract** cần một summary có cấu trúc.

### File summary

```js
{
  path: "backend/src/application/am-se-handoff-checkpoint.js",
  kind: "module",
  role: "durable handoff state machine",
  summary: "Validates and advances one AM-SE-RV handoff checkpoint, including terminal receipt recovery, workspace baseline checks, reconciliation and safe resume.",
  behaviors: [
    "initialize checkpoint",
    "recover terminal result",
    "reconcile unknown execution",
    "resume next role",
    "validate workspace identity"
  ],
  contracts: [
    "HANDOFF_STALE",
    "HANDOFF_BUSY",
    "HANDOFF_WORKSPACE_MISMATCH",
    "HANDOFF_RECONCILIATION_REQUIRED"
  ],
  symbols: [
    "resolveSafeResumeState",
    "complete",
    "reconcile",
    "resume"
  ],
  imports: [],
  imported_by: [],
  sha256: "sha256:..."
}
```

### Symbol summary

```js
{
  path: "backend/src/application/am-se-handoff-checkpoint.js",
  symbol: "resume",
  kind: "function",
  summary: "Resumes the next incomplete role after validating plan identity, checkpoint generation, predecessor evidence and workspace fingerprint.",
  behaviors: [
    "safe checkpoint selection",
    "predecessor validation",
    "execution intent persistence",
    "adapter invocation",
    "terminal receipt completion"
  ],
  related_ac: [
    "Resume từ checkpoint an toàn",
    "Không replay bước đã hoàn thành"
  ],
  sha256: "sha256:..."
}
```

Embedding nên được tạo từ:

```text
role + path + symbol + summary + behaviors + contracts + test names + domain terms
```

Không đưa secret, prompt riêng tư hay toàn bộ source vào embedding.

---

## 4. Candidate retrieval nên là Hybrid, không chỉ Embedding

Embedding đơn thuần dễ trả về file “nghe giống” nhưng không thực sự được gọi trong runtime. Vì vậy điểm số nên kết hợp 4 nguồn:

```text
candidate_score =
  0.40 * semantic_similarity
+ 0.25 * lexical_match
+ 0.20 * dependency_graph_relevance
+ 0.15 * evidence_reuse
```

Có thể thêm penalty:

```text
- scope_violation_penalty
- stale_evidence_penalty
- unrelated_role_penalty
- generated_or_runtime_state_penalty
```

### 4.1 Semantic similarity

Tìm theo ý nghĩa:

- “khôi phục execution sau crash”
- gần với summary “reclassifies stale running execution”
- dù không có cùng từ `"crash"`.

### 4.2 Lexical match

Giữ chính xác các identifier quan trọng:

- `HANDOFF_EXECUTION_UNKNOWN`
- `resolveSafeResumeState`
- `execution_status`
- `active_file_checksums`

Lexical search đặc biệt cần thiết cho error code, schema name, route và event name.

### 4.3 Dependency graph

Sau khi có top candidate, mở rộng rất hẹp:

- `imports` của candidate;
- `imported_by`;
- `calls`;
- test trực tiếp của symbol.

Không crawl toàn repo. Chỉ mở rộng 1-hop, hoặc 2-hop khi confidence thấp.

### 4.4 Evidence reuse

Nếu kho của AM/SE/RV đã có file với SHA hiện hành:

- không gọi lại `search_text`;
- không gọi lại `read_file`;
- dùng thẳng `symbol_map`, `code_graph`, summary và `Read` receipt.

Đây là nơi cross-share giữa AM ↔ SE ↔ RV tạo hiệu quả lớn nhất.

---

## 5. Candidate phải trả về “vì sao được chọn”

Kết quả không nên chỉ là danh sách path:

```js
{
  candidates: [
    {
      path: "backend/src/application/am-se-handoff-checkpoint.js",
      symbol: "resume",
      score: 0.94,
      confidence: "high",
      matched_intents: [
        "safe resume",
        "checkpoint recovery",
        "workspace validation"
      ],
      matched_ac: ["AC1", "AC3", "AC4"],
      evidence: {
        source: "embedding_summary",
        sha256: "sha256:...",
        fresh: true
      },
      next_action: "Read symbol"
    }
  ],
  search_plan: {
    direct_reads: 3,
    graph_expansion: 2,
    additional_search_allowed: false
  }
}
```

Agent biết:

- file nào cần đọc;
- symbol nào cần đọc;
- file được chọn vì AC nào;
- evidence còn fresh hay không;
- có nên tìm thêm không.

---

## 6. Candidate theo từng loại yêu cầu

### 6.1. Plan outcome

Ví dụ outcome:

> “Cung cấp cơ chế resume an toàn cho handoff AM-SE-RV.”

Candidate ưu tiên:

1. state machine/checkpoint;
2. handoff service;
3. execution receipt;
4. workspace snapshot;
5. route/UI;
6. tests.

Không candidate ngẫu nhiên theo từng từ khóa.

### 6.2. Ticket

Ticket có thể hẹp hơn:

> “Sửa lỗi `HANDOFF_PREDECESSOR_REQUIRED` khi resume.”

Candidate ưu tiên:

1. nơi phát sinh error;
2. hàm kiểm tra predecessor;
3. resolver safe point;
4. test đang chứng minh lỗi;
5. caller trực tiếp.

### 6.3. SE critique

SE không cần tìm lại toàn bộ plan. Query sẽ kết hợp:

```text
plan outcome
+ SE critique
+ existing AM evidence
+ current workspace SHA
```

SE chỉ tìm phần critique chưa được chứng minh.

### 6.4. RV review

RV cần candidate theo:

```text
changed_paths
+ implementation report
+ locked acceptance criteria
+ affected symbols
+ tests/verification
```

RV không nên embedding-search cả repo nếu SE đã cung cấp changed paths và evidence.

---

## 7. Quy tắc số lượt tìm kiếm tối thiểu

Tôi đề xuất một **retrieval stop policy**:

### Bước 0 — đọc kho

Luôn gọi:

```text
read_subagent_evidence({})
```

### Bước 1 — dùng evidence fresh

Nếu có candidate có:

- SHA khớp;
- summary phù hợp;
- symbol map hợp lệ;
- scope hợp lệ;

thì đọc trực tiếp symbol, không tìm lại.

### Bước 2 — hybrid retrieval một lần

Một lần retrieval trả về top-N:

```text
N = 8 file candidates
N = 12 symbol candidates
```

### Bước 3 — graph expansion giới hạn

Chỉ mở rộng:

- tối đa 1-hop;
- tối đa 3 test candidates;
- tối đa 2 contract/schema candidates.

### Bước 4 — dừng khi đạt coverage

Dừng khi:

```text
mọi AC đều có ít nhất 1 candidate logic
và
mọi AC quan trọng có ít nhất 1 candidate test/verification
và
confidence trung bình >= threshold
```

Ví dụ:

```text
high confidence: >= 0.82
medium confidence: 0.65–0.81
low confidence: < 0.65
```

Nếu đạt `high` hoặc `medium` đủ coverage thì **không được tìm thêm chỉ để tăng số file**.

---

## 8. Vai trò của AM, SE, RV và Coder

### AM

- tạo semantic summary từ plan/outcome;
- lưu candidate/evidence vào kho AM;
- chia sẻ cho SE/RV qua `plan_id`/`handoff_id`;
- không tự sửa code.

### SE

- đọc kho AM trước;
- dùng candidate hiện có;
- bổ sung candidate nếu thiếu;
- sau khi sửa, cập nhật summary/SHA và changed paths.

### RV

- đọc kho AM + SE;
- tập trung changed paths, AC và verification;
- không mở rộng toàn repo nếu evidence đã đủ;
- lưu review evidence vào kho RV.

### Coder

- dùng kho ticket riêng;
- được kế thừa evidence kiến trúc trong phạm vi ticket;
- mọi candidate phải lọc qua `allowed_file_paths`/`allowed_prefixes`.

---

## 9. Candidate không phải manifest bắt buộc

Điểm này cần giữ rõ:

- Candidate là **gợi ý có xếp hạng**.
- Không phải mọi candidate đều phải sửa.
- Coder/SE được chọn giải pháp khác nếu evidence cho thấy đúng hơn.
- Nhưng mỗi AC phải có coverage evidence.
- Nếu bỏ candidate top-ranked, cần có lý do trong report hoặc verification evidence.

Như vậy không khóa implementation vô lý nhưng vẫn giữ được chất lượng tìm kiếm.

## 10. Kiến trúc đề xuất

```text
SemanticQueryBuilder
  ├─ PlanOutcomeNormalizer
  ├─ TicketIntentExtractor
  ├─ AcceptanceCriteriaDecomposer
  └─ ConstraintExtractor

SemanticSummaryIndex
  ├─ file summaries
  ├─ symbol summaries
  ├─ test summaries
  ├─ contract summaries
  └─ embedding vectors

CandidateRetriever
  ├─ evidence cache lookup
  ├─ lexical retrieval
  ├─ embedding retrieval
  ├─ graph expansion
  └─ scope filtering

CandidateReranker
  ├─ AC coverage
  ├─ dependency relevance
  ├─ freshness
  ├─ role/scope
  └─ confidence

CandidateEvidenceStore
  ├─ per-agent store
  ├─ cross-role handoff pool
  ├─ SHA validation
  └─ source metadata receipts
```

## Kết luận

Candidate tốt nhất không phải là:

> “Tìm mọi file có từ khóa giống title.”

Mà là:

> **Chuẩn hóa request/plan outcome/ticket thành intent và AC; truy vấn embedding summary + lexical identifiers; lọc theo scope; mở rộng dependency graph tối thiểu; dùng lại evidence fresh; dừng khi AC coverage đủ.**

Đây là cách để Forge tìm **ít file hơn nhưng đúng hơn**, đồng thời dùng được thống nhất cho:

```text
Owner request
→ AM plan outcome
→ SE critique/implementation
→ RV review
→ Coder ticket
```

Hiện tại tôi có evidence về `implementation-autonomy`, nhưng **chưa có bằng chứng repo rằng lớp semantic candidate/embedding retrieval này đã được triển khai hoàn chỉnh**. Vì vậy nên xem đây là kiến trúc đề xuất, chưa phải runtime capability đã xác minh.
