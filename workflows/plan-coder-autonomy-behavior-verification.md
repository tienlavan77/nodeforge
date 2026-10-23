<!-- Kế hoạch tăng quyền tự quyết triển khai của Coder và nghiệm thu bằng hành vi có bằng chứng. -->
# Plan: Coder tự quyết cách làm, nghiệm thu bằng hành vi

Trạng thái: đề xuất để owner review; chưa được approve, không phải Sprint Plan hay quyền RUN.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** nếu AC, prompt hoặc gate biến hướng triển khai thành yêu cầu bắt buộc, Coder vẫn phải làm đúng checklist dù được tuyên bố có quyền tự quyết.
- **Kết quả:** Coder tự chọn giải pháp trong boundary; cách làm khác đề xuất vẫn được nghiệm thu khi đạt hành vi, contract, guardrails và bằng chứng bắt buộc.
- **Giá trị:** giảm xin phép không cần thiết, tránh sửa code chỉ để khớp checklist; không giảm chất lượng hoặc quyền kiểm soát scope.
- **Yêu cầu đã chốt trong hội thoại:** tăng quyền tự quyết, kiểm tra hành vi đạt được; không cho Coder tự hạ điều kiện đạt.

## 2. Phạm vi

### In scope

- Đồng bộ rulebook Architecture, SL, Coder, Reviewer theo nguyên tắc trên.
- Đồng bộ prompt lập SP/tạo và tái tạo ticket, dispatch Coder, review và các nhánh repair/resume liên quan.
- Phân biệt outcome/contract/guardrail bắt buộc với implementation guidance không bắt buộc.
- Khảo sát gate máy; sửa có mục tiêu nếu gate đang ép sửa một file/lớp triển khai chỉ vì suy luận từ câu chữ thay vì ràng buộc có thẩm quyền.
- Giữ mapping outcome → ticket AC → verification/evidence; kiểm thử cả quyền tự quyết và các trường hợp phải chặn.
- Làm rõ mâu thuẫn file budget trong rulebook dựa trên policy/schema/runtime hiệu lực, không tự bỏ budget ticket.

### Out of scope

- Cho Coder tự sửa AC, public contract, file budget, quyền ghi hoặc manifest đã khóa.
- Bỏ independent review, exact-revision evidence, checksum, approval, security hoặc terminal gates.
- Tái thiết toàn bộ pipeline, đổi storage/approval model, refactor ngoài phạm vi, tự sửa `.forge/`.
- Tự chuyển đổi ticket đã khóa hay áp dụng lại approval cũ cho revision mới.
- Thiết kế riêng retry/escalation của blocker recovery; chỉ đồng bộ guidance liên quan nếu delivery xác minh có sử dụng.

## 3. Hướng tiếp cận và guardrails

### 3.1. Hợp đồng kết quả và quyền tự quyết

> AC là hợp đồng về hành vi, không phải chỉ dẫn thi công. Coder được tự chọn giải pháp, cách tổ chức code, helper/thuật toán và bổ sung kiểm thử trong boundary đã cấp. Không cần xin duyệt chỉ vì khác hướng đề xuất. Reviewer đánh giá hành vi, contract, guardrails, regression và evidence; không từ chối chỉ vì khác cách làm dự kiến.

| Nội dung | Bắt buộc giữ | Coder tự quyết |
| --- | --- | --- |
| AC | Hành vi quan sát được và điều kiện đạt | Cách tạo ra hành vi |
| Contract/guardrails | API, dữ liệu, security, compatibility, repo rules có hiệu lực | Chi tiết nội bộ không làm đổi ràng buộc |
| Verification | Coverage đầy đủ, checks bắt buộc, evidence đúng revision | Bổ sung test, dữ liệu, edge cases và focused checks trong boundary |
| Guidance | Chỉ chi tiết được xác định rõ là ràng buộc có thẩm quyền mới bắt buộc | Đổi cách làm so với đề xuất mà không cần replan |
| File scope | Quyền ghi, manifest và budget đã cấp | Không phải sửa mọi candidate/manifest file nếu không cần |

