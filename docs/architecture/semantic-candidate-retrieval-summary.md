# Semantic & Candidate Retrieval — Tổng hợp trao đổi

## 1. Mục đích

Forge cần tìm tập nhỏ các file và symbol liên quan nhất từ owner request, plan outcome, ticket, SE critique hoặc RV review. Candidate Retrieval phục vụ AM, SE, RV, SL và Coder nhưng không thay thế quyền truy cập, việc đọc source, kiểm thử hoặc review độc lập.

Mục tiêu đúng là:

> Tìm candidate có xếp hạng, giải thích được và kiểm chứng được; không tuyên bố candidate đứng đầu luôn là code đúng về nghiệp vụ.

## 2. Một Semantic của source code là gì?

Semantic hiện tại gắn với symbol có purpose summary (function, method, class hoặc symbol được parser nhận diện), không nhúng toàn bộ source file thô.

Nguồn nội dung là purpose comment trong source code, thường mô tả business purpose và technical description. Indexer lưu summary cùng metadata symbol. Khi có đủ định danh, `purposeSummaryInput` chuẩn hóa nội dung theo dạng:

```text
[filePath :: symbolName (symbolKind)] summary
```

ONNX provider dùng Nomic `Xenova/nomic-embed-text-v1.5` với prefix `search_document:` và tạo vector 768 chiều đã chuẩn hóa. Checksum dùng tiền tố `purpose-summary-v2:sha256:<hex>`.

Một semantic record gồm, về mặt logic:

- `symbol_id`;
- model embedding;
- vector 768 chiều;
- `content_checksum`;
- path, name, kind, line range và summary khi truy vấn kết hợp các bảng index.

## 3. Semantic được lưu ở đâu và chuyển máy thế nào?

Vector runtime hiện lưu trong bảng `symbol_embeddings` của SQLite index tại:

```text
<project-root>/.forge/runtime/wc/index.db
```

Bảng này là runtime cache/rebuildable index, không phải nguồn tri thức duy nhất. `files` và `symbols` lưu metadata/summary; `embedding_jobs` điều phối việc tạo lại vector.

`.forge/runtime/` không nên được xem là artifact cần commit lên Git. Khi clone sang máy hoặc VPS mới:

1. source code và purpose comments đi theo Git;
2. parser dựng lại files/symbols/code graph;
3. startup/worker phát hiện vector thiếu hoặc checksum lệch;
4. ONNX chạy local để tạo lại vector;
5. không cần gọi LLM/Claude API để tái tạo vector.

Trong giai đoạn rebuild, lexical search và code graph có thể là fallback nếu runtime cho phép. Điều này chỉ nói về khả năng tái tạo semantic từ source, không nói rằng kinh nghiệm phát sinh trong quá trình chạy được tái tạo.

## 4. Semantic Query là gì?

Semantic Query là context truy vấn lúc chạy, không phải một semantic source record cố định. Dạng khái niệm đã thảo luận:

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

Trong runtime, tool hợp nhất input của agent với `context.task_context`, execution scope, identity và evidence scope. `selectWithEmbeddings` tạo query text từ title, objective, query, AC và guardrails rồi dùng ONNX với prefix `search_query:`. Query vector chủ yếu sống trong RAM trong lượt tìm kiếm; không nên nhầm nó với vector document đã lưu trong `symbol_embeddings`.

Nguồn gốc của các trường có thể là plan/ticket/conversation/checkpoint và execution context. Cần phân biệt fact đã xác minh với context do agent đề xuất; path, SHA, symbol map và scope phải do Node/file service/index xác thực.

## 5. Candidate Retrieval hiện tổng hợp những tín hiệu nào?

Các tín hiệu đã có trong lõi retrieval hoặc contract hiện hành:

- **Semantic similarity:** cosine similarity giữa query vector và vector symbol;
- **Lexical match:** token, identifier, error code, route, schema và nội dung index/FTS;
- **Dependency relation:** imports, imported-by, calls và graph expansion có giới hạn;
- **`matched_symbols`:** symbol_id, name, kind, line range, score và summary; embedding store giữ tối đa một nhóm symbol tốt nhất cho mỗi file;
- **AC/intent/guardrails:** được đưa vào query và lexical input để tăng mức phù hợp;
- **SHA-256:** xác minh tính toàn vẹn và phát hiện source stale;
- **Freshness:** đối chiếu index/evidence với source hiện hành;
- **Scope:** `allowed_file_paths`, `allowed_prefixes`, execution scope và reviewer source boundary.

Kết quả candidate là ranking/recommendation. `score` hoặc `confidence` không phải bằng chứng candidate đã đáp ứng AC.

## 6. Hai loại receipt phải tách riêng

### 6.1. Semantic Candidate Receipt — relevance

Cho biết candidate được chọn vì lý do gì: query source, context, AC, intent, score, reasons, matched symbols, freshness và search plan.

### 6.2. Subagent/Source Receipt — provenance

Cho biết file được quan sát từ đâu: execution/agent/delegation, tool, thời điểm, scope, SHA, total lines, symbol map, code graph và symbols read.

Một candidate có thể có relevance receipt nhưng chưa có provenance receipt nếu chỉ lấy từ embedding/index. Một subagent có thể tạo provenance receipt mà chưa tạo candidate receipt. Chỉ khi hai receipt độc lập đều hợp lệ, cùng scope và SHA còn fresh thì mới có cơ sở mạnh để tái sử dụng evidence.

`receipt_valid` cũng không có nghĩa là `solution_verified`.

## 7. Luồng retrieval an toàn

