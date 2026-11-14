# Hướng dẫn code cho SE — hoàn thiện Semantic & Candidate Retrieval

**Trạng thái:** Open findings — implementation guidance — chưa phải approval và không thay thế Reviewer gate.

**Đối tượng:** System Engineer (SE), dưới handoff của Sprint Leader và Architecture Manager.

**Revision đang cần đối chiếu:** `4a6741ce88610ff66e19d0cdaae2d7c9f2190928`

## 1. Kết luận và giới hạn hiện tại

Nền tảng candidate retrieval đã có source validation, SHA-256, `symbol_map`, lexical/semantic/graph scoring, live và ticket-cached paths, receipt synchronization và semantic-knowledge loader/reranker. Tuy nhiên chưa được coi là hoàn tất vì:

- knowledge records hiện được bind với revision khác với revision đang review, nên có thể bị loại là stale trước khi reranking;
- chưa có evaluation artifact thực tế chứa baseline/reranked metrics và provenance đầy đủ;
- chưa có governed verification artifact chứng minh exact commit, changed-path manifest, source ledger và per-file checksums;
- cần xác minh riêng workspace/commit không chứa runtime/generated artifacts.

Không dùng candidate score, receipt verified, test fixture hoặc knowledge record tự khai báo làm proof của business correctness.

## 2. Quy tắc không được phá

1. Không nới `allowed_file_paths`, `allowed_prefixes`, ticket scope, immutable scope, `direct_code` restriction hoặc mutable-file budget.
2. Không tin `sha256`, `symbol_map`, `fresh`, `receipt.status` hoặc source revision do index/model/caller gửi nếu chưa revalidate từ source phù hợp.
3. Tách ba lớp bằng chứng:
   - **relevance:** score, semantic/lexical/graph signals, relations, matched symbols, AC/intent, reasons và confidence;
   - **provenance:** path, source bytes, SHA-256, symbol map, source revision, freshness và scope;
   - **execution/persistence:** receipt identity, execution context, transport lineage và durable status.
4. `receipt.status = verified` không có nghĩa evidence đã durable và không chứng minh agent đã đọc symbol.
5. `.forge/runtime/**`, SQLite sidecars, `.next/**`, evidence stores và generated outputs không phải portable source of truth.
6. Không bỏ independent Reviewer gate. Reviewer phải dùng exact pinned source revision.

## 3. Thứ tự thực hiện

Thực hiện theo dependency:

```text
O1 receipt/evidence → O2 capability/snapshot/stop policy
                       ↘ O3 corpus/benchmark/portability → O4 reranking
```

Không bật knowledge adjustment hoặc báo candidate “chính xác hơn” trước khi O3 có corpus và baseline hợp lệ.

## 4. O1 — Receipt, identity và evidence synchronization

### 4.1 Receipt contract

Trong các file sau, giữ một contract dùng chung cho live và ticket-cached candidate:

- `backend/src/tools/discovery/candidate-source-receipts.js`
- `backend/src/tools/discovery/select-code-graph-candidates.js`
- `backend/src/tools/discovery/subagent-evidence-sync.js`
- `backend/src/tools/discovery/subagent-evidence-store.js`

Mỗi candidate verified phải có:

- Node-issued `receipt_id`/correlation identity;
- project và execution/delegation context;
- candidate identity không chỉ là path;
- path, live SHA-256, `symbol_map`, source revision khi có, freshness và scope verdict;
- relevance metadata riêng;
- evidence persistence status riêng: `recorded`, `failed` hoặc `not_recorded`.

Nếu candidate qua JSON/IPC/worker/provider boundary, chọn và chứng minh một thiết kế:

- đồng bộ evidence trước serialization; hoặc
- registry/revalidation theo Node-issued receipt ID sau boundary.

Payload tự mang `verified`, SHA hoặc `symbol_map` không đủ. Identity mất, hết hạn, sai execution context hoặc mismatch path/SHA/revision/scope phải fail-closed; không authorize `Read(symbol)`.

### 4.2 Active checksum semantics

`active_file_checksums` chỉ biểu thị source receipt/freshness authorization. Không dùng nó để suy ra durable evidence hoặc `symbols_read`.

Các trạng thái phải độc lập:

| Trường hợp | Source receipt | Evidence | Active checksum | Read(symbol) |
|---|---|---|---|---|
| fresh, authorized, readable | verified | recorded nếu persist thành công | có | được phép sau recheck |
| persistence failure | verified | failed, durable false | có | chỉ theo source receipt/scope |
| stale | unavailable/failed | not_recorded | không | từ chối |
| unauthorized/unreadable | unavailable/failed | not_recorded | không | từ chối |

Mixed-batch phải giữ diagnostic theo entry, không âm thầm biến batch thành danh sách authorized-only. Không trả caller path/metadata ngoài scope.

## 5. O2 — Capability, Reviewer snapshot và stop policy

Đối chiếu capability theo các chiều role × mode × provider × execution path × scope mode, tối thiểu qua:

- owner/planning/explorer và SDK/provider paths;
- `sender-worker`, task executor và production runtime;
- Reviewer Forge tools và pinned-source handoff;
- positive case, missing implementation/capability, `direct_code`, immutable baseline và out-of-scope negative cases.

Candidate retrieval không được mở rộng read/write authorization.

Reviewer phải tách hai điều kiện:

1. **Snapshot isolation:** ranking và source read chỉ dùng corpus của `review_commit_sha`; không fallback working tree, untracked file hoặc live index.
2. **Snapshot provenance:** từ pinned bytes, mint/revalidate SHA, symbol map, freshness, scope và receipt mới; serialized receipt của role khác không tự cấp quyền cho RV.

