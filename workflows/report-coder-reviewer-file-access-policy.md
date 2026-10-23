<!-- Ghi lại phần triển khai phân quyền đọc và ghi theo execution, bằng chứng kiểm tra và giới hạn rollout. Báo cáo giúp owner và các vai trò điều phối phân biệt code đã kiểm chứng với các quyết định bảo mật, tích hợp sandbox và bằng chứng vận hành chưa hoàn tất. -->
# Báo cáo triển khai: Quyền truy cập dự án của Coder và Reviewer

**Ngày:** 2026-10-22

**Kế hoạch:** `workflows/plan-coder-reviewer-file-access-policy.md`

**Trạng thái:** Đã triển khai contract và các boundary được mô tả dưới đây trong workspace; chưa hoàn tất toàn bộ O1–O6 hoặc đủ điều kiện rollout. Không sửa trạng thái approval của plan, không dispatch và không commit/push.

## 1. Phần đã triển khai

- `execution-file-access.js` phát hành grant version 2 từ cấu hình Node, tách read paths/prefixes khỏi write paths/prefixes và cố định scope tại lúc cấp.
- Grant gắn task, execution, project root, agent và role. Bản copy/JSON, sai version, sai execution hoặc thiếu provenance không được dùng như grant hợp lệ.
- Identity của policy gồm id, revision và SHA-256. Callback Node `authorizeCurrent` quyết định authority hiện hành; không tự suy ra thời điểm thu hồi từ checkpoint hay tài liệu repository. Callback phải trả `true` đồng bộ; thiếu authority hoặc trả Promise đều không mở quyền.
- Callback `authorizeResume` là điều kiện riêng khi khôi phục execution. Không nhập grant từ checkpoint vào `createExecutionContext`; Node phải reconcile trước khi phát hành grant mới.
- Runtime governance giữ grant qua dispatch; engineering binding không cho agent thay grant. Read scope không thay manifest, mutable-file budget, commit ledger, push grant hoặc verification authority.
- Workflows, glossary, các file chỉ dẫn điều hành tiêu chuẩn và dependency không được mở ghi bằng grant mới. Docs cần exact file grant và callback phân loại có thẩm quyền của Node; thiếu callback thì chặn ghi docs. Callback phải được gắn với nguồn governance đã duyệt, không lấy quyết định của agent làm authority.
- Tree/list/search/direct read và graph metadata sử dụng read scope của contract mới. Cached text search lọc path trước khi đọc cache; mất authority thì không trả nội dung đọc về agent.
- Reviewer có ticket evidence dùng source từ commit cố định, hoặc môi trường verification bất biến đã gắn với artifact; không fallback cache/live source cho caller ngoài diff. Tree/list/search dùng cùng nguồn snapshot. File ngoài snapshot bị từ chối thay vì lấy working tree.
- Kết quả đọc của Reviewer có commit/checksum provenance; nguồn verification environment được nhận diện riêng. Các tool Git đọc working tree không được đăng ký trong snapshot review; `review_diff` vẫn đọc revision cố định.
- Đồng bộ prompt Claude/Codex, rulebook Coder/Reviewer và các tests cũ đang diễn đạt docs là vùng cấm đọc.

## 2. Cách tích hợp và giới hạn tương thích

`createRuntimeToolGovernance` nhận tùy chọn Node `fileAccessPolicy`, gồm `readPaths`, `readPrefixes`, `policyIdentity`, `authorizeCurrent` và các resolver tùy chọn `authorizeDocsWrite`, `authorizeResume`.

- Đây là API nội bộ cho trusted Node composition; không phải field cho agent, payload ticket hoặc checkpoint.
- Chưa cấu hình tùy chọn này ở composition production. Execution hiện tại không tự được nâng sang read scope version 2.
- Context legacy hiện có tiếp tục scope cũ; Coder thiếu cả file/prefix scope không được fallback thành quyền đọc toàn dự án. Đây không phải bộ migration/version-provenance đầy đủ cho toàn bộ legacy consumers.
- Grant version 2 là authority trong bộ nhớ; restart cần Node reconcile và phát hành lại bằng nguồn tin cậy. Không deserialize object để khôi phục quyền.
- Đường Codex CLI cho Coder version 2 bị từ chối trước khi chạy SDK vì chưa chứng minh có thể vô hiệu hóa mọi native filesystem route. Không dùng sandbox read-only làm bằng chứng native read parity.
- `run_check` của Coder version 2 bị khóa vì subprocess filesystem parity chưa được chứng nhận. Không fallback sang shell hoặc service legacy để hoàn tất ticket.
- Các đường Coder legacy không bị tự chuyển sang policy mới chỉ vì prompt đã cập nhật; tool denial vẫn có hiệu lực.

## 3. Inventory các đường truy cập

