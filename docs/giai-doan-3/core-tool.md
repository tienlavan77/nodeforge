# Core Tools trong `agent-tool`

Tài liệu này trích xuất các tool được định nghĩa hoặc đăng ký bởi thư mục
`agent-tool/`. Đây là inventory của runtime Agent Tool (Rust), không phải danh sách
Tool Lab NodeForge. Các tool `search_code`, `read_code`, `read_transcript_blocks` và
`select_code_graph_candidates` hiện nằm ở `backend/src/tools/`, nên không thuộc core
tool inventory này.

## Cách đọc inventory

- **Handler** là phần nhận invocation và thực thi.
- **Spec** là wire contract gửi cho model: tên, mô tả, schema, output schema và exposure.
- **Registry** là nơi đăng ký handler; một tool có thể được đăng ký có điều kiện theo feature,
  provider, model capability, environment hoặc session source.
- **Direct** nghĩa là model có thể thấy/gọi trực tiếp; **Deferred** nghĩa là tool được tìm thấy
  qua tool discovery; **CodeModeOnly** chỉ gọi được trong Code Mode; **DirectModelOnly** chỉ
  hiện ở model trực tiếp. Vì vậy một tool có trong source không đồng nghĩa luôn xuất hiện ở mọi
  turn.
- Tên có namespace được ghi theo dạng `namespace.tool`; tên function trong wire payload có thể
  giữ tên function riêng bên trong namespace.

## 1. Shell và filesystem execution

### `exec_command`

Chạy command trong execution environment hiện tại. Spec nằm ở
`tools/handlers/shell_spec.rs`; handler runtime là
`tools/handlers/unified_exec/exec_command.rs`. Tool chịu các policy sandbox, approval,
environment id, shell mode, timeout và stream output. Đây là quyền thực thi lệnh, không phải
quyền đọc code có scope theo task; khi expose tool này cần Runtime kiểm soát sandbox và approval.

### `write_stdin`

Gửi input hoặc tiếp tục poll một process đang chạy được tạo bởi `exec_command`. Tool giữ trạng
thái process/resumable session và vì thế phải đi cùng lifecycle của execution environment.

### `apply_patch`

Áp dụng patch vào workspace theo format apply-patch. Handler nằm ở
`tools/handlers/apply_patch.rs`, spec ở `apply_patch_spec.rs`. Tool có biến thể thêm
`environment_id` khi có nhiều environment. Đây là mutation tool: approval, sandbox, path policy,
atomicity và post-apply verification phải do Runtime sở hữu.

### `view_image`

Đọc/hiển thị một ảnh cục bộ cho model. Spec có tùy chọn unified image budget và original image
detail. Tool phụ thuộc execution environment và feature `ViewImage`; không nên coi nó là API đọc
tùy ý mọi binary trong repository.

### `request_permissions`

Yêu cầu thêm quyền execution (filesystem/network) cho turn. Tool chỉ được đăng ký khi có
environment và feature `RequestPermissionsTool`; policy approval vẫn nằm ở Runtime.

## 2. Planning và context control

### `update_plan`

Tool planning do `PlanHandler` thực thi, spec ở `plan_spec.rs`. Model cập nhật các bước kế hoạch,
trạng thái và mục tiêu; tool không tự sửa file hay kết thúc task. Đây là control-plane tool.

### `new_context`

Yêu cầu mở context window mới khi token budget cho phép. Được expose trực tiếp theo feature
`TokenBudget`; handler không tự quyết định nội dung cần đọc.

### `get_context_remaining`

Trả lượng context/token còn lại. Cũng phụ thuộc feature `TokenBudget`, giúp Agent tự quyết định
có cần retrieval/compaction hay không.

### `wait_for_environment`

Chờ execution environment đang ở trạng thái `starting` chuyển sang sẵn sàng. Tool có timeout và
được đăng ký khi `DeferredExecutor` bật. Tool chỉ chờ lifecycle, không thực hiện thay Agent.

## 3. User interaction và time controls

### `request_user_input`

Hỏi người dùng một nhóm câu hỏi lựa chọn. Chỉ bật khi
`experimental_request_user_input_enabled`; được expose `DirectModelOnly`.

### `request_user_input_async`

Biến thể async dành cho model/capability thử nghiệm; tên wire là
`request_user_input_async`. Source còn tương thích catalog cũ
`request_user_input_async`/`send_user_message_async`.

### `send_message_to_user_async`

Gửi thông báo bất đồng bộ cho người dùng, không phải message giữa các sub-agent. Chỉ root agent
và model có capability tương ứng mới được đăng ký.

### `clock.curr_time`

Trả thời gian hiện tại cho model. Namespace là `clock`, function name là `curr_time`. Được bật
qua `CurrentTimeReminder` hoặc model capability `clock`.

### `clock.sleep`

Tạm dừng theo thời lượng do model yêu cầu, có giới hạn tối đa. Namespace và tool được đăng ký
theo feature `SleepTool`/clock mode; không nên dùng để thay thế lifecycle wait.