1. Đọc `read_subagent_evidence({})` trước và dùng lại entry còn fresh.
2. Gọi `select_code_graph_candidates` khi coverage chưa đủ.
3. Node kiểm tra scope, source metadata, SHA hiện hành và symbol map.
4. Chỉ khi receipt source hợp lệ mới dùng `Read({ file_path, symbol })` theo symbol map.
5. Hợp nhất relevance receipt và provenance vào evidence store nếu các thao tác riêng lẻ thành công.
6. Dừng discovery không cần thiết khi receipt còn fresh, symbolic read hợp lệ và AC coverage đủ.
7. Nếu stale, thiếu coverage hoặc fallback có lý do thì tiếp tục discovery trong scope; stop policy không được là khóa cứng mọi lượt tìm kiếm.

Candidate không phải mutable-file manifest. Agent/SE/Coder có thể chọn giải pháp khác nếu evidence chứng minh phù hợp hơn, nhưng không được vượt scope hoặc giảm AC đã khóa.

## 8. O1–O4 và đánh giá hiện trạng

### O1 — Automated Evidence Receipt and Sync

Phạm vi gồm live retrieval và ticket-cache: xác minh path, SHA hiện hành, symbol map; đăng ký source receipt; đồng bộ durable evidence; cập nhật `active_file_checksums` chỉ cho candidate đã xác thực.

Các lỗi từng được phát hiện gồm import/chữ ký receipt sai, cache return sớm, whitelist evidence thiếu candidate tool và catch nuốt lỗi. Các commit/repair sau đó đã thêm các seam như candidate source receipt, `receive`, và đồng bộ candidate vào evidence flow. Tuy nhiên không nên kết luận “đã hoàn tất” chỉ từ việc tool gọi thành công; cần test xác minh thành công, stale, metadata thiếu và durability failure.

### O2 — Role-wide Accessibility and Stop Policy

Phải kiểm tra toàn chuỗi:

```text
definition → implementation → capability → request filter → reviewer registry
```

cho AM, SE, RV, SL và Coder, theo runtime/provider. Mở quyền không được nới `direct_code`, immutable scope, allowed paths/prefixes hoặc snapshot review boundary. Test phủ định quyền Coder/Reviewer phải được cập nhật cùng test được phép.

### O3/O4 không thay đổi O1/O2

O1/O2 tập trung vào candidate receipts, evidence, role access và stop policy. Chúng không tự tạo feedback learning, golden dataset hay domain model.

## 9. Forge có biết agent chọn sai code không?

Không chỉ từ embedding score. Forge có thể biết candidate stale/unauthorized hoặc metadata không hợp lệ; đó là lỗi evidence, không phải kết luận nghiệp vụ.

Để kết luận candidate sai/đúng cần tín hiệu như:

- test hoặc verification;
- AC coverage evidence;
- Reviewer xác nhận;
- SE report hoặc Owner feedback;
- agent phải tìm đúng implementation khác sau khi đọc candidate;
- execution path cho thấy candidate không thực hiện behavior yêu cầu.

Nên phân biệt:

```text
candidate → receipt_valid → read_verified → ac_covered → solution_verified
```

## 10. Tự học ngữ nghĩa dự án và tính di động

Semantic source vector tái tạo được từ code. Kinh nghiệm phát sinh sau nhiều ticket (candidate đúng/sai, domain anchor, golden query) không tự tái tạo được từ code nếu chỉ lưu trong `.forge/runtime/wc/index.db`.

Nếu triển khai feedback learning, tri thức đã được Reviewer/verification xác nhận nên có nguồn project-tracked, ví dụ:

```text
<project-root>/vocabulary/
  glossary.md
  retrieval-feedback.jsonl
  semantic-anchors.jsonl
```

Mỗi dòng JSONL cần có query fingerprint, source context, path/symbol, SHA, nhãn, lý do, correct alternatives và provenance xác nhận. Loader theo project có thể nạp các dòng này vào RAM hoặc index runtime trên máy mới. Không được coi các file JSONL này là capability hiện có cho tới khi có schema, loader, scoring integration, deduplication, validation và clone/deploy test.

Các project khác phải có knowledge namespace riêng; không trộn feedback giữa project A và project B. Forge framework có thể dùng chung, nhưng code graph, embeddings, evidence và project knowledge phải được cô lập theo project.

## 11. Giai đoạn tiếp theo được khuyến nghị

Sau O1–O4, không nên nhảy ngay tới “self-healing”. Nên làm **Candidate Accuracy & Evaluation** trước:

- tạo golden queries/fixtures có expected symbols/files và acceptable alternatives;
- đo Precision@K, Recall@K, symbol-hit rate, AC coverage và false-positive rate;
- đo stale/unauthorized rejection;
- kiểm tra cả live retrieval, ticket cache, role/provider và snapshot review;
- lưu feedback chỉ sau khi Reviewer/test/Owner xác nhận;
- sau khi có số đo ổn định mới tích hợp retrieval-feedback và semantic anchors vào scoring.

## 12. Kết luận

1. Semantic source và candidate ranking đã có nền tảng runtime: ONNX, lexical, graph, matched symbols, checksum, freshness và scope.
2. `.forge/runtime` là cache/index tái tạo được, không phải nơi phù hợp để lưu kinh nghiệm dự án lâu dài.
3. Candidate receipt và subagent receipt là hai bằng chứng khác nhau, phải giữ riêng nhưng liên kết bằng path, SHA và context.
4. Receipt hợp lệ không chứng minh solution đúng; score cao không chứng minh AC đã đạt.
5. O1–O4 chỉ được gọi là khép kín sau khi có verification trực tiếp cho live/cache, receipt/evidence failure, role/provider gates và AM → SE → RV handoff.
6. Tri thức học được cần một giai đoạn project-tracked JSONL riêng, kèm validation và Reviewer provenance, nếu mục tiêu là chuyển máy mà không học lại.