- SL làm rõ hành vi và proof obligations, không tạo checklist thao tác nhằm khóa giải pháp của Coder.
- Chi tiết triển khai chỉ trở thành constraint khi có lý do contract/security/compatibility hoặc yêu cầu owner rõ ràng; phải ghi nguồn thẩm quyền và lý do. Không dùng nhãn constraint để hợp thức hóa sở thích cá nhân.
- Giữ nguyên AC/coverage đã duyệt theo contract lưu trữ; không bỏ đối chiếu identity/câu chữ chỉ để làm admission dễ hơn. Đổi cách viết AC áp dụng trước khi khóa ticket mới.
- Coder được thêm kiểm thử nhưng không tự thay verification plan đã khóa, bỏ check bắt buộc hoặc coi focused check là đủ thay final verification.
- Nếu cần vượt manifest/budget hoặc đổi contract: chuyển SV/SL theo đường hiện hành; SL xử lý delivery trong thẩm quyền, AM xử lý vượt SP, owner chỉ quyết thay đổi thuộc quyền owner. Không mặc định mọi khác biệt triển khai là escalation.

### 3.2. Các lớp cập nhật

- **Rule:** bốn rulebook là nguồn chính về quyền và nghiệm thu; có ví dụ AC tốt/xấu, phân biệt guidance và constraint, không sinh thêm bộ rule trùng lặp.
- **Prompt:** nhắc quyền tự quyết ngay cạnh AC và verification; không để nhánh Codex/Claude, regeneration hoặc repair kéo trở lại checklist. Giữ protocol/tool instructions bắt buộc: tự quyết giải pháp không đồng nghĩa tự đổi giao thức Forge.
- **Schema:** mặc định giữ contract hiện tại. Không thêm field quyền hạn chỉ để lặp rule. Chỉ đề xuất schema change khi discovery chứng minh không thể truyền/phân biệt constraint và guidance bằng contract hiện có; phải xác định consumers, versioning, migration/rollback trước khi triển khai.
- **Validator/runtime:** giữ schema/coverage/evidence gates. Đối với gate suy luận từ từ khóa và loại file, phải chứng minh nó đang bảo vệ ràng buộc bắt buộc hay chỉ ép cách làm; sửa trường hợp thứ hai bằng điều kiện có evidence, không xóa toàn bộ scope gate.
- **Reviewer:** finding bắt buộc chỉ ra hành vi/contract/rule vi phạm hoặc rủi ro cụ thể kèm evidence; guidance đơn thuần không phải lý do request changes. Không ép mọi finding chỉ gắn AC vì security/repo rules vẫn có hiệu lực.

### 3.3. Dependency, compatibility và rollout

- Chốt semantics bắt buộc/đề xuất trước khi đồng bộ prompt và runtime; chứng minh coverage/evidence gates còn nguyên trước khi rollout.
- Áp dụng theo revision mới cho ticket mới; ticket đã khóa giữ nguyên contract. Ticket cũ có AC khóa cách làm phải qua quy trình replacement/replan hiện hành, không diễn giải lại âm thầm.
- Giữ review gate on/off theo policy hiệu lực; plan không tự bật/tắt gate hoặc thay quyền production acceptance.
- Rollout owner kỹ thuật: SL phối hợp SV/runtime maintainer sau approval; Reviewer độc lập xác nhận evidence. Không có cam kết thời gian hay production acceptance ở đây.
- Rollback: hoàn nguyên rule/prompt/runtime bằng delivery được review; không sửa lịch sử artifact/approval và không đổi semantics giữa execution của bất kỳ ticket nào đã bắt đầu, kể cả ticket mới chạy theo revision mới. Resume/repair phải giữ contract và quyền theo phiên bản đã bind lúc bắt đầu, không lấy policy mới nhất để diễn giải lại.
- Trước rollout, xác minh snapshot/version binding hiện có bao phủ rule, prompt, runtime semantics và các nhánh repair/resume hay chưa; snapshot Reviewer riêng lẻ chưa đủ chứng minh toàn luồng. Có witness rollback khi ticket revision mới đang chạy và Stop/Resume sau rollback. Nếu binding chưa đủ, ghi giới hạn rollout và điều kiện vận hành an toàn được kiểm chứng; chặn rollout phần chưa bảo đảm, không âm thầm đổi contract hoặc mở rộng thành dự án versioning.
- **Drain và cutover:** ticket rollout phải xét mọi execution bị ảnh hưởng còn khả năng tiếp tục, bao gồm checkpoint đang dừng nhưng còn quyền Resume, không chỉ process đang chạy. Không được coi hết process đang chạy là đã drain an toàn. SL/runtime maintainer phải có evidence nhận diện nhóm này và chứng minh cách giữ semantics đã bind khi Resume qua cutover/rollback, hoặc điều kiện drain thực sự loại bỏ khả năng tiếp tục bị đổi semantics theo cơ chế hiện hành. Nếu chưa chứng minh được thì chặn cutover phần liên quan. Ưu tiên cơ chế snapshot/binding sẵn có; không thêm schema/versioning framework nếu discovery chưa chứng minh cần thiết.
- Nếu có schema extension, consumer compatibility, migration và rollback là điều kiện tiên quyết riêng.

