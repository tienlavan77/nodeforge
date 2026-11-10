# Quan hệ giữa Subagent Receipt và Semantic Candidate Receipt

## 1. Bối cảnh

Trong quá trình xây dựng Forge, hai nhu cầu xuất hiện đồng thời:

1. **Semantic Candidate Retrieval:** từ Forge request, plan outcome, ticket objective, acceptance criteria (AC), guardrails hoặc yêu cầu review, tìm ra ít file và symbol liên quan nhất.
2. **Subagent Discovery:** giao cho subagent khảo sát repository bằng các tool read-only để parent không phải tự quét lại toàn bộ code.

Cả hai cơ chế đều tạo evidence về repository, nhưng chúng trả lời hai câu hỏi khác nhau. Chúng cần được liên kết trong một Evidence Store chung, không nên bị xem là hai loại dữ liệu hoàn toàn độc lập hoặc bị trộn lẫn thành một trường duy nhất.

## 2. Hai loại receipt

### 2.1. Subagent / Delegation Receipt — provenance

Subagent receipt chứng minh **evidence đến từ đâu**:

- parent execution / agent ID;
- delegation ID, task ID và child execution ID;
- role/provider/model của worker nếu được phép ghi nhận;
- tool đã dùng (`search_tree`, `list_files`, `search_text`, `read_file`, `Read`, Git read-only);
- thời điểm quan sát;
- phạm vi path và execution scope;
- trạng thái read-only và kết quả task;
- file đã quan sát, SHA-256, `total_lines`, `symbol_map`, `code_graph`, `symbols_read`;
- `fallback_to_parent`, lỗi provider hoặc kết quả chưa xác định nếu có.

Nó trả lời:

> “Ai đã quan sát file này, trong delegation nào, bằng công cụ nào, và evidence đó có nguồn gốc hợp lệ không?”

Receipt này là cơ sở cho provenance, audit, scope enforcement và ngăn agent bịa rằng subagent đã khảo sát.

### 2.2. Semantic Candidate Receipt — relevance

Candidate receipt chứng minh **vì sao file hoặc symbol được chọn**:

- semantic query source (`owner_request`, `plan_outcome`, `ticket`, `se_critique`, `rv_review`, ...);
- `plan_id`, `handoff_id`, `ticket_id`, role và execution context;
- title, objective, query, AC và guardrails đã chuẩn hóa;
- intent hoặc domain terms được trích xuất;
- `matched_ac`, `matched_intents`;
- điểm semantic embedding, lexical, dependency graph và evidence reuse;
- score tổng hợp, confidence và reasons;
- `matched_symbols`, symbol summary, test/contract liên quan;
- `search_plan`, graph expansion và điều kiện dừng tìm kiếm;
- SHA-256 và freshness của candidate tại thời điểm chọn.

Nó trả lời:

> “File/symbol này được chọn vì AC, intent hoặc dependency nào, mức tin cậy bao nhiêu, và có cần tìm thêm không?”

Candidate receipt là cơ sở cho semantic ranking, AC coverage, giải thích kết quả và retrieval stop policy.

## 3. Quan hệ giữa hai receipt

Hai receipt có quan hệ **provenance + relevance**:

```text
Forge request / Plan outcome / Ticket / Review input
                         │
                         ▼
              Semantic Candidate Retrieval
                         │
       candidate receipt: score, AC, intent, reasons
                         │
                         ▼
                file / symbol candidates
                         │
       ┌─────────────────┴─────────────────┐
       │                                   │
       ▼                                   ▼
Parent đọc candidate trực tiếp       Parent delegate subagent
                                       khảo sát read-only
       │                                   │
       └───────────────┬───────────────────┘
                       ▼
             Durable Evidence Store
       provenance receipt + candidate receipt
                       │
                       ▼
     Read/Read symbol/edit trong scope, không tìm lại
```