`matched_symbols` chỉ chứa symbol có matching semantics chứng minh được; không gán toàn bộ symbol map làm matched result nếu chưa có lý do.

Stop policy phải là decision/state có reason và side-effect assertion, không chỉ là `discoveryNotice`/`suggested_next_action`. Khi evidence fresh, scope hợp lệ, receipt verified, `Read(symbol)` thành công, AC/intent coverage đủ và không còn unresolved paths thì không gọi discovery/search fallback thêm. Khi stale, checksum drift, symbol read fail, coverage thiếu hoặc scope không rõ thì chỉ tiếp tục trong scope với reason/state rõ ràng hoặc structured refusal.

## 6. O3 — Golden corpus, validation và portability

### 6.1 Knowledge records

Các artifact project-tracked hiện cần kiểm tra:

- `vocabulary/semantic-evaluation/golden-queries.jsonl`
- `vocabulary/semantic-anchors.jsonl`
- `vocabulary/retrieval-feedback.jsonl`

Mỗi golden query cần query context, objective, AC, guardrails, expected path-symbol, alternatives, known false positives, project identity, source revision/SHA và verifier provenance. Dataset rỗng/placeholder không đủ để kết luận chất lượng.

Tách hai tầng:

- `schema_valid`: đúng format/type/required fields;
- `corpus_validated`: project/path containment, canonical query fingerprint, exact revision/SHA, path và symbol tồn tại, SHA khớp source bytes.

Reject hoặc quarantine với diagnostic cho malformed, stale, source mismatch, cross-project, unsupported status và duplicate identity trên toàn knowledge set. Không reset duplicate set riêng từng file nếu uniqueness là toàn artifact.

### 6.2 Revision semantics

Không bỏ stale check chỉ để record được load. Chọn một semantics nhất quán:

- bind record với exact reviewed commit; hoặc
- bind với source identity ổn định được contract cho phép và vẫn xác minh source bytes/revision.

Thêm integration test:

```text
review_commit_sha
→ load knowledge
→ corpus validation
→ candidate retrieval
→ exact knowledge binding
→ reranking
→ assert adjustment, identity và fallback
```

### 6.3 Evaluation artifact

Commit evaluation artifact có:

- baseline và reranked trên cùng corpus/configuration;
- Precision@K, Recall@K, symbol-hit rate, AC coverage;
- false-positive, stale rejection, unauthorized rejection;
- live/cache parity theo path, symbol, SHA, revision, receipt semantics, freshness và scope;
- dataset/artifact checksum, corpus revision, model/index identity, verifier provenance và rejection/fallback counts.

Synthetic unit fixture chỉ chứng minh helper behavior, không thay evaluation corpus thực.

### 6.4 Portability

Chạy clean checkout với runtime cache cô lập/trống; rebuild index/embeddings từ source và load artifact project-tracked. Không sao chép hoặc xóa runtime đang vận hành. Manifest phải ghi artifact paths/checksums, source/model/index identity, commands, prerequisites, result và limitations.

## 7. O4 — Safe reranking

Chỉ áp dụng knowledge khi bind đầy đủ:

```text
project + canonical query + candidate path/symbol
+ source SHA + source revision + verified receipt/scope
```

Candidate thiếu verified provenance, fresh scope hoặc identity binding phải giữ baseline với diagnostic, không được trở thành candidate hợp lệ nhờ knowledge.

Reranker phải:

- có absolute hard cap nội bộ, không tin cap do caller nâng;
- chống cộng dồn feedback/duplicate/concentration;
- tie-break deterministic theo candidate identity đầy đủ;
- fallback giữ candidate identity, baseline score và baseline ordering;
- không thay SHA, symbol map, freshness, scope, symbolic-read authorization hoặc Reviewer verdict;
- chạy end-to-end sau O1–O3, không chỉ tồn tại như helper.

## 8. Verification và báo cáo bắt buộc

SE gửi lại:

1. AC-to-code/test mapping theo O1–O4;
2. exact base SHA và commit SHA;
3. implementation changed-path manifest sạch;
4. execution manifest tách riêng, trung thực ghi generated/runtime outputs;
5. per-file checksums;
6. focused commands và kết quả;
7. mixed-batch/serialization/capability/snapshot/stop-policy evidence;
8. corpus validation, evaluation report, baseline/reranked metrics;
9. portability result;
10. residual risks và limitations.

Không gửi RV cho tới khi có clean immutable revision và verification evidence bind đúng revision. Không báo `Accepted`/`Closed` chỉ vì test pass hoặc commit tồn tại.

## 9. Finding hiện tại cần xử lý trước

Review exact commit `4a6741ce88610ff66e19d0cdaae2d7c9f2190928` nêu bốn Major findings cần reconcile:

- xác minh và loại runtime/generated files khỏi implementation commit nếu chúng thực sự thuộc commit đang review;
- sửa source-revision semantics để knowledge records không bị stale vô tình, rồi chứng minh corpus validation/reranking trên pinned snapshot;
- tạo evaluation report/manifest thực tế;
- tạo governed verification artifact gắn exact commit, base/source ledger và per-file checksums.

Lưu ý cần đối chiếu lại bằng `git_show`/status: patch inspection hiện có thể khác workspace report. Không tự chọn một nguồn rồi bỏ qua mâu thuẫn; SE phải ghi rõ revision và phạm vi quan sát.

## 10. Điều kiện bàn giao lại

Bàn giao lại cho SL/AM khi có:

- revision sạch, không trộn runtime/generated files;
- knowledge được load và validate trên exact intended revision;
- evaluation artifact có metrics và provenance;
- verification artifact truy xuất được;
- live AM → SE → RV demonstration hoặc limitation/blocker rõ ràng.

Sau đó mới chuyển độc lập cho RV. SE không tự nghiệm thu thay RV.
