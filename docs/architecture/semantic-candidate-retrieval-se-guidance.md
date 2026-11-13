# Hướng dẫn tiếp theo cho SE — Semantic & Code-Graph Candidate Retrieval

**Trạng thái:** Implemented foundation — Open Findings — Pending SE Repair and RV Re-review  
**Mục đích:** Hướng dẫn SE khép các finding còn mở, không phải approval, không phải mutable-file manifest và không thay thế Reviewer gate.

## 1. Kết luận hiện tại

Nền tảng semantic retrieval đã có:

- purpose-summary-v2 và checksum cho summary/symbol;
- embedding worker và embedding store có kiểm tra stale checksum;
- query gồm title, objective, acceptance criteria và guardrails;
- hybrid scoring giữa lexical, semantic, dependency graph và matched symbols;
- Reviewer snapshot selector đọc từ committed source;
- candidate source receipt kiểm tra live bytes, SHA-256, symbol_map, scope và freshness;
- evidence persistence được tách khỏi receipt verification.

Tuy nhiên chưa được gọi là “đã chuẩn hơn” hoặc “Forge đã tự học ngữ nghĩa dự án”, vì các bằng chứng đánh giá và handoff còn thiếu. Hai file golden-query hiện vẫn là placeholder/không có dữ liệu đánh giá hữu ích:

- `vocabulary/semantic-evaluation/golden-queries.jsonl`
- `vocabulary/semantic-anchors.jsonl`

`semantic-knowledge.js` đã có validator, deduplication, stale/cross-project rejection và bounded reranking, nhưng chưa có bộ record được Reviewer/Owner/test xác nhận đủ để chứng minh cải thiện ranking.

## 2. Nguyên tắc bắt buộc

1. **Không tin metadata từ index hoặc model.** Candidate phải được xác minh bằng source bytes hiện hành.
2. **Tách hai loại receipt:**
   - relevance: score, lexical/semantic/graph reasons, matched symbols, AC/intent coverage, rank/confidence;
   - provenance: path, SHA-256, symbol_map, graph metadata, freshness, scope, execution identity và source revision.
3. **Receipt không phải proof business correctness.** AC coverage và solution correctness vẫn cần test, evidence hoặc RV độc lập.
4. **Không dùng `.forge/runtime` làm source of truth portable.** Runtime DB, embedding cache và evidence runtime phải rebuild được; knowledge đã được duyệt phải nằm trong artifact project-tracked.
5. **Không nới quyền.** Candidate retrieval không được mở rộng allowed paths, immutable scope, direct-code restriction, mutable-file budget hoặc Reviewer snapshot.
6. **Evidence-first, stop sau symbolic read.** Chỉ discovery lại khi evidence stale, thiếu coverage, Read(symbol) thất bại hoặc scope chưa rõ.

## 3. Thứ tự sửa bắt buộc

### Bước A — Chốt receipt contract và serialization

Sửa/kiểm tra:

- `backend/src/tools/discovery/candidate-source-receipts.js`
- `backend/src/tools/discovery/select-code-graph-candidates.js`
- `backend/src/tools/discovery/subagent-evidence-sync.js`
- `backend/src/tools/discovery/subagent-evidence-store.js`

Yêu cầu:

- `registerCandidateSources` xử lý giống nhau cho live candidate và ticket-cached candidate;
- candidate verified có live SHA-256, symbol_map, freshness và scope;
- evidence store lưu relevance receipt và provenance receipt riêng nhưng cùng correlation identity;
- persistence failure trả trạng thái rõ ràng, không biến receipt verified thành evidence recorded giả;
- nếu candidate qua JSON/IPC/worker serialization, metadata vẫn được xác định bằng Node-issued receipt identity hoặc synchronization phải hoàn tất trước boundary đó;
- không dùng object identity WeakMap đơn độc cho dữ liệu phải đi qua transport boundary.

### Bước B — Bổ sung mixed-batch và negative tests

Một lần gọi candidate phải kiểm tra đồng thời:

- một file verified/fresh;
- một file stale;
- một file unauthorized hoặc scope bị revoke;
- một file unreadable/parser failure;
- một persistence failure.

Assert cho từng entry:

- `receipt.status` độc lập với `evidence.status`;
- chỉ entry verified cập nhật `active_file_checksums`;
- entry unavailable không được persist và không được phép `Read(symbol)`;
- persistence failure giữ nguyên provenance receipt nhưng báo `durable: false`/`failed`;
- serialized round-trip không làm mất receipt hợp lệ.

Các test chính:

- `backend/tests/tools/candidate-source-receipts.test.js`
- `backend/tests/tools/candidate-source-authority.test.js`
- `backend/tests/tools/select-code-graph-candidates.test.js`

### Bước C — Khép capability matrix

Đối chiếu definition, implementation, capability và request filtering cho:

- AM, SE, SL, RV và Coder;
- owner conversation, planning và explorer mode;
- Claude, Codex, Anthropic/Ollama function-calling;
- sender-worker, production-runtime và SDK ticket executors;
- direct-code, immutable baseline, missing capability và missing implementation.

Không duy trì danh sách capability legacy tách khỏi canonical engineering catalog. Mọi negative case phải fail closed và trả lỗi có cấu trúc, không chỉ làm tool biến mất im lặng.