Một file có thể có candidate receipt nhưng chưa có subagent receipt nếu file chỉ được lấy từ embedding/index. Ngược lại, một file có thể có subagent receipt nhưng chưa có candidate receipt nếu child chỉ khảo sát theo một nhiệm vụ đọc hiểu chung. Khi cả hai cùng tồn tại và SHA còn fresh, evidence có cả:

- **nguồn gốc đáng tin cậy** từ subagent receipt;
- **lý do phù hợp với yêu cầu** từ candidate receipt.

Vì vậy hai receipt **liên kết với nhau**, nhưng không phải là cùng một receipt.

## 4. Mô hình dữ liệu hợp nhất đề xuất

Evidence entry nên giữ các phần tách biệt sau:

```js
{
  path: "backend/src/...",
  sha256: "sha256:<64 hex>",
  total_lines: 120,
  symbol_map: [],
  code_graph: {},
  freshness: {
    status: "fresh",
    verified_at: "..."
  },
  provenance: {
    delegation_id: "...",
    parent_execution_id: "...",
    child_execution_id: "...",
    source_worker_id: "...",
    source_tools: ["read_file", "Read"],
    observed_at: "...",
    read_only_enforced: true
  },
  relevance: {
    retrieval_id: "...",
    source: "ticket | plan_outcome | se_critique | rv_review",
    matched_ac: ["AC1"],
    matched_intents: ["checkpoint recovery"],
    matched_symbols: [],
    score: 0.94,
    confidence: "high",
    reasons: ["semantic_embedding", "lexical_identifier"]
  }
}
```

Không được để parent tự cung cấp hoặc giả mạo `sha256`, `symbol_map`, provenance hay freshness. Các metadata này phải đến từ discovery/index/file service được xác thực; `recordSourceMetadata` phải giữ nguyên nguyên tắc chỉ ghi metadata đã được hệ thống cấp.

## 5. Luồng xử lý chuẩn

### Bước 0 — Đọc evidence hiện có

Parent gọi `read_subagent_evidence({})` trước khi tìm mới. Nếu entry có SHA hiện hành, symbol map hợp lệ và scope phù hợp, parent dùng lại entry đó.

### Bước 1 — Candidate retrieval

Khi chưa đủ coverage, gọi `select_code_graph_candidates` với:

```js
{
  query,
  title,
  objective,
  acceptance_criteria,
  guardrails,
  limit
}
```

Tool trả candidate kèm `matched_symbols`, score, confidence, reasons, AC coverage và freshness. Candidate retrieval có thể tạo hoặc cập nhật **relevance receipt**; nó không được tự nhận rằng parent/subagent đã đọc source nếu chưa có provenance evidence.

### Bước 2 — Delegated discovery

Khi policy yêu cầu parent phải delegate discovery, parent gọi `delegate_subagent` với tối đa số task được policy cho phép. Child chỉ dùng tool read-only, không sửa code, không chạy command, không commit và không delegate tiếp. Child ghi **provenance receipt** cho từng file quan sát.

Với hướng async:

```text
delegate_subagent
  → trả delegation_id/status ngay
  → child chạy nền
  → parent làm việc độc lập
  → get status / read_subagent_evidence(delegation_id)
  → hợp nhất provenance vào evidence store
```

### Bước 3 — Hợp nhất evidence

Evidence Store ghép candidate receipt với subagent receipt theo các khóa phù hợp:

- `path`;
- SHA-256;
- `conversation_id` / `execution_id`;
- `plan_id`, `handoff_id`, `ticket_id`;
- `delegation_id` hoặc `retrieval_id`.

Nếu SHA khác nhau, entry cũ phải bị đánh dấu stale; không gộp mù hoặc dùng candidate receipt cũ như bằng chứng source hiện hành.

### Bước 4 — Đọc và thực thi

Khi evidence fresh và scope hợp lệ:

