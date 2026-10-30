<!-- Kế hoạch kiến trúc để tách quyền đọc khám phá khỏi quyền ghi theo ticket và đồng bộ các lớp policy. -->
# Plan: Đồng bộ quyền truy cập dự án của Coder và Reviewer

**Ngày:** 2026-10-22  
**Trạng thái:** Dự thảo để owner xem xét; chưa approve, chưa cho phép triển khai.  
**Yêu cầu:** Lập kế hoạch sửa các điểm lệch quyền đọc/ghi đã thảo luận, lưu trong `workflows/`.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** Coder cần đọc caller, consumer, contract và tests ngoài manifest để hiểu thay đổi; prompt, tests và enforcement hiện diễn đạt quyền không đồng nhất [E1–E6].
- **Kết quả:** Coder và Reviewer đọc được vùng dự án an toàn theo grant; Coder chỉ ghi trong ticket; Reviewer không sửa source. Mọi đường truy cập thực thi cùng ma trận quyền, kể cả resume.
- **Giá trị:** Giảm blocker giả do thiếu context nhưng không nới quyền sửa, quyền điều hành hoặc khả năng truy cập secrets.
- Đây là đề xuất chính sách cần approve đúng contract; yêu cầu viết kế hoạch không được diễn giải thành phê duyệt chính sách hay dispatch.

## 2. Phạm vi

### In scope

- Tách read scope khỏi write scope trong context do Node cấp, authorization, tool binding và các consumer liên quan.
- Đồng bộ prompt, rulebook áp dụng, tests và enforcement cho `docs/`, `workflows/` và discovery ngoài manifest.
- Giữ Reviewer read-only với source; kiểm chứng evidence đúng artifact/revision/checksum.
- Kiểm chứng parity giữa các provider/adapter thực sự hỗ trợ coding/review, direct-code, immutable manifest, fresh execution và resume.
- Bảo toàn protected paths, dependency-read, mutable-file budget, grants, commit ledger và review gates.

### Out of scope

- Không cấp filesystem toàn quyền, shell tùy ý, quyền ghi dependency đã cài hoặc quyền sửa source cho Reviewer.
- Không sửa storage/approval contract, acceptance criteria hoặc ticket revision đã khóa.
- Không thay đổi business API, database, schema nghiệp vụ, review verdict semantics hay release authority.
- Không refactor ngoài policy/access propagation; không làm sạch tài liệu lịch sử không còn hiệu lực chỉ để đồng bộ câu chữ.
- Không sửa glossary; giữ pipeline đề xuất thuật ngữ riêng theo `AGENTS.md:12–17`.

## 3. Hướng tiếp cận và guardrails

### 3.1. Ma trận quyền mục tiêu — đề xuất để duyệt

| Vùng | Coder đọc | Coder ghi | Reviewer đọc | Reviewer ghi source |
| --- | --- | --- | --- | --- |
| Source/tests thực tế, ví dụ `backend/`, `ui/`, `web/`, `schemas/` | Có theo safe read grant, ngoài write manifest cũng được | Chỉ manifest hoặc quyền tạo file hợp lệ | Có, ngoài diff cũng được | Không |
| Cấu hình, package/lockfile, scripts an toàn | Có | Chỉ đúng grant của ticket | Có | Không |
| `docs/` kỹ thuật an toàn | Có | Chỉ đúng file được cấp; prefix `docs/` không đủ | Có | Không |
| `workflows/` an toàn | Có | Không, kể cả đưa vào manifest | Có | Không |
| `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md`, rulebook điều hành | Có nếu an toàn | Không trong ticket implementation thông thường | Có nếu an toàn | Không |
| `vocabulary/glossary.md` | Có | Không | Có | Không |
| Dependency trong `node_modules/` | Chỉ cơ chế dependency-read riêng | Không | Chỉ cơ chế dependency-read riêng | Không |
| `.forge/`, `.git/`, secrets/credentials, output/cache bị policy chặn | Không đọc trực tiếp; dùng tool/evidence được cấp | Không | Tương tự Coder | Không |