Các vùng cần đối chiếu:

- `backend/src/tools/engineering-tool-catalog.js`
- `backend/src/tools/engineering-tool-binding.js`
- `backend/src/tools/roles/owner-role-tool-policy.js`
- `backend/src/tools/roles/owner-conversation-tools.js`
- `backend/src/modules/supervisor/sender-worker.js`
- `backend/src/modules/supervisor/production-runtime.js`
- `backend/src/modules/supervisor/nodeforge-task-executors.js`
- `backend/src/modules/supervisor/function-calling-task-executor.js`

### Bước D — Bảo vệ Reviewer snapshot

Reviewer phải dùng duy nhất `review_commit_sha`:

- candidate ranking;
- source bytes;
- symbol extraction;
- SHA-256 và receipt;
- evidence handoff.

Bổ sung regression có:

1. file đã sửa unstaged trong working tree nhưng tồn tại ở committed snapshot;
2. file untracked có lexical score cao;
3. live index trả candidate ngoài snapshot;
4. candidate serialized từ role khác được revalidate và mint receipt mới theo pinned source.

Assert rằng file live/untracked không xuất hiện trong candidate hoặc receipt của RV.

Các vùng chính:

- `backend/src/modules/supervisor/review/reviewer-snapshot-candidate-selector.js`
- `backend/src/modules/supervisor/review/reviewer-committed-source.js`
- `backend/src/modules/supervisor/review/reviewer-forge-tools.js`
- `backend/src/modules/supervisor/review/review-worker.js`

### Bước E — Tạo golden-query baseline thật

Tạo dữ liệu project-tracked, không dùng runtime-only:

- query source/title/objective;
- acceptance criteria và guardrails;
- expected path-symbol pairs;
- acceptable alternatives;
- known false positives;
- source revision và SHA;
- verifier provenance.

Chạy baseline trước khi bật feedback/reranking. Báo cáo tối thiểu:

- Precision@K;
- Recall@K;
- symbol-hit rate;
- AC coverage;
- false-positive rate;
- stale rejection;
- unauthorized rejection;
- live/cache parity.

Không tự gắn nhãn candidate đúng từ semantic score, model output hoặc candidate self-report.

### Bước F — Bật semantic knowledge có kiểm soát

Chỉ record có provenance hợp lệ và verifier được phép mới ảnh hưởng ranking. Validator phải loại hoặc quarantine:

- malformed JSONL;
- duplicate fingerprint;
- thiếu project identity;
- path ngoài project;
- SHA/revision stale hoặc mismatch;
- record cross-project;
- status không hỗ trợ;
- feedback chưa được xác minh.

Reranking phải bounded, deterministic, explainable và fallback về baseline khi knowledge thiếu hoặc invalid. Không để knowledge thay thế scope, freshness, receipt, symbolic-read hoặc Reviewer gate.

### Bước G — Chứng minh retrieval stop policy

Thêm test/state assertion cho chuỗi:

1. `read_subagent_evidence` trả evidence fresh;
2. candidate receipt hợp lệ;
3. `Read(symbol)` thành công;
4. coverage đạt yêu cầu;
5. không gọi discovery tự động lần nữa.

Các trường hợp được phép tiếp tục:

- evidence stale hoặc checksum drift;
- symbol không còn tồn tại;
- thiếu path/symbol/AC coverage;
- scope hoặc authorization chưa xác định;
- snapshot không khớp.

## 4. Handoff AM → SE → RV cần chứng minh

Tạo một integration test hoặc runtime harness được governance cho phép, không chỉ fixture nội bộ:

1. AM session gọi candidate discovery và nhận receipt verified.
2. SE session đọc durable evidence, không dùng metadata do agent tự gửi.
3. SE thực hiện `Read(symbol)` với cùng path/SHA/symbol_map.
4. RV session đọc hoặc revalidate trên committed snapshot.
5. Assert cùng source identity, freshness, scope, revision và provenance.
6. Assert stale/unauthorized/persistence-failure đều không vượt gate.

Nếu chưa chạy được live session, báo rõ là **fixture-only**, không gọi là live handoff acceptance.

## 5. Verification và gửi lại RV

Trước khi yêu cầu RV:

- tạo commit sạch chỉ chứa source/test/docs thuộc finding;
- loại `.forge/runtime/**`, SQLite sidecars, `.next/**`, reports và evidence stores khỏi commit;
- ghi exact commit SHA và base SHA;
- ghi changed-path manifest và checksum từng file;
- chạy focused tests, lint và các regression mới trên revision đã commit;
- lưu verification artifact với test scope, kết quả và giới hạn môi trường;
- nêu rõ nếu chưa có dependency/toolchain isolation manifest.

SE completion report phải có:

1. exact commit/base SHA;
2. changed paths;
3. test commands và outcomes;
4. O1-A đến O1-D;
5. O2-A đến O2-D;
6. retrieval-stop assertions;
7. golden-query baseline/metrics;
8. verification artifact ID/checksum;
9. limitations và residual risks.

**Không báo `Accepted/Closed` cho đến khi RV review độc lập trên exact committed revision.**