- parent có thể gọi `Read({ file_path, symbol })` trực tiếp bằng `symbol_map` đã được cấp;
- Coder chỉ dùng file nằm trong `allowed_file_paths` / `allowed_prefixes`;
- `edit_diff` vẫn phải kiểm tra checksum hiện hành;
- candidate chỉ là gợi ý xếp hạng, không phải mutable-file manifest bắt buộc.

## 6. Enforcement và fallback

Prompt/README chỉ hướng dẫn; muốn bắt buộc parent delegate, runtime governance phải chặn exploration trực tiếp khi chưa có delegation receipt hợp lệ. Các tool broad discovery có thể gồm `search_tree`, `list_files`, `search_text`, `select_code_graph_candidates` và read-only Git tools; `read_file`/`Read` có thể được miễn nếu file đã có evidence fresh hoặc thuộc ngoại lệ được policy cho phép.

Không được tạo delegation giả hoặc task rỗng để vượt policy. Receipt phải chứng minh:

- delegation cùng execution/conversation;
- objective và scope thực tế;
- child đang chạy hoặc đã hoàn tất;
- read-only enforcement;
- file observation hợp lệ.

Nếu provider/model thất bại, hệ thống trả `fallback_to_parent: true` cùng lý do và trạng thái chưa xác định. Parent được tự discovery theo policy, nhưng phải ghi fallback; không được ghi provenance như thể child đã thành công.

Lỗi ghi Evidence Store hoặc receipt không được biến thành evidence fresh giả. Tùy contract, hệ thống có thể trả candidate kèm cảnh báo durability hoặc dừng thao tác mutation; mọi lỗi phải có telemetry và verification.

## 7. Phân quyền theo role

- **AM:** tạo query từ plan outcome, lưu candidate relevance và chia sẻ cho SE/RV; không tự sửa code.
- **SE:** đọc evidence AM trước, delegate hoặc bổ sung discovery khi coverage thiếu, cập nhật provenance và candidate evidence sau implementation.
- **RV:** dùng candidate receipt để kiểm tra AC coverage và subagent receipt để xác minh nguồn evidence/changed paths; review độc lập vẫn bắt buộc.
- **SL:** dùng relevance để phân rã outcome/ticket, nhưng candidate không khóa số lượng hoặc manifest ticket nếu Owner/Architecture chưa khóa.
- **Coder:** kế thừa evidence trong phạm vi ticket; mọi candidate phải qua scope filter và checksum gate.

## 8. Những điều không nên làm

- Không coi candidate receipt là bằng chứng rằng source đã được đọc.
- Không coi subagent receipt là bằng chứng rằng file phù hợp với AC.
- Không gộp provenance và relevance thành một chuỗi không thể kiểm tra.
- Không tin SHA hoặc symbol map do model tự nhập.
- Không dùng evidence stale để gọi `Read` hoặc sửa code.
- Không bắt child delegate tiếp hoặc cho child mutation tool.
- Không bắt parent gọi subagent lại khi evidence fresh, scope đúng và coverage đã đủ; điều đó làm tăng overhead mà không tăng độ tin cậy.
- Không để `recordSourceMetadata` tự động ghi receipt cho candidate nếu metadata chưa được hệ thống xác minh.

## 9. Kết luận

Subagent receipt là **hộ chiếu provenance**; Semantic Candidate receipt là **hồ sơ relevance**. Chúng liên kết tại Evidence Store bằng path, SHA, context và identity, nhưng phải giữ hai vai trò riêng:

> **Candidate receipt cho biết nên đọc file nào và vì sao; subagent receipt chứng minh ai đã đọc hoặc quan sát file đó và bằng cách nào.**

Khi cả hai receipt đều fresh, đúng scope và được liên kết hợp lệ, Forge có thể giảm số lượt tìm kiếm, cho phép parent đọc đúng symbol, chia sẻ evidence giữa `AM ↔ SE ↔ RV`, và vẫn giữ được auditability, freshness, security cùng khả năng fallback.
