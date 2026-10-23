<!-- Báo cáo triển khai trực tiếp P1: policy checkpoint owner dùng chung cho SE/AM, giữ cách ly vật lý và ghi rõ giới hạn bằng chứng nghiệm thu. -->
# Báo cáo triển khai checkpoint owner execution — P1

**Ngày:** 2026-10-12  
**Vai trò thực hiện:** System Engineer.  
**Ủy quyền:** owner nói “đồng ý triển khai trực tiếp P1” trong hội thoại; đây là ủy quyền riêng, **không phải exact approval của plan nguồn**. Message/decision ID và timestamp chính xác chưa truy xuất được.  
**Kết luận:** code đã triển khai; kiểm tra tập trung lại PASS trên snapshot local quan sát được. Commit/push có tool response trong hội thoại nhưng chưa xác minh độc lập Git object/remote HEAD. **Báo cáo chưa đủ điều kiện đóng**: provenance độc lập, vận hành và các coverage chưa xác minh vẫn mở.

## 1. Phạm vi và quyết định

Áp dụng P1 của `workflows/plan-shared-owner-execution-checkpoint.md`: chung implementation/policy, riêng root.

- SE (`system_engineer`): `.forge/runtime/owner-executions`.
- AM (`architecture_manager`): `.forge/runtime/architecture-executions`.
- Giữ hai instance, lease theo root/conversation và owner instance; không chuyển thành một lease chung.
- Không migration, đổi tên record, cleanup tự động hoặc sửa runtime `.forge/` bằng tay.
- Không đổi checkpoint ticket Coder/Reviewer; không mở thêm quyền cho bất kỳ role nào.
- Không sửa identity/revision/SHA của các plan nguồn hay tự cấp approval cho plan khác.

### 1.1. Provenance ủy quyền riêng — OPEN

- Tham chiếu `workflows/audit/owner-execution-checkpoint-p1-evidence.md`, mục A1: nguyên văn owner và ngữ cảnh trả lời đề nghị triển khai trực tiếp, bỏ tuyến Sprint Plan cho lượt này.
- Ngày hội thoại: 2026-10-12. Message ID, decision ID, authenticated actor ID và giờ UTC chính xác: **chưa xác minh**; không lấy giờ verification làm giờ approval.
- Conversation scope `59c84fe0-a3bf-4de9-9d5d-2e3a2730db28` được suy từ owner-run key; **không thay thế** message/decision ID.
- Phạm vi ủy quyền được hiểu đúng P1 ở mục 1; không cho P2, migration, cleanup, Coder hay thay đổi auth.
- Plan nguồn vẫn là proposal chưa có exact approval được chứng minh. Báo cáo không đổi trạng thái plan, không suy diễn đã hoàn tất tuyến exact approval → SL → Coder.
- Để đóng provenance: owner/operator xuất message/decision có ID, actor, timestamp, phạm vi P1 và xác nhận cho phép tuyến trực tiếp; ghi path/ID + checksum của export. Hiện chỉ có nội dung trong hội thoại, chưa có artifact xác thực độc lập.

## 2. Những gì đã làm

| Thành phần | Kết quả |
| --- | --- |
| `backend/src/application/owner-execution-role-policy.js` | Một bảng role → root, tên hiển thị và policy; không đoán role mặc định; thiếu/không hỗ trợ role thì từ chối khởi tạo. |
| `backend/src/application/owner-execution-record-guards.js` | Kiểm tra role/conversation/execution khi đọc; log và fail-closed khi lệch. Khóa identity gồm conversation, execution, role, lineage, attempt và resume. |
| `backend/src/application/owner-execution-checkpoint.js` | Dùng policy từ record cho các nhánh phục hồi; giữ mutation guard/evidence của AM và settlement `run_check` chỉ cho SE. Kiểm tra role parent trước khi seed Restart; thông báo busy đúng role. |
| `backend/src/application/owner-execution-control.js` | Chọn store bằng bảng tra, kiểm tra store role; record thiếu role không lọt qua `locate`. Summary trả thêm `role` và `display_name`; giữ policy owner-auth hiện có. |
| `backend/src/application/owner-sdk-stream.js` | Đối chiếu profile/store trước `start` và profile/record sau `start`; từ chối wiring sai role trước khi gọi SDK. |
| `backend/scripts/control-api-http.mjs` | Khởi tạo rõ role cho hai store; không còn truyền root riêng hay dựa vào role mặc định. |
| Test và architecture note | Thêm regression P1, cập nhật cách khởi tạo/summary ở test liên quan; ghi quyết định và yêu cầu deployment tại `backend/src/application/owner-execution-checkpoint.md`. |