## 4. Khu vực dự kiến ảnh hưởng và evidence

Repository discovery hoàn tất cho phạm vi lập đề xuất; chưa khảo sát đầy đủ mọi runtime consumer. Các vùng dưới đây là hướng discovery cho SL, không phải manifest hay danh sách file bắt buộc sửa.

| Thành phần / khu vực | Vai trò và fact đã xác minh | Evidence |
| --- | --- | --- |
| Architecture rulebook | §3–6 đã tách outcome và delivery nhưng §6 còn ghi trần bốn mutable files | [Evidence: workflows/agents/architecture/README.md, §3–6] |
| SL rulebook | Ticket contract mục 2–4 dùng budget dương theo ticket, không trần bốn file toàn cục | [Evidence: workflows/agents/sprint-leader/README.md, Ticket contract and granularity] |
| Coder rulebook | Đã yêu cầu smallest safe change, giữ contract và focused tests; cần làm rõ quyền tự quyết không xin phép vì khác guidance | [Evidence: workflows/agents/coder/README.md, Mission; Implementation and verification] |
| Reviewer rulebook | Đã cấm personal style findings và yêu cầu exact-revision evidence | [Evidence: workflows/agents/reviewer/README.md, Independence and scope; Review checks] |
| Prompt lập SP | Có outcome coverage, frozen AC repair, verification mapping; không nên nới bằng bỏ các ràng buộc này | [Evidence: backend/src/application/sprint-plan-leader.js, buildPlanPrompt, lines 64–83] |
| Prompt dispatch Coder | Hai builder Codex/Claude đã cho tự discovery; immutableScope vẫn khóa exact paths và Node chạy verification sau commit | [Evidence: backend/src/modules/supervisor/nodeforge-task-prompts.js, buildCodexTicketPrompt; buildToolTicketPrompt; formatVerificationPlan] |
| Schema và validator | AC là array chuỗi; verification có criterion_ids/kind và validator yêu cầu coverage mọi AC. Đây chưa phải bằng chứng schema đang khóa thuật toán/helper | [Evidence: schemas/governance/ticket.schema.json, lines 43–68] [Evidence: backend/src/modules/governance/ticket-verification-contract.js, assertTicketVerificationContract] |
| Report completion — governed và legacy | assertReportScope chỉ được gọi khi !governed; không được quy gate ép loại file này thành nguyên nhân chính của Coder production. validateGovernedScope đối chiếu committed delta, không bắt sửa mọi manifest file | [Evidence: backend/src/tools/agent-report-tool.js, lines 30–58, 149–166] |
| Regression scope hiện có | Test structured completion explanation cho phép đổi a.js và giữ b.js nguyên, rồi ghi report submitted_for_review; đây là fixture report, chưa phải bằng chứng chạy agent production | [Evidence: backend/tests/unit/ticket-report-artifact-gate.test.js, lines 98–118] |
| Validator file budget đã đối chiếu | assertSprintPlanGovernance chỉ yêu cầu file_budget nguyên dương, không áp trần bốn tại hàm này; chưa kết luận mọi schema/admission path đều đã bỏ trần | [Evidence: backend/src/application/sprint-orchestration-service.js, lines 216–230] |
| Automatic review | prepare đọc và snapshot Reviewer rulebook; policy gate/repair budget không được đổi giữa execution | [Evidence: backend/src/modules/supervisor/automatic-ticket-review.js, prepare, lines 18–49] |
| Workflow rules | WF-004 giữ Reviewer độc lập; WF-005 giữ changed files trong allowlist; WF-006 yêu cầu recorded verification | [Evidence: rules/forge-sprint-delivery.rules.json, WF-004–WF-006] |