- Protected-path policy luôn ưu tiên từ chối trước read/write grant; không cho phép manifest hợp thức hóa đường dẫn bị cấm.
- Cấu hình an toàn không đồng nghĩa mọi dotfile được đọc: giữ danh mục chặn hiện hữu; thêm ngoại lệ dotfile nằm ngoài scope này.
- Đối với docs, tài liệu điều hành/approval/architecture vẫn chịu giới hạn governance, không được coi như tài liệu triển khai thông thường chỉ vì nằm dưới `docs/`.
- Implementation của authorization có thể được sửa trong ticket chuyên biệt thuộc plan đã approve; không đồng nghĩa Coder được tự sửa grant/authority của invocation hiện tại.

### 3.2. Tách contract đọc và ghi

- Node cấp và cố định read grant riêng theo execution; agent không được tự sửa hoặc suy ra grant từ prompt, kết quả search hay dữ liệu repository.
- Write authority tiếp tục dựa trên immutable manifest/checksums, authorized-create scope và mutable-file budget của ticket. Read grant không được dùng để authorize write, commit, push hoặc mở rộng verification.
- Giữ `project_wide_access` bị chặn cho Coder; không dùng cờ này làm lối tắt [E1]. Tên field và cách biểu diễn contract do SL xác minh/chọn trong guardrails.
- Thiếu context/grant phải từ chối hoặc đi qua reconciliation đúng thẩm quyền; không fallback thành quyền toàn dự án. Legacy context hợp lệ chỉ giữ quyền cũ, không tự được nâng quyền.
- `search_tree`, `list_files`, `search_text`, index/cache và đọc trực tiếp phải cùng read policy; không lộ tên, snippet, nội dung file bị cấm qua discovery.
- Đọc dependency phải giữ tuyến chuyên biệt và các giới hạn hiện hữu; không chuyển thành quyền list/write toàn bộ `node_modules/`.

### 3.3. Sửa các điểm lệch đã xác nhận

- **`docs/`:** bỏ cấm đọc khỏi prompt direct-code; đổi test đang kỳ vọng đọc docs bị từ chối thành kiểm chứng đọc thành công, ghi chỉ thành công với đúng file grant và manifest hợp lệ [E2, E3, E6].
- **`workflows/`:** giữ read-only cho Coder; bỏ ngoại lệ ghi theo exact ticket/manifest khỏi prompt vì trái enforcement [E3, E4]. Thay đổi rulebook chuyển qua vai trò/luồng đúng thẩm quyền.
- **Immutable manifest:** thay chỉ dẫn chỉ được đọc manifest bằng được đọc trong read scope; chỉ ghi manifest/create scope. Không đổi acceptance, write budget hay revision [E1, E3, E5].
- Rà soát mọi prompt/provider/resume/rulebook đang hiệu lực; chỉ cập nhật nguồn thực sự chi phối execution, không giả định sửa một template là đủ.
- Reviewer giữ các tool đọc/review riêng; findings và receipts lưu qua dịch vụ Node, không qua quyền ghi filesystem tùy ý [E7].

### 3.4. Compatibility, rollout và rollback

- Đây là thay đổi authorization nội bộ, có chủ đích nới đọc, không nới ghi; chưa kết luận không ảnh hưởng public schema trước khi SL khảo sát propagation.
- SL phải xác định consumer/context/checkpoint bị tác động, bổ sung contract/versioning nếu cần; không sửa ticket/revision/approval đã khóa để đưa grant mới vào.
- Grant của execution không được agent sửa; không đồng nghĩa được miễn policy thu hồi. **Semantics thu hồi đối với execution đang chạy chưa được chốt**: AM đối chiếu policy hiệu lực, trình owner nếu thay guardrail/security semantics. Rollout phần liên quan bị chặn đến khi có quyết định có nguồn thẩm quyền, thời điểm hiệu lực và test tương ứng; không mặc định tiếp tục quyền cũ hoặc hủy giữa chừng.
- Khi resume, Node kiểm tra lại policy, version/provenance tin cậy và quyền hiện hành. Contract mới thiếu/sai grant: từ chối. Legacy chỉ dùng policy tương thích khi Node xác thực được version/provenance; thiếu field không chứng minh legacy. Context không xác định hoặc checkpoint bị chỉnh sửa: từ chối hoặc reconciliation có thẩm quyền, không thực thi trước khi giải quyết. Migration/resume không tự tạo read grant hoặc tăng write authority; quyền bị thu hẹp/thu hồi không được phục hồi từ checkpoint.