Record thiếu/sai role bị chặn bằng lỗi `EXECUTION_RECONCILIATION_REQUIRED`, HTTP status metadata `404`, `recovery_status: manual_required`. Không trả record cho recovery và không tự sửa status trên đĩa: giữ nguyên bằng chứng để điều tra.

## 3. Verification và liên kết snapshot

Artifact tham chiếu: `workflows/audit/owner-execution-checkpoint-p1-evidence.md`.

| Evidence | Nội dung và trạng thái |
| --- | --- |
| E1 | Run gốc `VERIFY-RUN-a077b4cf-b387-4b93-8241-9dde1da9591a`, `2026-10-12T04:54:46.841Z`, PASS/exit 0 theo tool response lịch sử. Artifact persisted độc lập **chưa lấy được**. |
| S1 | Bảng whole-file SHA-256 và số dòng của 11 file P1 từ Forge `read_file` trước E2. Hash trùng Forge writes của lượt triển khai; không sửa source trong lượt này. Đây là snapshot các file bị tác động, không phải toàn bộ project/dependencies hay atomic Git tree. |
| E2 | Run lại trong lượt bổ sung: `VERIFY-RUN-a2ca20d9-4ba5-410d-be86-646e3f186f5f`, `2026-10-12T05:19:30.054Z`, **passed**, exit 0, scope passed, ready_for_review true. Response đầy đủ được lưu trong artifact. |

E1 và E2 dùng cùng command hẹp:

```text
node --test backend/tests/unit/owner-execution-role-policy.test.js backend/tests/unit/owner-execution-checkpoint.test.js backend/tests/unit/architecture-execution.test.js backend/tests/unit/owner-builtin-tools.test.js
```

- Liên kết E2 → S1 dựa trên checksum local quan sát trước run và không sửa source trong lượt này; chưa có source-bound attestation của Verification Service.
- Field `commit_id` của cả hai run là `OWNER-...-CORR-...`, **không phải Git SHA**. Không tuyên bố E1/E2 đã được service ràng buộc mật mã với commit `52e9fc1...`.
- `changed_paths` của E2 chỉ là conversation change ledger (report), không phải source manifest; không dùng nó chứng minh code snapshot.
- Không có tổng số test case trong response; không suy diễn số case pass/fail từ bốn file test.
- Không chạy full suite, lint, typecheck, UI build, browser E2E hay live-provider/restart-process scenarios. `not_applicable` trong run là không được yêu cầu, không phải đạt các gate đó.

## 4. Coverage outcomes áp dụng cho P1

Bảng này diễn giải outcomes nguồn theo nhánh P1, không sửa plan nguồn. Trạng thái PASS dưới đây chỉ là unit regression trong E2; không đồng nghĩa full production acceptance.

