<!-- Kế hoạch bảo đảm Coder tự quyết trong boundary và được nghiệm thu bằng hành vi có bằng chứng. -->
# Plan: Coder tự quyết cách làm, nghiệm thu bằng hành vi

- Identity đề xuất: `PLAN-PROJECT-NODEFORGE-bd95299a-b504-423d-bfb9-57aac8cac8b4`; revision tài liệu: `r1`.
- Trạng thái: đề xuất để owner review, chưa có approval; không phải Sprint Plan hay quyền RUN/dispatch.
- Nguồn yêu cầu: hội thoại owner và `workflows/plan-coder-autonomy-behavior-verification.md` (SHA-256 `e4f060c28b542aad485b5dace08fa5fa74b829b463d2011f736ae3ee889b9f33`). Đây là bản theo identity được yêu cầu, không chuyển approval từ tài liệu nguồn.
- Provenance/identity lưu trữ chính thức và approval do Node quản lý theo contract hiệu lực; metadata ở đây không thay thế bản ghi đó.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** AC, guidance hoặc gate có thể khóa cách triển khai, khiến quyền tự quyết chỉ tồn tại trên lời nói.
- **Kết quả:** Coder tự chọn giải pháp trong boundary; Reviewer nghiệm thu bằng hành vi, contract, guardrails và evidence đúng revision, không bằng mức độ làm giống hướng dẫn.
- **Giá trị:** giảm escalation và sửa code không cần thiết mà không hạ chất lượng, scope hay quyền kiểm soát.
- **Nguyên tắc:** Coder được đổi helper/thuật toán, tổ chức nội bộ và bổ sung test trong boundary; không được tự hạ điều kiện đạt hoặc thay contract đã khóa.

## 2. Phạm vi

### In scope

- Đối chiếu và đồng bộ bốn rulebook Architecture, SL, Coder, Reviewer; giữ các phần đã phù hợp, chỉ sửa sai lệch có evidence.
- Đồng bộ prompt lập SP, tạo/tái tạo ticket, dispatch, review và nhánh repair/resume liên quan trong các luồng được hỗ trợ.
- Phân biệt outcome/contract/guardrail bắt buộc với implementation guidance không bắt buộc.
- Audit schema, validator và runtime theo entrypoint; sửa có mục tiêu khi chứng minh gate ép cách làm không có căn cứ.
- Reconciliation file budget dựa trên inventory schema/admission path; verification, agent evaluation và rollout/rollback có thể audit.

### Out of scope

- Coder tự đổi AC, verification plan đã khóa, manifest, budget, public contract hoặc quyền ghi.
- Bỏ independent review, coverage, security, checksum, exact-revision evidence, approval hoặc terminal gates.
- Tái thiết pipeline, storage/approval model, recovery hay thêm schema/versioning framework khi discovery chưa chứng minh cần thiết.
- Refactor ngoài phạm vi, sửa `.forge/`, chuyển đổi âm thầm ticket đã khóa hoặc tái sử dụng approval cho revision khác.

## 3. Hướng tiếp cận và guardrails

### Hợp đồng kết quả

- AC mô tả hành vi và điều kiện đạt; guidance không trở thành constraint chỉ vì nằm trong ticket hoặc prompt.
- Constraint triển khai phải có nguồn thẩm quyền và lý do contract/security/compatibility, repo rule hoặc yêu cầu owner rõ ràng. Không hợp thức hóa sở thích cá nhân bằng nhãn constraint.
- Coder tự quyết giải pháp và thêm test trong boundary, không xin owner chỉ vì khác guidance. Giữ protocol/tool instructions bắt buộc và final verification; focused checks không thay checks đã khóa.
- Reviewer phải nêu hành vi/contract/rule vi phạm hoặc rủi ro cụ thể kèm evidence; không reject chỉ vì khác cách làm dự kiến.
- Manifest là quyền ghi, không phải nghĩa vụ sửa mọi file. Budget tính mọi file thực sự đổi, kể cả tests/config/schema/tài liệu; không tính read-only discovery. Không áp trần bốn file toàn cục bằng suy diễn, cũng không tự bỏ giới hạn cụ thể đã duyệt.
- Vượt manifest/budget chuyển SV/SL theo cơ chế hiện hành; SL quyết delivery trong thẩm quyền, AM xử lý vượt SP; owner chỉ quyết thay đổi thuộc quyền owner.