Các entrypoint khác đã tìm thấy bằng content search nhưng chưa đọc đầy đủ: ticket-sprint-leader.js, ticket-crud-service.js, plan-handoff-service.js, review-worker.js dưới backend/src/. SL phải xác minh trước khi chốt thay đổi; không coi mọi entrypoint đều đang vi phạm.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Quyền tự quyết xuyên suốt AM → SL → Coder → Reviewer | Bốn rulebook thống nhất hợp đồng hành vi; Coder được thay giải pháp/thêm test trong boundary không xin phép; Reviewer không reject chỉ vì khác guidance. Mâu thuẫn file budget được giải quyết theo evidence hiệu lực | Không đổi quyền ghi hay tự hạ AC |
| O2 | Ticket và prompt không khóa đường đi vô cớ | Prompt SP/tạo/tái tạo ticket, Coder và review trong các luồng được hỗ trợ thể hiện cùng semantics; có fixture AC hành vi và guidance tách biệt; repair giữ nguyên frozen contract. Không có bước yêu cầu duyệt chỉ do đổi helper/thuật toán | O1; giữ protocol/tool contract |
| O3 | Máy không chặn giải pháp hợp lệ chỉ vì khác cách triển khai dự kiến | Audit tách production governed và legacy: ghi entrypoint/call path, điều kiện kích hoạt, constraint bảo vệ, kết luận giữ/sửa và evidence. Trước khi sửa gate phải tái hiện trường hợp bị chặn sai qua entrypoint thực sự bị ảnh hưởng; không mặc định assertReportScope là nguyên nhân production. Fixture committed delta hợp lệ được qua gate thích hợp; giữ regression file không đổi. Thay gate có positive/negative tests; không tái hiện được thì ghi chưa có căn cứ sửa | O1; giữ manifest, budget, artifact identity và coverage |
| O4 | Nghiệm thu qua pipeline hỗ trợ, không chỉ hai hàm cùng pass test | Ít nhất hai phương án nội bộ khác nhau, cùng AC/guardrails trong boundary, đều đi qua luồng report/verification/review được hỗ trợ và được nghiệm thu với artifact/evidence riêng, bind đúng revision/commit của từng phương án; không dùng lại proof giữa revisions. Phương án khớp guidance nhưng sai hành vi bị từ chối với evidence chỉ rõ tầng chặn. Có assertion hành vi thực thi và review disposition, không chỉ snapshot prompt hay unit test hai hàm | O2, O3; Reviewer độc lập; tách runtime tests và agent evaluation |
| O5 | Nới quyền không làm yếu gate hoặc tái tạo escalation vô cớ | Negative tests chặn thiếu AC coverage, bỏ check bắt buộc, vượt manifest/budget, sai contract, evidence stale/hash mismatch và tự approve. Test bổ sung không thay final verification. Witness tích hợp repair/resume: Coder đổi helper/thuật toán trong boundary không sinh yêu cầu owner mới; nếu Stop rồi Resume thì giữ contract, quyền ghi và quyền tự quyết đã bind, tiếp tục qua verification/review hiện hành | O2, O3; giữ recovery protocol, không thiết kế lại blocker recovery |
| O6 | Handoff và rollout có thể audit, không đổi semantics giữa execution | Mapping mọi outcome/AC tới ticket và verification; ghi affected consumers, compatibility và rollback. Bảo vệ ticket khóa cũ lẫn ticket mới đã bắt đầu theo revision mới, kể cả repair/resume sau rollback; không mutate contract hoặc tái sử dụng approval. Có kết luận đủ/thiếu snapshot/version binding, witness rollback giữa execution và giới hạn rollout nếu thiếu; không rollout phần chưa bảo đảm. Schema change cần consumer/migration evidence trước dispatch | O1–O5; §3.3 |

