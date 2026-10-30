<!-- Hướng dẫn bàn giao phần phân quyền còn thiếu cho SE, giữ ranh giới kiến trúc, quyền quyết định và bằng chứng nghiệm thu độc lập. -->
# Plan: Hướng dẫn SE hoàn thiện quyền truy cập Coder/Reviewer

**Ngày:** 2026-10-22  
**Trạng thái:** Dự thảo hướng dẫn triển khai tiếp; không phải approval, manifest hoặc lệnh RUN/dispatch.  
**Kế hoạch gốc:** `workflows/plan-coder-reviewer-file-access-policy.md`. Tài liệu này bổ sung hướng dẫn hoàn thiện, không thay thế hoặc giảm O1–O6/F1–F5 của kế hoạch gốc.

## 1. Mục tiêu / kết quả mong đợi

- Hoàn thiện phần còn thiếu để có ít nhất một luồng được hỗ trợ thực sự: Coder đọc dependency/caller ngoài manifest → sửa trong write scope → verification hợp lệ → Reviewer độc lập trên snapshot đúng artifact.
- Giữ đọc có kiểm soát, ghi hẹp theo ticket; không mở route chỉ để smoke PASS.
- Bàn giao bằng chứng đủ để đánh giá rollout, thay vì suy ra hoàn tất từ focused tests.

**Baseline theo báo cáo, chưa được tài liệu này kiểm chứng lại trong code:** contract grant v2, snapshot review và một số deny controls đã được triển khai; production composition, path-race boundary, subprocess isolation, migration/provider matrix và end-to-end evidence chưa hoàn tất. Báo cáo ghi 108/108 focused tests đạt, không phải full suite [E1]. SE phải đối chiếu revision hiện hành trước khi kế thừa các kết luận này.

## 2. Phạm vi và trách nhiệm

### In scope

- Reconcile implementation hiện tại với plan gốc; đóng các khoảng trống boundary, composition, resume/restart, verification và evidence.
- Chứng minh từng route được bật; route chưa chứng minh an toàn giữ unsupported/deny.
- Đồng bộ prompt/rulebook/tests đang hiệu lực với enforcement sau tích hợp.

### Out of scope

- Không cấp project-wide access, shell tùy ý, quyền sửa source cho Reviewer hoặc quyền ghi governance cho Coder.
- Không đổi approval/storage contract, review verdict semantics hoặc ticket/revision đã khóa.
- Không mặc định phải hỗ trợ Codex CLI v2 hay bật native tools; không giảm tiêu chí gốc để chỉ giữ các bài test từ chối.

**Phân vai:** SE khảo sát và thực hiện kỹ thuật trong ticket/quyền hợp lệ. SL sở hữu phân rã delivery, manifest, budget và verification chi tiết. AM giải quyết kiến trúc trong boundary đã duyệt; thay đổi security semantics/guardrail cần đúng decision owner. Reviewer độc lập kiểm tra implementation; tác giả không tự thay Reviewer gate [E3].

## 3. Hướng tiếp cận và guardrails

### 3.1. Hai quyết định authority — không giao SE tự suy diễn

| Vấn đề | Đầu vào cần có | Khi chưa có |
| --- | --- | --- |
| Phân loại governance docs | Nguồn policy được duyệt, decision owner, identity/revision/SHA, quy tắc phân loại và xử lý xung đột; Node resolver dùng đúng nguồn đó. | Giữ deny ghi docs chưa phân loại được. Không dùng agent, prefix hay exact manifest làm authority. |
| Thu hồi quyền khi execution đang chạy | Nguồn quyết định, thời điểm hiệu lực; hành vi đối với operation chưa bắt đầu/đang chạy, kết quả đang chờ trả và side effects đã xảy ra; nghĩa vụ audit/reconcile. | Không tự chọn tiếp tục quyền cũ, hủy tức thì hay coi callback hiện tại là semantics đã duyệt. Chặn rollout phần phụ thuộc; vẫn làm discovery và phần kỹ thuật độc lập trong quyền hiện hành. |

AM đối chiếu policy hiệu lực trước, chỉ trình owner tradeoff vượt thẩm quyền. Không yêu cầu owner duyệt lại chi tiết helper, ticket hoặc lỗi kỹ thuật. Tài liệu này chưa chốt hai quyết định trên [E1:59–67; E2:63–83].

### 3.2. Khảo sát lại trước khi tích hợp

- Xác minh plan/policy approval đúng identity/revision/SHA qua contract Node; trạng thái Markdown không chứng minh approval.
- Chốt baseline commit/revision/checksums thực tế; xác minh các claims của báo cáo, không tái sử dụng hash code lịch sử trong plan làm bằng chứng code hiện tại.
- Lập inventory role × provider × mode × fresh/resume/restart: Forge discovery/read/write/graph/cache, SDK native tools, shell/subprocess, verification, Reviewer checks và dependency reads.
- Với mỗi route ghi boundary thực thi, nguồn authority, nguồn filesystem/snapshot, trạng thái enabled/disabled/unsupported và test allow/deny tương ứng. Khảo sát consumers trước đổi shared helper.