### Compatibility, dependency và rollout

- Chốt semantics bắt buộc/guidance trước khi đồng bộ consumers; coverage/evidence và regression proof phải đủ trước rollout phần liên quan.
- Mặc định giữ schema. Chỉ đổi khi có evidence contract hiện tại không đáp ứng; phải xác định consumers, compatibility, migration và rollback trước dispatch phần đó.
- Ticket mới dùng revision mới; ticket khóa cũ giữ contract, cần replacement/replan nếu muốn thay AC. Không diễn giải lại AC bất biến hoặc chuyển approval sang hash mới.
- Rollback rule/prompt/runtime không được đổi semantics giữa execution, kể cả ticket đã bắt đầu theo revision mới. Repair/Resume phải giữ contract, quyền ghi và quyền tự quyết đã bind, không diễn giải lại theo policy mới nhất.
- Xác minh snapshot/version binding hiện có cho rule, prompt, runtime, repair/resume; snapshot một Reviewer không đủ chứng minh toàn luồng. Nếu thiếu, ghi giới hạn rollout và chặn phần chưa bảo đảm, không âm thầm đổi contract.
- **Drain bao gồm mọi execution còn khả năng tiếp tục:** cả checkpoint đang dừng nhưng còn quyền Resume, không chỉ process đang chạy. Ticket rollout phải có evidence nhận diện nhóm này và cách giữ semantics qua cutover/rollback, hoặc chứng minh cơ chế hiện hành đã drain thật sự khả năng tiếp tục bị ảnh hưởng. Chưa đủ bằng chứng thì chặn cutover phần liên quan.
- SL phối hợp SV/runtime maintainer sở hữu rollout sau approval; Reviewer độc lập xác nhận evidence. Không tự đổi policy review gate on/off hoặc quyền production acceptance.
- Không có tradeoff owner mới cần hỏi lại từ hội thoại hiện tại; unknown kỹ thuật thuộc discovery được ủy quyền, chỉ escalate khi có xung đột thẩm quyền thật sự.

## 4. Khu vực dự kiến ảnh hưởng và evidence

Các khu vực là định hướng discovery, không phải mutable-file allowlist hay nghĩa vụ sửa file. Bản nguồn có khảo sát lịch sử; không coi mọi nhận định cũ là fact hiện tại.

