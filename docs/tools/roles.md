<!-- Kế hoạch phân quyền công cụ Forge theo vai trò và loại công việc của agent. -->
# Phân quyền tool theo role

## Mục tiêu

Forge sở hữu chức năng của tool, kiểm tra quyền và thực thi. Role quyết định chức năng nào được dùng trong từng loại công việc. Provider quyết định tên, schema và cách gọi mà model nhìn thấy. Vì vậy, tool phục vụ cùng một chức năng có thể mang tên khác nhau trên Codex, OpenAI, Anthropic và Claude; mọi tên đó phải được ánh xạ về một chức năng Forge trước khi kiểm tra quyền.

Giai đoạn đầu triển khai adapter cho Codex và OpenAI. Anthropic và Claude được bổ sung sau mà không phải viết lại chức năng Forge hoặc bảng quyền theo role.

## Quyền conversation hiện đã triển khai

Luồng SDK của Architecture Manager dùng bảng quyền `owner-role-tool-policy.js`. Quyền đọc gồm `rg_files`, `search_tree`, `read_file`, `sed_lines`. `write_diff` và `edit_diff` chỉ được quảng bá khi task của lượt conversation có `candidate_files` mang role `PATCH` trong vùng tài liệu. Khi thực thi, Node kiểm tra lại đúng đường dẫn `PATCH`, quy tắc `.gitignore` và chỉ chấp nhận hiện vật trong `docs/`, `Skills/` hoặc `ARCHITECTURE.md`. Conversation không có phạm vi `PATCH` là chỉ đọc. Cả Codex và OpenAI nhận cùng bộ chức năng Forge theo role; provider chỉ quyết định cách SDK gọi tool.

Bảng quyền conversation hiện khai báo Sprint Leader, Coder và Reviewer là chỉ đọc với cùng bốn tool đọc; Linguist chỉ có `read_file` và `sed_lines`; Runtime không có tool mặc định. Các role này vẫn đi qua luồng gọi agent hiện hữu; bảng quyền conversation mới chưa thay thế quyền RUN hoặc các luồng đó.

## Bảng quyền đề xuất

| Role | Chức năng Forge nên được cấp | Quyền ghi |
| --- | --- | --- |
| Architecture Manager | Xem cây dự án (`search_tree`), liệt kê file (`rg_files`), tìm mã (`rg_search`), đọc file hoặc đoạn mã (`read_file`, `sed_lines`); tra cứu index khi cần; `write_diff`, `edit_diff` khi tác vụ cho phép ghi tài liệu/skill | Chỉ trong các đường dẫn được chỉ định cho tác vụ, ví dụ tài liệu kiến trúc dưới `docs/` hoặc skill dưới `Skills/` |
| Sprint Leader | Các chức năng đọc của Architecture Manager; thêm tìm candidate và thông tin ticket/sprint do Node cung cấp | Không |
| Coder / Builder trong RUN | Bộ đọc; `git_status`, `git_diff`, `write_diff`, `edit_diff`, `run_test`, `check_test`, `report_done` | Chỉ ghi trong phạm vi ticket/worktree; `commit_changes` chỉ khi tác vụ RUN được cấp quyền commit |
| Reviewer | Bộ đọc; `git_status`, `git_diff`, kết quả verification và báo cáo review | Không sửa mã hoặc commit |
| Linguist | Đọc nội dung được giao; chỉ mở rộng phạm vi khám phá dự án khi tác vụ yêu cầu | Không |
| Runtime | Không nhận bộ tool mặc định theo tên role; Node cấp chức năng riêng cho từng tác vụ nội bộ | Theo phạm vi tác vụ |

`Coder` là role của profile chạy ticket; `Builder` còn được dùng làm tên agent hoặc khái niệm workflow. Quyền ghi phải gắn với tác vụ RUN và execution context cụ thể, không suy ra từ việc hai tên này xuất hiện gần nhau.