### 3.3. Filesystem và cache/index

- Authorization phải ràng buộc đối tượng thực sự được đọc/ghi. Chọn boundary có thể chứng minh chống path/symlink đổi giữa check/use; không coi lstat trước thao tác hoặc hậu kiểm là đủ.
- Bao phủ direct read, discovery, graph metadata, cache/index và write/create; protected deny luôn thắng grants.
- Kiểm thử race có điều phối thay đổi path/symlink giữa các pha và đối chứng allow bình thường. Nếu nền tảng không bảo đảm được boundary, giữ route liên quan bị chặn, mô tả giới hạn; không tuyên bố O3 hoàn tất.
- Cache/index dưới grant cũ phải chịu authority hiện hành trước trả tên/snippet/nội dung. Kiểm thử thu hẹp và thu hồi ở boundary thực tế, không chỉ mock callback.

### 3.4. Verification và provider routes

- Theo báo cáo, Coder Codex CLI v2 chưa admission và Coder v2 `run_check` đang khóa [E1:22–44]. Giữ nguyên deny cho tới khi có chứng minh boundary tương đương.
- Để mở verification, chứng minh subprocess và tiến trình con không vượt filesystem/command/environment authority; output/cache/temp và dependency access không trở thành đường vòng. Verification authority là grant riêng, không suy từ read grant.
- Reviewer checks phải dùng workspace cô lập, provenance source/dependency/toolchain tương ứng môi trường artifact; không sửa working tree của Coder, không lấy dependency live thay evidence bị thiếu.
- Cấu hình như `tools: []` hay sandbox read-only chỉ là một phần evidence; phải kiểm tra mọi route thực sự còn khả dụng.
- Không fallback sang legacy service, shell hoặc provider khác có quyền rộng hơn khi route chuẩn từ chối. Unsupported khác với verification PASS.

### 3.5. Production composition, legacy và recovery

- Trusted Node composition cấp `fileAccessPolicy` từ authority đã duyệt; agent, ticket payload và checkpoint không được tự cung cấp authority. Nối policy identity, current authority, docs resolver và resume reconciliation theo contract thực tế đã xác minh.
- Phân nhánh rõ: v2 hợp lệ; legacy có version/provenance được Node xác thực; context không xác định. Thiếu field không chứng minh legacy, JSON copy không khôi phục grant v2.
- Restart/resume phải reconcile và phát hành lại từ nguồn tin cậy; không deserialize checkpoint thành quyền, không phục hồi quyền đã thu hồi hoặc tăng write scope.
- Giữ manifest/create grant/budget, commit ledger, push và review gates độc lập; đọc caller ngoài manifest không cho phép sửa caller.
- Logs ghi operation, role, quyết định, reason và policy/execution identity; không ghi secrets hoặc nội dung bị chặn.

## 4. Khu vực ảnh hưởng và evidence

| Mã | Nguồn đã đọc | Giá trị / giới hạn |
| --- | --- | --- |
| E1 | `workflows/report-coder-reviewer-file-access-policy.md:9–75` | Baseline tự báo cáo về code, tests và blockers; không phải independent verification. SHA-256: `sha256:d5709080470e527660c15f1263930f99f4249c31ca31ea9b0f7a7a77bafd0e08`. |
| E2 | `workflows/plan-coder-reviewer-file-access-policy.md:16–172` | Ma trận đề xuất, O1–O6/F1–F5, compatibility và approval constraints. SHA-256: `sha256:d0fcc50cc6a7bd3af23638b58ab875187f8e0662c4e0fdfc8264499e343a1d3b`. |
| E3 | `workflows/agents/architecture/README.md:5–168` | Ranh giới AM/SL, plan theo outcomes, approval và review độc lập. SHA-256: `sha256:f89a981f59e443a2613252c2d176ae2753b7a848ddfe90f0cabbe8bd111d0443`. |
| E4 | `AGENTS.md:3–33`; `vocabulary/glossary.md:5–10` | Naming, giới hạn file, comment mới, scope và pipeline glossary riêng. |

Candidate areas từ E1/E2: execution-file-access, runtime governance, engineering binding, file service, provider adapters, production composition, checkpoint/resume, Reviewer snapshot/checks và tests. Đây không phải manifest; chưa khảo sát lại source ở lượt viết hướng dẫn này. SL/SE phải tìm đúng paths và consumers hiện hành.

## 5. Outcomes và điều kiện nghiệm thu phần tiếp tục