| Thành phần / khu vực | Evidence và mức chắc chắn |
| --- | --- |
| Rulebook và ranh giới AM/SL | `workflows/agents/architecture/README.md`, §3–6, SHA-256 `f89a981f59e443a2613252c2d176ae2753b7a848ddfe90f0cabbe8bd111d0443`: hiện đã nêu quyền tự quyết, budget dương, không trần bốn toàn cục. Không lặp lại nhận định lịch sử rằng file này vẫn có trần bốn |
| Report production governed / legacy | `backend/src/tools/agent-report-tool.js:28–58`, SHA-256 `d9d32829ea6c34e7d99f9892d4354c6cbcd56ddad1eaf98b3a2e74a21fcd5e3e`: `assertReportScope` chỉ gọi khi `!governed`; governed dùng artifact và coverage. Không mặc định gate legacy là nguyên nhân production |
| Regression file không đổi | `backend/tests/unit/ticket-report-artifact-gate.test.js:98–115`, SHA-256 `e6fce0de9fb4c0a0e54f1fc9f8812c0119402db120f216e52d5d46ed8dd43224`: fixture đổi a.js, giữ b.js, kỳ vọng `submitted_for_review`; đọc test không đồng nghĩa đã chạy test hay agent production |
| File budget trong một validator | `backend/src/application/sprint-orchestration-service.js:225–231`, SHA-256 `eae88df0325f02c1b0c180d326fc43c62c5f5683a05ad5537d1176aa30eb4eb8`: hàm kiểm budget nguyên dương, không áp trần bốn tại đây; không đủ kết luận mọi schema/admission path |
| Các consumers cần inventory lại | Bản nguồn §4 dẫn SL/Coder/Reviewer rulebooks; `sprint-plan-leader.js`, `nodeforge-task-prompts.js`, ticket schema/verification contract, automatic review, ticket CRUD/handoff/review worker. Đây là candidate discovery, chưa xác minh lại đầy đủ trong revision này |
| Binding, recovery và rollout | Chưa có bằng chứng toàn luồng trong lần lập tài liệu này; cần inventory execution/checkpoint, rule/prompt snapshots và runtime consumers trước kết luận an toàn |

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Quyền tự quyết xuyên suốt bốn vai trò | Bốn rulebook thống nhất hành vi/constraint/guidance; Coder đổi giải pháp và thêm test trong boundary không xin phép; Reviewer không reject chỉ vì khác guidance. File budget reconciliation có inventory schema/admission path liên quan và kết luận từng path | Không đổi quyền ghi hay tự hạ AC |
| O2 | Ticket và prompt không khóa cách làm vô cớ | Các luồng lập/tạo/tái tạo ticket, dispatch, review, repair/resume được hỗ trợ truyền cùng semantics; có fixture AC hành vi, guidance tách biệt; không tạo owner gate chỉ do đổi helper/thuật toán; frozen contract giữ nguyên | O1; giữ tool/protocol contract |
| O3 | Gate không chặn sai giải pháp hợp lệ | Audit phân biệt production governed/legacy, ghi entrypoint/call path, điều kiện kích hoạt, ràng buộc bảo vệ và quyết định giữ/sửa. Trước sửa phải tái hiện chặn sai qua entrypoint thực sự bị ảnh hưởng; đối chiếu committed delta, giữ regression manifest file không cần đổi. Mỗi thay đổi gate có positive/negative tests. Không tái hiện được thì kết luận chưa có căn cứ sửa là hợp lệ | Không buộc tạo runtime change; giữ scope, budget, coverage và artifact identity |
| O4 | Nghiệm thu qua pipeline được hỗ trợ | Ít nhất hai phương án nội bộ khác nhau, chung AC/guardrails, cùng đi qua report/verification/review được hỗ trợ và được nghiệm thu; mỗi phương án có artifact/evidence riêng bind đúng revision/commit. Phương án đúng guidance nhưng sai hành vi bị từ chối, chỉ rõ tầng chặn. Có assertions hành vi thực thi và review disposition, không chỉ hai hàm pass test hoặc snapshot prompt | O2, O3; independent review; không dùng proof chéo revision |
| O5 | Không làm yếu gate hoặc tái tạo escalation | Negative tests chặn thiếu coverage, bỏ check bắt buộc, vượt manifest/budget, sai contract, stale evidence/hash mismatch và tự approve. Witness tích hợp đổi helper/thuật toán trong boundary → repair hoặc Stop/Resume → verification/review: không sinh owner request mới chỉ vì khác guidance; giữ contract và quyền đã bind | O2, O3; không viết lại blocker recovery |
| O6 | Rollout/rollback audit được | Mapping đầy đủ outcomes/AC tới ticket và verification, affected consumers và compatibility. Có kết luận đủ/thiếu binding, witness rollback giữa execution của ticket revision mới và Resume sau rollback. Bảo vệ ticket cũ lẫn ticket mới đã bắt đầu; drain tính checkpoint còn quyền Resume; chặn cutover/rollout phần chưa bảo đảm | O1–O5; không mutate contract hoặc tái dùng approval |

### Verification: tách máy xác định được và hành vi agent