**Gợi ý delivery, không bắt buộc:** audit và thống nhất rule semantics; đồng bộ prompt và gate có evidence; chạy behavioral/regression witnesses rồi rollout cho ticket mới. SL quyết số ticket, trình tự, file budget và manifest.

Verification phải tách rõ bằng chứng máy và đánh giá agent:

- **Runtime tests xác định được:** schema/coverage và behavioral assertions; fixture tích hợp đi qua entrypoint report, verification và review được hỗ trợ, dùng artifact đúng revision và ghi disposition của từng phương án. Có thể dùng provider/reviewer doubles tại boundary đã khai báo; phải ghi tầng thật/tầng giả lập. Không cần chạy agent thật trong mọi unit test, nhưng hai hàm cùng pass test không đủ đạt O4.
- **Evaluation hành vi agent:** scenario riêng đánh giá Coder thực sự chọn cách khác guidance và Reviewer không reject chỉ vì khác cách làm. Trước khi chạy, SL/evaluation owner chốt trong ticket verification: provider/model được đánh giá, cấu hình, số run, phạm vi, tiêu chí pass/fail và cách phân biệt lỗi hệ thống/tool/provider với biến thiên hành vi agent; quy định cách xử lý run lỗi hoặc chưa xác định và điều kiện chạy lại. Lưu contract revision, transcript/report, artifact/evidence và kết quả của toàn bộ tập run, kể cả run lỗi/chạy lại, kèm phân loại và giới hạn kết luận theo provider/model đã đánh giá. Không chọn riêng một run thành công để kết luận chung, không đặt chuẩn agent luôn luôn đúng, và không lấy prompt snapshot hoặc runtime double làm chứng cứ agent đã hành xử đúng. Đây là chi tiết verification do SL/evaluation owner cụ thể hóa trước chạy, không mở thêm vòng thiết kế hay approval ngoài contract hiện hành.
- **Witness tích hợp có giới hạn:** đổi helper/thuật toán → repair hoặc Stop/Resume → verification/review, kiểm không phát sinh owner request chỉ do đổi guidance và quyền/contract vẫn giữ. Thêm witness rollback khi ticket revision mới đang chạy, bao gồm Resume sau rollback. Đây là kiểm chứng tích hợp, không mở rộng scope sang thiết kế lại recovery/versioning.
- Mỗi witness ghi entrypoint, revision/commit, artifact/evidence và tầng nghiệm thu/chặn. Kết quả runtime và agent evaluation báo cáo riêng; không tuyên bố một lớp chứng minh thay lớp kia.