### 3.5. Guardrails bổ sung theo phản hồi F1–F5

Nguồn góp ý: `workflows/plan-coder-reviewer-file-access-policy-feedback.md:24–110`, SHA-256 `sha256:d3e0007d6426cb7eda1db7446c642087ec44040b968ba3b6e7351fe135f33463`. Đây là góp ý kỹ thuật, không phải approval. Các bổ sung dưới đây là đề xuất của bản dự thảo.

- **F1 — Mọi đường truy cập:** SL lập inventory theo role/provider/mode gồm Forge, SDK native tools, shell/subprocess và verification command nếu được bật. Mỗi đường phải enforce policy tương đương tại boundary hoặc bị vô hiệu hóa; không lấy prompt làm security boundary. Unsupported phải từ chối an toàn, không fallback quyền rộng. Read grant không cấp thêm command, shell hoặc quyền ghi của tiến trình con. Inventory không phải yêu cầu bật thêm đường truy cập.
- **F2 — Snapshot review:** Source dùng cho verdict, kể cả caller/consumer ngoài diff, phải cùng review snapshot và qua safe read policy. Search/list/index/cache và dependency evidence dùng cho verdict phải có provenance tương thích với snapshot/môi trường review. Live context nếu được phép phải gắn nhãn riêng, không thay thế snapshot âm thầm hoặc dùng làm căn cứ verdict khi chưa xác minh. Thiếu snapshot evidence thì báo thiếu/reconcile, không chấp nhận hỗn hợp revision. SL chọn cơ chế snapshot, không bị khóa helper/layout.
- **F3 — Legacy:** Áp dụng phân nhánh version/provenance ở §3.4 cho mọi consumer bị ảnh hưởng; không đổi helper dùng chung mà bỏ sót caller hoặc coi mọi context thiếu scope là legacy hợp lệ.
- **F4 — Governance:** Trước cấp ghi docs phải chỉ ra nguồn policy phân loại có thẩm quyền, identity/revision/SHA và cách Node áp dụng. Agent không tự phân loại hoặc chỉ dựa vào prefix/tên file để mở quyền. Exact grant + manifest không vượt protected/governance deny. SL chọn cách biểu diễn/truyền policy; thiếu nguồn hay xung đột phải về AM/owner theo thẩm quyền, chặn cấp ghi phần chưa rõ.
- **F5 — Path/cache/thu hồi:** Authorization áp dụng cho đối tượng thực sự được đọc/ghi, không chỉ chuỗi path đã kiểm tra trước đó. Bao phủ alias, chuẩn hóa, prefix gần giống và symlink thay giữa check/use. Cache/index tạo dưới grant cũ phải qua authorization hiện tại trước trả tên/snippet/nội dung. Resume và execution đang chạy tuân thủ thời điểm thu hồi được chốt ở §3.4; negative tests luôn có đối chứng allow.

**Giới hạn evidence bổ sung:** Đã đọc lại `engineering-tool-binding.js:1–80`, `tool-authorization.js:1–38`, `reviewer-forge-tools.js:40–119`; whole-file hashes khớp E1/E2/E7 bên dưới. Binding kiểm tra path trực tiếp cho bốn tool; helper có fallback thiếu scope; reviewer có nhánh fallback cache/filesystem ngoài evidence và search dùng filesystem. Đây là căn cứ yêu cầu khảo sát/kiểm thử, **chưa chứng minh có bypass hoặc verdict sai**; các lớp binding/committed-source còn phải xác minh.
- Chỉ bật policy mới sau khi ma trận quyền và regression gates đạt. Cần evidence cùng revision cho code, prompt và tests.
- Rollback quay lại bộ enforcement/context/prompt tương thích trước đó; execution dùng context không tương thích phải dừng/reconcile, không tái diễn giải grant hay chuyển approval sang hash khác.
- Logs ghi role, operation, kết quả allow/deny, policy/context identity và reason code trong hạ tầng hiện hữu; không log secrets hay nội dung file bị chặn.

**Dependency thật sự:** Phê duyệt ma trận quyền mới và guardrails là điều kiện trước triển khai. Contract/provenance tương thích phải rõ trước rollout/resume. SL chủ động phân rã delivery và chọn các bước kiểm chứng.

## 4. Khu vực dự kiến ảnh hưởng và evidence