- **Runtime tests:** fixture đi qua entrypoint report/verification/review hỗ trợ, assertions hành vi và disposition, artifact đúng revision. Có thể dùng provider/reviewer doubles tại boundary khai báo; ghi rõ tầng thật/giả lập. Không cần agent thật trong mọi unit test, nhưng hai hàm pass test không đủ O4.
- **Agent evaluation:** trước khi chạy, SL/evaluation owner chốt trong ticket verification provider/model, cấu hình, số run, phạm vi, pass/fail, cách phân biệt lỗi hệ thống/tool/provider với biến thiên agent, xử lý run lỗi/chưa xác định và quy tắc chạy lại. Scenario phải đánh giá Coder thật chọn cách khác guidance và Reviewer không reject chỉ vì khác cách làm.
- Báo cáo toàn bộ tập run, kể cả lỗi và chạy lại; lưu contract revision, transcript/report, artifact/evidence, phân loại kết quả và giới hạn kết luận theo provider/model. Không chọn một run thành công để kết luận chung, không đòi agent luôn luôn đúng; prompt snapshot/runtime double không thay chứng cứ hành vi agent.
- **Witness repair/resume/rollback:** ghi entrypoint, revision/commit, evidence, contract/quyền trước-sau và tầng nghiệm thu/chặn; kiểm cả checkpoint dừng còn quyền Resume qua cutover/rollback. Chỉ kiểm chứng tích hợp, không mở dự án recovery/versioning.
- Báo cáo runtime và agent evaluation riêng; không coi lớp này chứng minh thay lớp kia. Chi tiết evaluation do SL/evaluation owner chốt trước chạy, không thêm vòng thiết kế/approval ngoài contract hiện hành.

SL tự quyết số sprint/ticket, thứ tự, implementation type hợp lệ, manifest và budget theo policy. Mapping mỗi outcome/criteria tới một hoặc nhiều ticket/checks; không bỏ/giảm tiêu chí hoặc biến ví dụ helper thành checklist code bắt buộc.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / xử lý |
| --- | --- | --- | --- |
| Policy đã đổi so với khảo sát lịch sử | Major: sửa thừa hoặc sai nguyên nhân | Architecture rulebook hiện đã có semantics mục tiêu; chưa audit mọi consumer | SL inventory hiện trạng, AM reconciliation; giữ nguyên nơi đã đúng |
| Nhầm gate legacy thành blocker production | Major | Entrypoint report đã phân nhánh governed | SL/Coder truy vết và tái hiện trước sửa; không có căn cứ sửa là kết luận hợp lệ |
| Binding không đủ cho rollback/Resume | Blocker rollout phần liên quan | Chưa có proof toàn luồng | SL/runtime maintainer kiểm binding và paused checkpoints; giới hạn/chặn cutover nếu thiếu |
| AC cũ khóa cách làm hoặc test cần ngoài manifest | Blocker cho ticket bị ảnh hưởng | Giả định tương thích cần phòng ngừa | SV/SL dùng replacement/replan hoặc điều chỉnh delivery đúng thẩm quyền; Coder không tự mở quyền |
| Prompt đúng nhưng agent vẫn bám checklist | Major | Runtime proof không thay agent evaluation | Evaluation owner chốt protocol trước chạy, báo cáo toàn bộ tập run và giới hạn |
| Thêm schema/versioning không cần thiết | Major: tăng scope/compatibility cost | Chưa có evidence bắt buộc framework mới | Mặc định không thêm; AM xử lý kỹ thuật có evidence, owner chỉ khi chạm guardrail thuộc owner |

## 7. Acceptance criteria của plan

- [ ] Mục tiêu, in/out scope và O1–O6 nhất quán; evidence hiện tại tách khỏi khảo sát lịch sử và assumptions.
- [ ] SL mapping đầy đủ outcomes/criteria tới tickets và verification trước dispatch, không bị áp đặt số ticket hoặc file phải sửa.
- [ ] Hai phương án cùng AC/guardrails qua report/verification/review, proof riêng đúng revision; sai hành vi dù đúng guidance vẫn bị chặn.
- [ ] Runtime tests và agent evaluation có protocol, evidence và kết luận riêng; evaluation chốt trước chạy, báo cáo toàn bộ runs.
- [ ] Audit governed/legacy và inventory budget đầy đủ trong phạm vi; chỉ sửa gate khi có reproducer entrypoint, giữ regression file không đổi.
- [ ] Negative tests bảo vệ contract, manifest/budget, coverage, verification, independent review và exact evidence.
- [ ] Witness repair/Stop/Resume giữ quyền, contract, không sinh owner request chỉ do khác guidance; không viết lại recovery.
- [ ] Rollback bảo vệ execution cũ/mới đã bắt đầu; drain gồm checkpoint còn quyền Resume, có binding proof hoặc chặn phần chưa bảo đảm.
- [ ] Không mặc định đổi schema/framework; approval đúng identity/revision/SHA-256 theo contract Node. Lưu tài liệu hoặc lập SP không tự RUN/dispatch.