| Mã | Kết quả | Điều kiện đạt | Mapping / dependency |
| --- | --- | --- | --- |
| C1 | Baseline và authority rõ | Có inventory route và baseline revision; claims cũ được xác minh hoặc đánh dấu chưa đạt; hai quyết định §3.1 có nguồn hợp lệ trước bật phần phụ thuộc. | O1/O2/O5; F3/F4. |
| C2 | Boundary không rò scope | Integration evidence cho read/write/create/discovery/graph/cache; race và grant cũ không lộ dữ liệu; đối chứng read ngoài manifest thành công nhưng write cùng file bị chặn. | O1/O3/O5; F1/F5; semantics thu hồi cho tests liên quan. |
| C3 | Verification vận hành an toàn | Ít nhất một route Coder v2 verification thực sự chạy được trong authority hợp lệ; có allow/deny subprocess/dependency/isolation; unsupported routes vẫn bị chặn. | O3/O5/O6; F1. Không chỉ chặn tất cả để lấy PASS. |
| C4 | Reviewer độc lập đúng snapshot | Caller ngoài diff sửa/xóa sau snapshot không đổi evidence; sai revision/hash bị chặn; checks và dependencies có provenance phù hợp; working tree Coder không đổi. | O4/O6; F2; boundary isolation. |
| C5 | Composition/recovery tương thích | Kiểm tra production wiring và matrix supported modes; fresh/resume/restart, legacy xác thực, unknown/tampered context đều đúng allow/deny; không nâng grant khi recovery. | O1/O2/O5; F3/F4/F5; authority đã chốt. |
| C6 | Có cơ sở quyết định rollout | Smoke v2 coding → verification → review đạt với thao tác hợp lệ thực sự; coverage đủ O1–O6/F1–F5, regression và review độc lập cùng revision; liệt kê rõ route chưa hỗ trợ. | C1–C5; không giảm tiêu chí plan gốc. |

**Gợi ý delivery, không bắt buộc:** baseline/authority trước tích hợp production; boundary và isolation có thể khảo sát song song; smoke sau khi các route của luồng đã được chứng nhận. SL tự chọn số ticket, thứ tự, helper và file budget, không sửa contract đã khóa.

## 6. Rủi ro, giả định và câu hỏi mở

- **Blocker:** nguồn governance và thời điểm thu hồi chưa có evidence được chốt trong tài liệu đã đọc; AM xử lý theo §3.1, không đẩy quyết định security cho SE.
- **Major:** race protection, subprocess isolation hoặc provider support có thể cần boundary khác hiện tại. SE cung cấp evidence/options; AM đánh giá nếu chạm system boundaries, không tự mở quyền tạm.
- **Major:** code hiện hành có thể khác báo cáo; phải reconcile baseline trước kết luận hoặc sửa tiếp. 108/108 là con số báo cáo, không phải kết quả chạy mới.
- **Giả định:** có thể hoàn thiện ít nhất một luồng v2 an toàn trong scope. Nếu không chứng minh được, báo blocker kỹ thuật và phương án; không tự cắt verification/review.
- **Compatibility/rollback:** chỉ bật ở modes đã có evidence theo release authority hiện hành. Rollback về bộ context/enforcement/prompt tương thích, dừng/reconcile context không tương thích; không khôi phục quyền đã thu hồi. SE/SL đề xuất rollout owner và cách quan sát theo workflow thực tế, không tự nhận release authority.

## 7. Checklist bàn giao và báo cáo

- [ ] Kiểm chứng approval/policy identity và baseline source trước execution; lập ticket/manifest theo quyền SL hiện hành.
- [ ] Map từng tiêu chí O1–O6/F1–F5 sang ticket, test và artifact; ghi PASS/FAIL/BLOCKED/NOT RUN, không ghi đạt theo số lượng tests.
- [ ] Có unit + integration tại boundary thực, positive controls, race/cache/revocation, provider/recovery matrix và smoke thực sự.
- [ ] Ghi code commit/revision/checksum, policy identity/revision/SHA, snapshot và verification-environment identity, lệnh/checks, kết quả và baseline failures; không ghi secrets.
- [ ] Có independent review gắn đúng artifact/revision; sửa sau review phải theo revision/gates hiện hành.
- [ ] Báo cáo phần đạt, còn chặn và readiness rollout riêng biệt. Route unsupported không tự biến thành hoàn tất mọi provider.
- [ ] Chỉ rollout khi đủ gates và authority. Việc lưu hướng dẫn/lập SP không tự approve, RUN hoặc dispatch.

**Trạng thái lượt viết:** Chỉ đọc các tài liệu E1–E4 và hướng dẫn workflows, chưa đối chiếu source, chưa chạy tests, chưa thay approval hoặc implementation. Hướng dẫn không xác nhận hai quyết định authority đã được chốt.