Evidence là kiểm tra tĩnh bằng Forge ngày 2026-10-22; chưa chạy tests. Hash là whole-file SHA-256 tại lúc đọc, không phải bằng chứng commit hay approval.

| Mã | Khu vực / source | Facts và mức chắc chắn |
| --- | --- | --- |
| E1 | `backend/src/tools/engineering-tool-binding.js:11–75` | Context Coder bị khóa theo scope; chặn project-wide; read/write đi qua cùng scope; write có manifest/create/budget checks. Đã đọc. |
| E2 | `backend/src/tools/tool-authorization.js:20–37` | Cho Coder đọc docs; ghi docs cần exact file; helper có fallback không scope nên phải khảo sát consumer trước khi đổi. Đã đọc. |
| E3 | `backend/src/modules/supervisor/nodeforge-task-prompts.js:14–55` | Direct-code cấm docs; workflow có ngoại lệ ghi; immutable prompt giới hạn cả đọc theo manifest. Đã đọc. |
| E4 | `backend/src/infrastructure/filesystem/file-service-role-policy.js:10–56` | Chặn ghi workflows cho Coder; role access kiểm tra path/protection và symlink; dependency đọc riêng. Đã đọc. |
| E5 | `backend/src/modules/supervisor/nodeforge-task-executors.js:23–55` | Nhánh tool-ticket dựng allowed files/prefixes theo manifest và context rồi bind tools. Đã đọc; chưa kết luận parity mọi nhánh. |
| E6 | `backend/tests/unit/coder-path-permissions.test.js:10–22` | Test kỳ vọng Coder không đọc docs. Đã đọc; chưa xác minh kết quả chạy. |
| E7 | `backend/src/modules/supervisor/reviewer-forge-tools.js:47–125` | Discovery không lấy diff làm read boundary; git tools scope theo evidence; review/check tools có điều kiện; không đăng ký write/commit tools. Đã đọc. |
| E8 | `workflows/agents/architecture/README.md:1–168`; `AGENTS.md:1–33` | Plan theo outcomes; SL sở hữu SP/manifest; không tự approve/RUN; glossary có pipeline riêng. Đã đọc. |
| E9 | `ARCHITECTURE.md:1–70` | Mô tả Node điều phối, Reviewer đánh giá requirements/diff/rules/verification. Chỉ đọc phần đầu; không dùng làm authority thay policy hiệu lực. |

### Snapshot kiểm chứng lại khi handoff

- E1: `sha256:ea462d92c5acb48755f3d61397cea835cb796d433c16362fd4664865ced5755c`
- E2: `sha256:5ea1cff0db9cfdc2c015d08f942085338ddaabc9ec76e7662e12a07fff70a789`
- E3: `sha256:b55b2ff0af95b6215b7db0c1b977be1dee4b4f953e3ae5a8512191e22c609d8a`
- E4: `sha256:787dfa11c9627d4c04791e51c0f4dacb7cc032f718bef32844ef6717c1bba161`
- E5: `sha256:aba0dcf8e15e1e854017689906495bde8f27777871672d3f5d6fb4b52bc24ece`
- E6: `sha256:03a1aac2f0be92f14a69afb42ca4e241c1dd5b6a7f607efbdcba7f84cc70d328`
- E7: `sha256:8faa173f873638a35bc68f4f7b325565fc758a9cc5d38193c14d4db5731e5dbd`
- Rulebook Architecture: `sha256:f89a981f59e443a2613252c2d176ae2753b7a848ddfe90f0cabbe8bd111d0443`
- `ARCHITECTURE.md`: `sha256:21b0dd4f054fe2e8c4862593fb32f25730c94fa98f879d7dd780450b625e3b79`