| Outcome / criterion P1 | Test / evidence | Trạng thái và giới hạn |
| --- | --- | --- |
| O1' — một implementation/policy, hai root, role explicit | `owner-execution-role-policy.test.js:35` — explicit roles/root override; `owner-execution-role-policy.test.js:48` — separate roots; wiring `control-api-http.mjs` trong S1 | **PASS unit + source review**. Một instance/một root của P2: **không áp dụng**. |
| O2 — policy AM/SE không lệch quyền | `owner-execution-role-policy.test.js:114` — AM denies SE mutations/no run_check settlement; `architecture-execution.test.js` — intended hash, verified delete, stopped-runner gates; `owner-execution-checkpoint.test.js` — SE settlement, commit HEAD, no replay; `owner-builtin-tools.test.js` — native Continue | **PASS phần unit đã có; outcome một phần**. Remote push receipt, exhaustive policy branches và real crash-window: **chưa xác minh**. |
| O3 — fail-closed cross-role, nhãn đúng role | `owner-execution-role-policy.test.js:76` — missing/foreign role; `owner-execution-role-policy.test.js:132` — control summaries/decisions; `architecture-execution.test.js` — agent scope/negative pause; E2 | **PASS unit**. Real HTTP/browser scope: **chưa xác minh**. Cấm hai role cùng running của P2: **không áp dụng**; P1 giữ lease riêng, test separate roots xác nhận. Auth đọc execution vẫn **OPEN**, không tính đạt O3 auth. |
| O4' — giữ cách ly root, không migration | `owner-execution-role-policy.test.js:35`, `owner-execution-role-policy.test.js:48`, `owner-execution-role-policy.test.js:100` — no cross-root seeding; persistence/Restart tests trong `owner-execution-checkpoint.test.js` | **PASS unit cách ly**. Recovery record thật sau restart API: **chưa xác minh**. Migration/rootLegacy/idempotent chuyển file của P2: **không áp dụng**. |
| O5 — bất biến pause/resume | `architecture-execution.test.js` — lost receipt/manual reconciliation, active mutation; `owner-execution-checkpoint.test.js` — cancelled check, receipts, live lease; E2 | **Một phần**. Real crash giữa write/receipt, lease hết khi mutation active, hai process và toàn bộ approval invariants: **chưa xác minh**. Không cleanup là scope giữ nguyên, không phải retention acceptance đã hoàn tất. |
| O6 — policy module, ≤250 dòng, vocabulary | `owner-execution-role-policy.test.js:168` — size guard; S1 max 234 dòng; 11-path commit response không sửa glossary | **PASS code/test size**. Report/evidence cũng dưới 250 dòng. Không dùng kết quả này thay lint/typecheck/build. |
| O8 — guard 0–4, 6–7; seam profile/store/record | `owner-execution-role-policy.test.js:35`, `owner-execution-role-policy.test.js:62`, `owner-execution-role-policy.test.js:76`, `owner-execution-role-policy.test.js:100`, `owner-execution-role-policy.test.js:132`, `owner-execution-role-policy.test.js:156` — role/root, immutable identity, fail-closed, lineage, labels, SDK mismatch; guard source trong S1 | **PASS các negative unit nêu trên; outcome một phần**. Negative test SDK trả record sai role sau start và exhaustive transition/HTTP races: **chưa xác minh**. |
| O7 — Coder tham gia owner checkpoint | Scope P1/Hiểu A; explicit-role test từ chối Coder/Reviewer | **Không áp dụng**; không triển khai Hiểu B. |

Tên file test trong bảng đều thuộc `backend/tests/unit/`; E2 chạy đúng bốn file ở mục 3. Không đưa tiêu chí migration/lease chung P2 vào mẫu số nghiệm thu P1.

## 5. Git evidence — chưa xác minh độc lập remote

- Commit code gồm 11 file: `52e9fc1e3bb6c3a369a2010840f670ad17d77ad2`.
- Artifact mục G1 lưu trích commit tool response (SHA, message, paths, output); G2 lưu trích push response (`origin`, `ui-chat`, SHA, output thành công).
- Đây là bản trích hội thoại do agent lưu, **không phải receipt export độc lập**. Không có receipt ID/timestamp riêng hoặc Git object/tree proof của commit.
- Forge status sạch không chứng minh HEAD/remote SHA. Bộ tools hiện tại không có read-only remote-ref/log/show/receipt lookup; không re-push chỉ để giả làm remote verification.
- Discovery runtime receipts bị Forge chặn với `CONFIGURATION_ERROR` (artifact L1). Không vượt boundary bằng SDK/shell hay chỉnh `.forge/`.
- **OPEN:** operator xuất receipt verification/commit/push gốc, đối chiếu SHA/paths/snapshot, và ghi remote-ref observation cho `origin/ui-chat` với thời điểm. Nếu remote đã tiến lên, xác nhận commit P1 nằm trong lịch sử thay vì đòi HEAD bằng P1.
- Hai Markdown report/evidence ở `workflows/` là nội bộ; không force-track/un-ignore/commit. Không tạo source commit mới cho lượt bổ sung này.