## 4. Multi-agent collaboration

### Multi-agent v1: namespace `multi_agent_v1`

Namespace được khai báo trong `tools/handlers/multi_agents_spec.rs` với mô tả quản lý sub-agent.

- `multi_agent_v1.spawn_agent`: tạo sub-agent, có model/agent type override tùy cấu hình.
- `multi_agent_v1.send_input`: gửi message hoặc items tới agent hiện có, có tùy chọn interrupt.
- `multi_agent_v1.wait_agent`: chờ agent hoàn tất theo timeout policy.
- `multi_agent_v1.resume_agent`: tiếp tục agent đã tạm dừng.
- `multi_agent_v1.close_agent`: đóng agent.

V1 thường được expose deferred khi tool search bật; nếu không thì direct. Namespace này có
handler riêng và không nên trộn tên với V2 khi audit.

### Multi-agent v2

V2 dùng tên plain hoặc namespace cấu hình (mặc định trong test là `collaboration`). Các function
được định nghĩa trong cùng spec:

- `spawn_agent`: tạo agent với `task_name` bắt buộc trong V2.
- `send_message`: gửi message tới agent.
- `followup_task`: giao follow-up task.
- `wait_agent`: chờ agent.
- `interrupt_agent`: ngắt agent đang chạy.
- `list_agents`: liệt kê agent thuộc collaboration scope.

V2 có thể `Direct` hoặc `DirectModelOnly` theo `multi_agent_v2.non_code_mode_only`; một số
function chỉ xuất hiện khi `wait_agent_enabled`. V1/V2 có cùng tên function ở vài vị trí nhưng
khác namespace, schema và lifecycle, nên không được suy luận chúng là cùng một tool.

## 5. Plugin, connector và discovery

### `tool_search`

Tool discovery tìm trên metadata của các tool deferred bằng BM25 và làm các tool phù hợp callable
ở model call kế tiếp. Function wire name trong namespace info là `tool_search_tool`; tool runtime
được nhận diện là `tool_search`. Nó không thực thi tool được tìm thấy và không tự cấp quyền.

### `list_available_plugins_to_install`

Liệt kê plugin/connector đã biết có thể cài đặt. Tool chỉ xuất hiện khi tool suggestion có
candidates và presentation phù hợp.

### `request_plugin_install`

Yêu cầu cài plugin/connector cụ thể sau khi đã có candidate hợp lệ. Tool truyền `tool_type` và
`id` từ kết quả discovery; không được dùng cho đề xuất rộng hoặc capability chưa được người dùng
yêu cầu.

### Dynamic tools và extension tools

`DynamicToolHandler` nhận function/namespace spec từ turn hiện tại; tên và schema do nguồn động
cung cấp. Extension tools cũng do extension contributor cung cấp. Đây là tool thật trong registry
nhưng không thể liệt kê tên cố định từ source; phải lấy từ runtime spec và namespace.

## 6. MCP resources và MCP tools

### `list_mcp_resources`

Liệt kê resource từ MCP server, có thể phân trang bằng cursor và lọc server.

### `list_mcp_resource_templates`

Liệt kê URI template của MCP resource.

### `read_mcp_resource`

Đọc một resource cụ thể theo `server` và `uri`; URI phải xuất phát từ danh sách resource được
duyệt, không phải URI tùy ý.

Ba tool có spec cố định trong `tools/handlers/mcp_resource_spec.rs`, chỉ đăng ký khi MCP có
server. Ngoài ra MCP server có thể cung cấp tool động, thường được wire dưới namespace dạng
`mcp__<server>__<tool>`; tên cụ thể phụ thuộc cấu hình server.

## 7. Hosted và Code Mode

### Web search

`hosted_spec.rs` tạo `ToolSpec::WebSearch` khi web search mode là cached, indexed hoặc live; khi
disabled/không cấu hình thì không có tool. Đây là hosted capability, không phải handler đọc
repository.

### Code Mode public execute/wait

Code Mode có hai tên lấy từ crate ngoài `codex_code_mode`:

- `codex_code_mode::PUBLIC_TOOL_NAME`: public code-mode execute tool.
- `codex_code_mode::WAIT_TOOL_NAME`: code-mode wait tool.

Source `agent-tool` chỉ re-export constant, nên không đủ bằng chứng để khẳng định literal wire
name từ folder này. Không được tự đoán tên khi xây provider schema; phải đọc đúng version của
crate dependency.

### Image generation

`spec_plan.rs` dùng namespace `image_gen` và tool `imagegen` cho image generation capability khi
provider/feature cho phép. Đây là hosted/extension surface, không phải core file tool.

## 8. Tool không phải production tool cố định

Các tên sau xuất hiện trong test fixture hoặc ví dụ, không nên đưa vào inventory production:

- `extension_echo`
- `test_tool`, `direct_tool`, `ok_tool`, `failing_tool`
- `echo`, `lookup`, `create_event`, `list_events`, `automation_update`
- các MCP names phụ thuộc fixture như `mcp__filesystem__read_file` hoặc
  `mcp__foo__exec_command`

Chúng chỉ chứng minh router/namespace/extension behavior hoặc minh họa MCP dynamic discovery.

## 9. Những điểm còn thiếu hoặc cần xác minh

1. **Literal Code Mode names**: `PUBLIC_TOOL_NAME` và `WAIT_TOOL_NAME` đến từ crate ngoài; cần
   lockfile/source dependency để xác minh wire literal.
2. **`TOOL_SEARCH_TOOL_NAME` literal**: source xác nhận function name `tool_search_tool`, nhưng
   constant tên tool đến từ `codex_tools`; cần dependency source để xác minh mọi alias.
3. **Default exposure theo từng turn**: feature flags, model capabilities, session source,
   environment count và tool-search state quyết định tool có visible/direct/deferred hay không.
4. **Schema đầy đủ**: nhiều spec dựng `JsonSchema` bằng Rust; inventory này chưa thay thế việc
   serialize/validate schema thực tế theo provider.
5. **MCP/dynamic/extension inventory**: tên, capability, namespace và quyền chỉ biết đầy đủ khi
   runtime cung cấp catalog hiện hành.
6. **Capability và task scope của NodeForge**: `agent-tool` có sandbox/approval/lifecycle riêng;
   không tự cung cấp `task_id`, exact file allowlist, retrieval budget hoặc audit contract của
   NodeForge. Các yêu cầu đó phải được adapter NodeForge áp vào trước khi expose tool.
7. **Retrieval principles**: core `exec_command` có thể đọc repository gián tiếp qua shell nếu
   sandbox cho phép. Muốn tuân thủ Reference First/Controlled Access/No Repository Dump, NodeForge
   phải không expose shell unrestricted cho flow đọc code, hoặc phải áp policy/sandbox/approval
   riêng ngoài core registry.

## 10. Kết luận kiến trúc

`agent-tool` là một runtime tool framework có registry, exposure, namespace, deferred discovery,
Code Mode, MCP, extension và lifecycle. Nó không phải một danh sách API tĩnh. Khi tích hợp vào
NodeForge, nên giữ nguyên nguyên tắc:

```text
Node Runtime identity + task scope + capability + budget
    -> chọn tool exposure phù hợp
    -> Agent gọi tool
    -> runtime authorize + execute + audit
    -> trả tool result theo schema
```

Không nên coi việc một handler tồn tại trong `agent-tool/` là quyền mặc định cho Agent, và không
nên dùng các tool shell/patch/MCP để thay thế các tool đọc code có exact allowlist của NodeForge.

Theo em, NodeForge nên làm theo thứ tự này:

  1. Runtime governance trước
      - Identity, task_id, capability, exact scope, retrieval budget, audit, lifecycle.
      - Đây là lớp bắt buộc trước khi expose bất kỳ tool nào.

  2. Context retrieval
      - search_code
      - select_code_graph_candidates
      - read_code
      - read_transcript_blocks

     Đây là nhóm quan trọng nhất vì tuân thủ:

     reference -> search -> Node approval -> read exact content

     Không cho Agent tự đọc repository bằng exec_command.

  3. Planning
      - update_plan
      - get_context_remaining
      - new_context

     Agent tự quản lý kế hoạch và context budget; Node chỉ kiểm soát contract/lifecycle.

  4. Verification
      - Có thể lấy ý tưởng từ test_sync_tool.
      - NodeForge nên có tool kiểm tra syntax/test/status, nhưng output phải là evidence có giới hạn,
        không trả log vô hạn.

  5. Controlled mutation
      - apply_patch
      - exec_command
      - write_stdin

     Nên làm sau cùng. Với NodeForge, Agent không nên dùng apply_patch trực tiếp; Agent trả
     structured_patch, còn Runtime chịu trách nhiệm validate, atomic apply và verification.

  6. Multi-agent
      - spawn_agent, send_message, wait_agent, list_agents, interrupt_agent.
      - Chỉ làm sau khi task scope, budget và audit giữa các agent đã rõ.

  7. Tool phụ trợ
      - view_image
      - clock.*
      - request_user_input
      - plugin/MCP/dynamic tools.

  Thứ tự triển khai thực tế em đề xuất:

  Governance
    -> search_code
    -> select_code_graph_candidates
    -> read_code
    -> read_transcript_blocks
    -> update_plan/context tools
    -> verification tools
    -> controlled patch/apply
    -> multi-agent
    -> MCP/plugins/utilities

  Điểm quan trọng: không nên bê nguyên toàn bộ agent-tool vào NodeForge. exec_command, MCP và dynamic
  tools có thể tạo unrestricted access; NodeForge chỉ nên expose chúng sau khi có adapter kiểm soát
  scope, budget, approval và audit.