Các khu vực trên định hướng discovery, không phải mutable-file allowlist. SL phải xác minh consumer, policy identity/revision/SHA đang hiệu lực, scope và tests thực tế trước chốt SP; snapshot không tự chứng minh tài liệu đã approve.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Read/write scope độc lập | Coder đọc source/contract/test ngoài write manifest trong safe read grant; ghi cùng đường dẫn bị chặn nếu thiếu write authority. Test riêng contract mới thiếu/sai grant, legacy có version/provenance do Node xác thực, context không xác định và checkpoint bị chỉnh sửa; phân nhánh theo §3.4, không suy ra legacy từ field vắng mặt. | Ma trận được approve; không bật project-wide; F3. |
| O2 | Docs/workflows thống nhất | Docs an toàn đọc được; prefix docs không cho ghi; exact file grant + manifest chỉ cho ghi docs triển khai được policy có thẩm quyền phân loại. Có evidence identity/revision/SHA của nguồn phân loại. Governance docs trong manifest vẫn bị chặn; workflows không ghi được dù có exact grant. Prompt/tests/rulebook hiệu lực không còn ngoại lệ trái enforcement. | O1; thiếu/xung đột authority thì chặn cấp ghi phần chưa rõ; F4. |
| O3 | Mọi đường truy cập cùng policy | Có inventory role/provider/mode và boundary thực thi cho Forge, native tools, shell/subprocess/verification nếu bật; mỗi đường enforce tương đương hoặc bị vô hiệu hóa. Khi tool chuẩn từ chối path, đường khác cũng không đọc/ghi được. Tree/list/search/read/cache/index không lộ tên/snippet/nội dung bị cấm. Test absolute/traversal, alias/chuẩn hóa, prefix gần giống, symlink ngoài scope và đổi symlink giữa check/use. Dependency chỉ đọc qua tuyến riêng, không ghi. | Deny precedence; không thêm command/shell authority; negative tests có đối chứng allow; F1/F5. |
| O4 | Reviewer độc lập, evidence cùng snapshot | Source dùng cho verdict, kể cả ngoài diff, và search/list/index/cache có provenance tương thích cùng review snapshot; live context được phân biệt và không thay evidence âm thầm. Test caller ngoài diff bị sửa/xóa sau snapshot, cache sai revision, working tree đổi giữa review và thiếu snapshot source. Sai artifact/revision/hash hoặc provenance không xác minh được phải từ chối/reconcile. Reviewer không có write/edit/commit/push/Coder run_check; review checks cần evidence hợp lệ và không đổi working tree Coder. | Giữ review gates; output/receipt do Node quản lý; F2. |
| O5 | Provider, resume và thu hồi tương thích | Ma trận allow/deny cho các đường thực tế trong direct-code/immutable/fresh/resume; unsupported từ chối an toàn, không fallback rộng. Migration/resume không tạo read grant mới hay tăng write authority. Test grant thu hẹp/thu hồi, cache/index từ grant cũ không trả dữ liệu trái quyền hiện tại, checkpoint bị chỉnh sửa và version không xác định. Test execution đang chạy theo thời điểm thu hồi có thẩm quyền đã chốt, không suy diễn giữ quyền từ checkpoint. | Xác minh propagation/versioning; chốt semantics thu hồi trước rollout phần liên quan; F1/F3/F5. |
| O6 | Đủ bằng chứng nghiệm thu | Unit + integration tại từng boundary được bật và smoke coding → verification → review đạt; có test create scope/budget và chặn vượt scope/budget. Báo cáo mapping O1–O6 và F1–F5, inventory đường bật/tắt, nguồn governance, quyết định thu hồi, provenance snapshot, revision/checksum, checks/baseline failures. Review độc lập trước rollout. | SL chọn lệnh/check hợp lệ; không bỏ gate hoặc chặn toàn bộ để lấy PASS. |

### Mapping phản hồi và evidence bàn giao

| Phản hồi | Outcomes | Bằng chứng tối thiểu |
| --- | --- | --- |
| F1 | O3/O5/O6 | Inventory role/provider/mode, boundary native/subprocess nếu bật; allow/deny qua mọi đường hoặc evidence bị vô hiệu hóa. |
| F2 | O4/O6 | Provenance snapshot ngoài diff; test sửa/xóa caller, cache sai revision và working-tree drift; phân biệt live context. |
| F3 | O1/O5/O6 | Test contract mới, legacy xác thực, không rõ version/provenance, checkpoint chỉnh sửa; resume không tự nâng quyền. |
| F4 | O2/O6 | Nguồn phân loại governance có authority/identity/revision/SHA; deny dù exact grant + manifest, và đối chứng docs triển khai hợp lệ. |
| F5 | O3/O5/O6 | Test alias/prefix/symlink race, cache/index sau thu hồi, resume và execution đang chạy theo thời điểm hiệu lực đã chốt. |