Architecture Manager có thể cần tạo hoặc sửa tài liệu kiến trúc, skill và các hiện vật thiết kế khác. Quyền này không phụ thuộc tên provider hay mặc định mở toàn bộ `docs/`/`Skills/`: Node cấp `allowed_file_paths` hoặc `allowed_prefixes` cụ thể cho từng tác vụ. Nếu cần sửa `ARCHITECTURE.md` ở gốc dự án, đường dẫn đó phải được cấp riêng. Phạm vi ghi có thể đến từ một yêu cầu conversation được Node xác nhận hoặc một tác vụ RUN; việc một lời gọi là chat không tự loại bỏ quyền ghi.

## Quy tắc cấp và kiểm tra quyền

1. Lập bảng quyền theo `role × loại công việc`, tối thiểu phân biệt chat, lập kế hoạch và RUN. Mặc định không cấp chức năng chưa được khai báo.
2. Chỉ quảng bá cho model các tool được cấp ở lượt đó. Không cấp mọi tool chỉ vì profile dùng Codex hoặc OpenAI.
3. Khi model gọi tool, adapter ánh xạ tên và đầu vào của provider về chức năng Forge. Node kiểm tra lại role, execution context, phạm vi đường dẫn, budget và trạng thái tác vụ trước khi thực thi.
4. Các giới hạn project root, ignore, lọc secret, giới hạn kết quả và ghi log nằm ở tầng Forge dùng chung. Adapter không được tự nới các giới hạn này.
5. Tool ghi cần quyền của tác vụ và danh sách đường dẫn được phép. Architecture Manager có thể dùng quyền ghi giới hạn cho hiện vật kiến trúc/skill trong conversation hoặc RUN; Coder/Builder ghi trong phạm vi ticket/worktree của RUN. Tool kiểm thử và `commit_changes` có điều kiện cấp quyền riêng; quyền đọc hoặc quyền ghi tài liệu không suy ra quyền commit.
6. Tên và schema công bố cho từng provider có thể khác nhau. Bảng quyền dùng mã chức năng Forge sau ánh xạ, không dùng tên tool thô mà model gửi lên.

## Trình tự triển khai

1. Kiểm kê chức năng Forge hiện có và từng đường gọi agent: conversation, lập kế hoạch, ticket RUN. Ghi rõ các tool built-in của SDK đang được bật ở mỗi đường gọi.
2. Tạo bảng quyền `role × loại công việc` ở một nơi dùng chung và các ánh xạ tên/schema riêng cho Codex và OpenAI.
3. Áp dụng bảng quyền khi quảng bá tool và khi Node nhận lời gọi. Thu hẹp luồng conversation hiện đang cấp `rg_files` và `search_tree` cho mọi role dùng Codex.
4. Chuyển từng đường gọi hiện có sang bảng quyền mà không làm thay đổi quyền cần thiết cho RUN đang hoạt động. Kiểm tra riêng Architecture Manager đọc dự án và ghi đúng vùng tài liệu/skill được giao, cùng quyền chỉ đọc của Sprint Leader.
5. Kiểm thử cả hai phía: role chỉ thấy tool được cấp, và Node từ chối lời gọi vượt quyền dù model tự gửi tên tool. Kiểm tra thêm path, ignore, budget, log; xác nhận Architecture Manager không ghi được ngoài các đường dẫn được cấp và không tự commit.
6. Khi triển khai Anthropic và Claude, thêm adapter tên/schema/transport và chạy lại cùng bộ kiểm thử quyền theo chức năng Forge.

## Tiêu chí hoàn tất

- Không còn nhánh cấp tool dựa đơn thuần vào `provider === "codex"` hoặc tên một role được hardcode trong mã thực thi tool.
- Mỗi lời gọi tool có role, loại công việc, task/execution ID và chức năng Forge chuẩn để kiểm tra quyền và ghi log.
- Tool đọc không vượt project root hoặc quy tắc ignore. Tool ghi chỉ chạy trong phạm vi đường dẫn được cấp cho tác vụ; Architecture Manager ghi được hiện vật kiến trúc/skill đã chỉ định, còn commit vẫn cần quyền riêng.
- Các role dùng Codex/OpenAI nhìn thấy đúng danh sách tool và lời gọi vượt quyền bị Forge từ chối. Adapter tương lai có thể dùng tên khác cho cùng chức năng mà không sửa bảng quyền.