## 6. Bàn giao vận hành — chưa hoàn tất

SHA cần nạp: **`52e9fc1e3bb6c3a369a2010840f670ad17d77ad2`**, hoặc artifact hậu duệ đã xác minh chứa commit đó.

| Việc | Người chịu trách nhiệm | Bằng chứng hoàn tất bắt buộc | Hiện trạng |
| --- | --- | --- | --- |
| Drain + kích hoạt API | Project owner chịu trách nhiệm cấp phép; operator do owner chỉ định thực hiện | Operator/actor ID, giờ UTC drain/restart, không còn execution đang chạy, deployed SHA/artifact, service instance/version và startup/health evidence | **Chưa xác minh**; operator cụ thể chưa được owner chỉ định trong bằng chứng hiện có. |
| Smoke P1 | System Engineer phụ trách kỹ thuật; owner/operator cấp môi trường và xác nhận người thực hiện | Run/report ID, giờ UTC, deployed SHA, hai workspace SE/AM; nhãn đúng role, Continue/Restart/Discard, không chéo record, không duplicate mutation, audit/lineage giữ nguyên | **Chưa thực hiện/xác minh**; unit PASS không thay thế smoke. |
| Rollback | Project owner quyết định; operator triển khai, System Engineer kiểm tra lại | Ghi full baseline SHA/artifact trước rollout, lý do rollback, người thực hiện, giờ UTC, post-rollback health và snapshot audit còn nguyên | **Chưa xác minh baseline/diễn tập**; không suy từ short SHA `ce7f9e8`. |

**Trigger rollback:** smoke thất bại với record hợp lệ, truy cập/ghi chéo role, duplicate side effect, mất lineage/audit hoặc lỗi startup/health do P1. Dừng lượt mới, drain an toàn, quay về artifact trước P1 đã ghi nhận; giữ nguyên `.forge/` và receipts. Revert source nếu cần phải được owner cho phép; không reset/xóa runtime để bypass guard. Record sai identity bị chặn đúng thiết kế không tự nó là lý do rollback.

Không cần UI rebuild/migration cho P1. Không tuyên bố đã restart API, smoke thành công hoặc cấp GO cho pause/resume AM.

## 7. Theo dõi riêng và điều kiện đóng

| ID nội bộ | Hạng mục | Chủ trách nhiệm / điều kiện đóng | Trạng thái |
| --- | --- | --- | --- |
| PROVENANCE-P1 | Export message/decision của ủy quyền trực tiếp | Owner/operator: ID + actor + timestamp + scope + direct-route authorization; không approve ngầm plan nguồn | **OPEN — Major** |
| EVIDENCE-P1 | Persisted verification/Git receipts, snapshot-to-commit và remote-ref proof | Operator xuất artifact; System Engineer đối chiếu checksum/SHA/run | **OPEN — Major**; E2 PASS không thay export độc lập |
| COVERAGE-P1 | Các criterion chưa xác minh trong mục 4 | System Engineer thực hiện/ghi evidence theo scope được owner cho phép | **OPEN**; P2/O7 không áp dụng |
| OPS-P1 | Phân công operator, deployed SHA, smoke và rollback baseline | Project owner xác nhận phân công; operator/SE cung cấp bằng chứng mục 6 | **OPEN** |
| AUTH-READ-EXECUTION | Auth đọc execution chưa giải quyết | Owner chốt contract; SE/đơn vị được giao bổ sung negative GET tests token thiếu/sai, project/conversation/agent chéo và evidence HTTP thực | **OPEN riêng**, không coi giữ nguyên policy là PASS; không mở scope triển khai trong lượt viết báo cáo |

**Bàn giao:** đã bổ sung provenance có giới hạn, artifact trích responses/snapshot, mapping P1 và operational owners/rollback. Báo cáo vẫn mở cho các bằng chứng chưa lấy được; không chuyển các mục OPEN/chưa xác minh thành đạt nghiệm thu.