**Gợi ý delivery, không bắt buộc:** Khảo sát inventory/contract và các blocker authority trước rollout; SL tự chọn số ticket, thứ tự, helper và manifest, chứng minh đủ coverage. Không buộc mở native tools hay sửa toàn bộ hệ thống ngoài scope để đạt parity.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / xử lý |
| --- | --- | --- | --- |
| Read grant bị dùng nhầm cho write/commit | Blocker | Dùng chung helper/context [E1, E2]. | SL chứng minh tách quyền; Reviewer kiểm tra độc lập. |
| Legacy hoặc checkpoint bị hiểu thành grant mới | Major | Helper có fallback thiếu scope [E2]; chưa khảo sát toàn bộ consumers. | SL xác minh version/provenance/serialization; không tự hợp thức hóa legacy. |
| Nguồn phân loại governance chưa xác nhận | Blocker đối với cấp ghi docs chưa rõ | Chưa có evidence phân loại đầy đủ; F4. | SL tìm nguồn có thẩm quyền; AM giải quyết trong boundary, owner chốt nếu đổi security semantics. Không cho agent tự phân loại để mở quyền. |
| Thời điểm thu hồi đối với execution đang chạy chưa chốt | Blocker rollout phần liên quan | Câu giữ scope trước đây chưa định nghĩa thu hồi; F5. | AM đối chiếu policy hiện hành, trình owner nếu thay guardrail/security semantics; ghi quyết định và test trước bật rollout. |
| Source ngoài diff/cache/search khác review snapshot | Major | Có fallback cache/filesystem và search live trong vùng đã đọc [E7]; chưa kết luận bypass. | SL khảo sát binding/committed-source; O4 chứng minh provenance và xử lý drift. |
| Native tools/subprocess chưa kiểm chứng | Major | Binding chỉ check path trực tiếp cho bốn tool [E1]; inventory thực tế chưa đủ. | SL inventory; enforce tại boundary hoặc disable, không coi prompt là sandbox. |
| Mở đọc tăng context/token hoặc lộ secrets | Major | Có path policy [E4]; an toàn không chỉ do tên thư mục. | Giữ budget/output limits và fixtures giả; không đọc rộng không mục tiêu. |
| Có cần cho Coder ghi workflows? | Ngoài scope | Đề xuất giữ read-only [E4]. | Nếu muốn mở phải replan, không thêm ngoại lệ ngầm. |

**Giả định:** Hướng đọc rộng có kiểm soát, ghi hẹp theo ticket vẫn là đề xuất chờ approval. Tiếp thu phản hồi không phải xác nhận tồn tại lỗ hổng. Semantics thu hồi và nguồn governance chưa được giả định đã chốt. Chi tiết field/helper/test layout thuộc SL trong guardrails.

## 7. Acceptance criteria của plan và handoff

- [ ] Owner xác nhận mục tiêu, in/out scope, ma trận và guardrails theo identity/revision/SHA-256 của artifact Node quản lý; không chuyển approval cũ sang nội dung mới.
- [ ] Xác nhận nguồn phân loại governance có thẩm quyền và quyết định thời điểm thu hồi theo §3.4; blocker được giải quyết trước rollout phần liên quan, không để SL tự đổi security semantics.
- [ ] SL xác minh evidence hiện hành, lập SP/ticket contracts và mapping O1–O6 cùng F1–F5; không tự nới quyền hoặc giảm acceptance criteria.
- [ ] Verification bao gồm các đường truy cập được bật, snapshot ngoài diff, legacy/provenance, path race, cache/index và thu hồi; có allow controls, create/budget, smoke và independent review. Ghi rõ checks chưa chạy và baseline failures.
- [ ] Rollout/rollback có owner vận hành theo workflow hiện hành; rollback không được khôi phục quyền đã thu hồi; context không tương thích dừng/reconcile, không tự RUN/dispatch vì đã lập SP.
- [ ] Phát sinh đổi system boundary, security semantics hay exception workflows phải quay lại Architecture/owner theo thẩm quyền.

**Trạng thái sau phản hồi 2026-10-22:** Đã tiếp thu F1–F5 vào guardrails và outcomes; đọc lại tĩnh E1/E2/E7, không sửa file feedback. Chưa sửa implementation, chưa chạy tests hoặc xác minh provider live, chưa xác minh ticket đang chạy, chưa approve hoặc dispatch.