SL phải mapping mỗi outcome/criteria tới một hoặc nhiều ticket và checks phù hợp; không bỏ/giảm tiêu chí hay biến ví dụ thành checklist code bắt buộc.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| Hai rulebook không thống nhất file cap | Major: delivery tiếp tục bị siết giả | §4: validator được đọc chỉ kiểm nguyên dương; chưa chứng minh mọi schema/admission path không còn trần bốn | SL lập inventory schema/admission consumers và kết quả đối chiếu từng path; AM chốt reconciliation, không suy rộng từ một validator |
| Nhầm gate legacy là blocker production | Major: sửa sai chỗ, không giải quyết pain point | assertReportScope chỉ ở !governed; validateGovernedScope và test file không đổi đã có (§4) | SL/Coder truy vết production/legacy riêng và tái hiện sai qua entrypoint trước khi đề xuất sửa; AM xác nhận semantics |
| Snapshot/version binding không đủ khi rollback hoặc Resume | Blocker rollout phần bị ảnh hưởng | Chưa audit đủ; snapshot Reviewer không chứng minh rule/prompt/runtime cùng được bind | SL/runtime maintainer xác minh binding và witness §3.3/O6; ghi giới hạn rollout nếu thiếu, không đổi semantics giữa execution |
| Escalation tái xuất hiện qua repair/resume | Major | Chưa có witness tích hợp cho quyền tự quyết trong plan này | SL cung cấp witness O5; ghi gaps, không mở dự án viết lại blocker recovery |
| Guidance ẩn trong AC cũ | Major | Giả định tương thích cần phòng ngừa, không khẳng định mọi ticket cũ mắc lỗi | SL phân loại trước dispatch; dùng replacement/replan, không tự hạ AC |
| Thêm test cần file ngoài manifest | Blocker cho ticket đó, không phải thiếu quyền chọn test case | Manifest vẫn là boundary bắt buộc trong prompt đã đọc | SV/SL điều chỉnh delivery theo cơ chế hiện hành; không cho Coder tự mở quyền |
| Prompt khác nhau theo entrypoint/provider | Major | Hai builder đã đọc; các entrypoint khác còn cần truy vết | SL audit producer → dispatch → review → repair/resume, ghi rõ coverage và gaps |
| Schema extension có thật sự cần? | Có thể tăng complexity và migration không cần thiết | Chưa có evidence bắt buộc thêm field mới | Mặc định không đổi; AM quyết kỹ thuật khi có bằng chứng, owner chỉ khi chạm guardrail owner |
| Agent vẫn tuân thủ checklist dù prompt đã đổi | Major | Giả định cần đánh giá, test text không đủ | Reviewer/eval owner dùng behavioral witnesses, ghi giới hạn đánh giá |

Không có tradeoff owner mới cần hỏi lại từ yêu cầu hiện tại. Các unknown kỹ thuật được ủy quyền phải khảo sát và tự quyết trong boundary; chỉ escalate nếu evidence chỉ ra xung đột thẩm quyền thật sự.

## 7. Acceptance criteria của plan

- [ ] Mục tiêu là tăng quyền tự quyết Coder và nghiệm thu bằng hành vi, không chỉ nới SL.
- [ ] Scope, guardrails, guidance và assumptions được tách rõ; repository facts có evidence.
- [ ] O1–O6 được SL mapping đầy đủ vào ticket AC và verification, không áp đặt số ticket/file manifest trước.
- [ ] Hai phương án dùng chung AC/guardrails đi qua report/verification/review hỗ trợ, artifact/evidence riêng đúng revision; phương án đúng guidance nhưng sai hành vi bị chặn. Runtime tests và agent evaluation có evidence/kết luận riêng.
- [ ] Audit phân biệt production governed/legacy, chứng minh entrypoint bị chặn sai trước khi sửa; giữ regression cho manifest file không cần đổi. File budget được đối chiếu mọi schema/admission path liên quan, không suy rộng từ một validator.
- [ ] Gate manifest/budget, contract, independent review và exact evidence vẫn được kiểm tra bằng negative tests.
- [ ] Witness repair/Stop/Resume giữ quyền và contract, không sinh owner request chỉ vì đổi helper/thuật toán trong boundary; không thiết kế lại recovery.
- [ ] Không mặc định phải đổi schema; mọi runtime change có evidence và regression proof.
- [ ] Rollback bảo vệ ticket cũ và ticket revision mới đang chạy, kể cả Resume; có kết luận snapshot/version binding và giới hạn rollout nếu thiếu. Ticket/revision không bị diễn giải lại, mutate hoặc tái sử dụng approval.
- [ ] Approval phải theo đúng identity/revision/SHA-256 hiệu lực; tạo tài liệu hoặc lập SP không tự RUN/dispatch.