| Role/mode | Boundary hiện tại | Kết quả / giới hạn |
| --- | --- | --- |
| Coder Claude / Forge version 2 | SDK được cấp `tools: []`; tool Node qua engineering binding và runtime governance | Contract mới có kiểm tra read/write, provenance và current authority; chưa có smoke provider live hoặc chứng minh path race đầy đủ. |
| Coder Codex CLI version 2 | Có native filesystem routes chưa chứng minh bị vô hiệu hóa | Không được admission; lỗi `FILE_ACCESS_PROVIDER_UNSUPPORTED`, không fallback. |
| Coder verification version 2 | Subprocess chạy focused checks | `run_check` bị khóa; cần boundary tương đương trước khi mở. |
| Coder legacy / các mode khác | Giữ các boundary hiện hữu | Không tuyên bố parity version 2; không cấp read scope mới. |
| Reviewer có ticket evidence | Source commit/environment bất biến; snapshot tree/list/search/read | Không dùng cache/live source làm evidence cho file ngoài diff; sai revision bị từ chối. |
| Reviewer dependency reads | Source snapshot hoặc recorded verification environment | Không fallback đọc dependency live khi review snapshot thiếu file. Dependency discovery chưa có evidence phù hợp bị từ chối. |
| Reviewer checks | Cơ chế archive/check hiện hữu | Chưa chứng minh đầy đủ sandbox subprocess, installed-dependency isolation và parity với môi trường artifact; không coi đây là bằng chứng hoàn tất F1/F2/O4. |
| Reviewer legacy/owner conversation | Các read tools hiện hữu | Không tự chuyển thành ticket snapshot nếu không có source/evidence cố định. |

## 4. Mapping nghiệm thu và phần còn thiếu

| Outcome | Bằng chứng trong code/tests | Trạng thái còn lại |
| --- | --- | --- |
| O1 | Đọc caller ngoài immutable manifest; ghi caller bị chặn; create scope và budget vẫn kiểm tra. | Cần cấu hình cấp grant từ authority production đã duyệt; chưa bật rollout. |
| O2 | Docs đọc được; prefix không đủ cấp ghi; version 2 chặn workflows/governance dù có exact grant; prompt/rulebook đồng bộ. | Nguồn phân loại governance có authority/identity/revision/SHA vẫn cần được chốt và nối vào resolver Node. |
| O3 | Tree/list/search/read/cache và graph có allow/deny controls; protected paths, alias, prefix gần giống, symlink tĩnh có kiểm tra. | Chưa chứng minh chống symlink thay giữa check/use đối với live filesystem bằng boundary nguyên tử. Không coi lstat hoặc hậu kiểm là bằng chứng xử lý đủ race. |
| O4 | Caller ngoài diff cùng snapshot; cache stale không thay source; artifact tamper/revision mismatch bị chặn; Reviewer không có source-write tools. | Chưa hoàn tất subprocess/environment isolation của Reviewer checks và independent review. |
| O5 | Resume cần Node reconciliation; version/copy/cross-execution/current authority có negative tests; route chưa hỗ trợ bị chặn. | Chưa có compatibility matrix đầy đủ mọi adapter, restart/migration production hoặc quyết định thu hồi giữa execution. |
| O6 | Có focused unit/tool tests và lint cho các file thay đổi. | Chưa có smoke coding → verification → review theo version 2, provider live hoặc độc lập review; chưa được đánh dấu hoàn tất. |

## 5. Quyết định và công việc còn chặn rollout

1. AM/owner chốt nguồn phân loại governance có thẩm quyền và identity/revision/SHA để Node dùng cho docs writes.
2. AM/owner chốt thời điểm thu hồi quyền đối với execution đang chạy, bao gồm hành vi với operation đã bắt đầu. Callback Node là điểm tích hợp, không phải quyết định thay owner.
3. Hoàn thiện boundary filesystem chống check/use race; chứng minh cache/index không trả dữ liệu theo grant đã hết hiệu lực bằng integration tests tại boundary thực tế.
4. Chứng nhận hoặc vô hiệu hóa native/subprocess routes còn lại; đối chiếu Reviewer checks với môi trường artifact và dependency isolation. Không mở khóa chỉ để đạt smoke PASS.
5. Hoàn thiện provenance/migration cho legacy consumers, restart và mọi provider/mode thực sự hỗ trợ; sau đó chạy smoke và independent review trước rollout.

Các mục 1–2 cần nguồn quyết định có thẩm quyền; các mục 3–5 là công việc kỹ thuật/evidence còn lại, không được diễn giải thành đã đạt chỉ vì focused tests pass.

## 6. Kiểm tra

- Chỉ chạy các unit/tool tests liên quan authorization, runtime governance, scope/resume, snapshot review, discovery và prompt; không chạy full project suite.
- Lượt chạy tổng hợp focused: **108/108 tests đạt, 0 fail, 0 skip**, trong 16 test files liên quan; không cộng các lượt chạy lặp lại vào số PASS.
- ESLint trên các JavaScript files thay đổi đạt; kiểm tra diff đạt; 27 file code/tài liệu được kiểm tra đều không vượt 250 `code_lines`.
- Chưa chạy provider live, smoke version 2, rollout hoặc thay đổi approval.
