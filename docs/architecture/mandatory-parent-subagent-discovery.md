# Bắt buộc Parent Agent dùng Subagent để khám phá Code

## 1. Mục tiêu

Thiết lập cơ chế **delegated-first discovery** cho Forge: khi Parent Agent cần khám phá repository mới, hệ thống phải ưu tiên và có thể bắt buộc Parent gọi `delegate_subagent` trước khi dùng trực tiếp các tool đọc code. Mục tiêu là giảm quét trùng lặp, tăng tốc bằng các task read-only chạy song song, đồng thời giữ provenance và scope enforcement.

Prompt và README chỉ hướng dẫn hành vi; chúng không đủ để cưỡng chế. Enforcement phải nằm ở runtime governance và được kiểm tra lại tại tool implementation.

## 2. Phạm vi tool khám phá

### Broad discovery

- `search_tree`
- `list_files`
- `search_text`
- `select_code_graph_candidates`

### Targeted read

- `read_file`
- `Read`

### Read-only Git inspection

- `git_status`
- `git_diff`
- `git_log`
- `git_show`
- `git_blame`

Child subagent được cấp các tool read-only phù hợp; không được sửa file, chạy command, commit, push hoặc delegate tiếp.

## 3. Luồng bắt buộc

```text
Parent
  │
  ├─ read_subagent_evidence({})
  │
  ├─ Nếu evidence fresh và đủ coverage: dùng lại, không delegate lại
  │
  ├─ Nếu cần discovery mới:
  │    delegate_subagent({ tasks: [...] })
  │
  ├─ Parent tiếp tục công việc độc lập (hoặc nhận delegation_id ở chế độ async)
  │
  ├─ get_subagent_status / read_subagent_evidence({ delegation_id })
  │
  └─ dùng evidence có provenance để đọc symbol hoặc triển khai
```

Với async delegation, `delegate_subagent` trả về ngay:

```js
{
  delegation_id: "DELEGATION-...",
  status: "pending | running",
  task_count: 2,
  read_only: true
}
```

Parent không bị biến thành một turn blocking chỉ vì child đang khảo sát; barrier chỉ xuất hiện khi Parent thật sự cần kết quả child.

## 4. Runtime enforcement

Trước khi chạy exploration tool của Parent, runtime gọi policy tương đương:

```js
assertDelegatedDiscoveryRequired(context, toolName)
```

Nếu chưa có delegation hợp lệ cho yêu cầu mới, trả lỗi có cấu trúc:

```js
{
  error_code: "SUBAGENT_REQUIRED",
  message: "Parent must delegate read-only discovery before using this exploration tool.",
  required_action: "delegate_subagent",
  allowed_tools: ["search_tree", "list_files", "search_text", "read_file", "Read"]
}
```

Không chỉ kiểm tra một cờ boolean. Receipt phải chứng minh:

- `delegation_id` thuộc cùng `conversation_id` / `execution_id` / ticket hoặc plan context;
- task có objective cụ thể và phạm vi path/prefix hợp lệ;
- child đang `pending`, `running` hoặc `completed`;
- child được áp dụng `read_only_enforced: true`;
- delegation không hết hạn, bị hủy hoặc thuộc execution khác;
- task không rỗng và không phải mục tiêu giả như `"do discovery"`.

Tool implementation phải kiểm tra lại policy, không chỉ tin rằng caller đã kiểm tra.

## 5. Ngoại lệ có kiểm soát

Không chặn mù mọi thao tác đọc. Parent được đọc trực tiếp khi:

1. File đã có trong `active_file_checksums` và SHA trên đĩa vẫn fresh.
2. Parent đang xử lý lỗi hoặc kết quả của tool vừa gọi.
3. File là rule bắt buộc như `AGENTS.md` hoặc role README.
4. Owner chỉ rõ chính xác file cần đọc.
5. Child đang chạy; child chỉ được read-only tools.
6. Tất cả provider/model của child thất bại và hệ thống trả `fallback_to_parent: true` kèm lý do.

Ngoại lệ không được dùng để quét repo mới. Khi fallback, Parent phải ghi rõ lý do và không được giả vờ rằng subagent đã hoàn thành.

## 6. Scope và provenance

Mỗi file child quan sát phải được ghi vào Evidence Store với metadata xác thực:

```js
{
  path,
  sha256,
  total_lines,
  symbol_map,
  code_graph,
  symbols_read,
  parent_execution_id,
  child_execution_id,
  child_agent_id,
  delegation_id,
  source_tool,
  observed_at,
  read_only_enforced: true
}
```

Parent không được tự cung cấp hoặc sửa `sha256`, `symbol_map`, freshness hay provenance. Nếu file đã thay đổi, entry cũ phải thành `stale`; không dùng receipt cũ cho `Read` hoặc mutation.

`delegation receipt` chứng minh **nguồn gốc** của evidence. `semantic candidate receipt` chứng minh **độ liên quan** của file/symbol với AC hoặc intent. Hai loại receipt được liên kết trong Evidence Store nhưng không thay thế nhau.

## 7. Không tạo deadlock hoặc vòng lặp

- Không yêu cầu child gọi `delegate_subagent` tiếp.
- Giới hạn tối đa số task song song theo policy hiện hành; mỗi task phải read-only.
- Child không được có mutation tools hoặc quyền vượt scope của Parent.
- Nếu Parent đã có evidence fresh, không bắt gọi child lại trước từng `Read`; điều đó chỉ tạo overhead.
- `select_code_graph_candidates` có thể là một bước discovery, nhưng không tự chứng minh source đã được child đọc.

## 8. Telemetry và lỗi

Runtime nên phát sự kiện khi:

- Parent bị từ chối vì `SUBAGENT_REQUIRED`;
- delegation được tạo, bắt đầu, hoàn tất, hủy hoặc hết hạn;
- child provider failover xảy ra;
- fallback về Parent được cấp;
- evidence bị đánh dấu stale;
- child thử gọi mutation hoặc delegate tiếp.

Lỗi ghi durable state không được tạo evidence fresh giả. Hệ thống phải trả trạng thái durability rõ ràng và giữ nguyên kết quả chưa xác định để Parent reconciliation.

## 9. Acceptance Criteria cấp kiến trúc

- Parent không thể dùng broad discovery tool cho repository mới nếu chưa có delegation receipt hợp lệ hoặc ngoại lệ được policy cho phép.
- Child chỉ gọi được tool read-only, không sửa code, chạy command, commit, push hoặc delegate tiếp.
- Delegation và child evidence có identity, scope, SHA, thời điểm và trạng thái rõ ràng.
- Parent có thể tái sử dụng evidence fresh mà không delegate hoặc đọc lại không cần thiết.
- Provider failure trả `fallback_to_parent` có lý do; không giả mạo success.
- Có unit/integration tests cho: chặn parent, ngoại lệ fresh evidence, scope mismatch, child mutation denial, delegation expiry và fallback.
- Cơ chế không làm thay đổi contract của semantic ranking; candidate vẫn là gợi ý xếp hạng, không phải manifest sửa file bắt buộc.

## 10. Kết luận

Muốn **buộc Parent Agent gọi subagent**, phải cưỡng chế ở runtime:

> **Nếu không có evidence fresh hoặc ngoại lệ hợp lệ, exploration tool của Parent bị từ chối cho đến khi có delegation receipt hợp lệ.**

README và system prompt giúp Agent hiểu quy trình; runtime governance mới là nơi bảo đảm quy trình đó thực sự được tuân thủ.
