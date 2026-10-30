# Luật chọn Agent

## 1. Mục tiêu

Node chỉ gửi ticket cho Supervisor. Supervisor chịu trách nhiệm chọn đúng một agent cụ thể từ các profile đã đăng ký trong `agent_profiles`. Node không chọn `agent_id`, không chọn provider và không gọi trực tiếp agent.

Quy trình chuẩn:

```text
Node nhận ticket
  → gửi ticket cho Supervisor
  → Supervisor lọc và xếp hạng các profile phù hợp
  → Supervisor chọn một agent_id
  → agent xử lý ticket
  → Supervisor nhận kết quả
  → trả kết quả về Node
  → kết thúc execution
```

Một ticket chỉ có một `selected_agent_id` và một execution chính, trừ khi policy của hệ thống quy định rõ một workflow nhiều agent.

## 2. Nguồn dữ liệu

`agent_profiles` là nguồn sự thật cho các agent có thể được lựa chọn. Một profile tối thiểu có các thuộc tính:

```json
{
  "agent_id": "uuid",
  "agent_name": "Coder Cú đêm",
  "role": "coder",
  "provider": "claude",
  "model": "claude-haiku-4-5",
  "enabled": true,
  "status": "ready"
}
```

`agent_id` là identity cụ thể của agent. Role chỉ mô tả chức năng; role không phải là identity và không được dùng thay cho `agent_id` khi gửi execution.

## 3. Bước lọc bắt buộc

Các điều kiện sau là điều kiện loại trừ, không phải điểm cộng. Profile không thỏa mãn một trong các điều kiện này không được chọn.

### 3.1. Role

Nếu ticket có `required_role`, Supervisor chỉ được xét profile có đúng role đó.

Nếu ticket không có role, Supervisor suy luận role từ nội dung:

- viết hoặc sửa code → `coder`;
- kiểm tra, audit hoặc review → `reviewer`;
- lập kế hoạch sprint hoặc chia ticket → `sprint_leader`;
- quyết định hoặc đánh giá kiến trúc → `architecture_manager`.

Nếu không thể suy luận role với độ tin cậy cần thiết, Supervisor phải trả trạng thái cần làm rõ thay vì chọn agent tùy ý.

### 3.2. Profile có thể sử dụng

Chỉ xét profile thỏa mãn:

```text
enabled === true
status ∈ { "ready", "working" }
```

`ready` được ưu tiên hơn `working`. Profile đang `working` chỉ được xét khi policy cho phép chia sẻ tải hoặc không còn profile `ready` phù hợp.

### 3.3. Capability

Profile phải đáp ứng capability cần cho ticket, bao gồm khi có liên quan:

- ngôn ngữ và framework;
- loại repository hoặc project;
- loại ticket;
- khả năng sử dụng các tool cần thiết;
- yêu cầu về test, database hoặc deployment;
- context window và năng lực model.

Capability có thể được biểu diễn bằng metadata trên profile, ví dụ:

```json
{
  "capabilities": ["javascript", "node", "backend", "testing"]
}
```

### 3.4. Permission và phạm vi

Profile phải được phép thực hiện các thao tác mà ticket yêu cầu. Loại profile nếu không có quyền:

- đọc hoặc sửa các thư mục liên quan;
- sử dụng tool cần thiết;
- truy cập project;
- xử lý loại dữ liệu của ticket;
- thực hiện thao tác có mức rủi ro tương ứng.

Agent phù hợp về kỹ thuật nhưng thiếu permission không phải là candidate hợp lệ.

## 4. Xếp hạng candidate

Sau khi lọc, Supervisor xếp hạng các candidate còn lại theo thứ tự sau.

### 4.1. Mức độ phù hợp capability

Ưu tiên profile khớp nhiều nhất với yêu cầu của ticket.

Ví dụ: ticket sửa lỗi Node.js trong backend nên ưu tiên coder có các capability `node`, `javascript` và `backend`.

### 4.2. Tình trạng runtime và health

Ưu tiên profile có:

- gateway đang phản hồi;
- credential reference còn hợp lệ;
- provider đang khả dụng;
- không vượt giới hạn concurrency;
- lần kiểm tra kết nối gần nhất thành công.

### 4.3. Provider và model

Provider và model là tiêu chí của Supervisor, không phải quyết định của Node. Có thể ưu tiên:

- model hỗ trợ tool-use khi ticket cần tool;
- model có context window phù hợp với ticket lớn;
- model tiết kiệm hơn cho ticket đơn giản;
- provider đang ổn định hơn khi có nhiều lựa chọn tương đương.

Provider hoặc model không thể đáp ứng yêu cầu là lý do loại candidate; không được chọn chỉ vì profile đang `ready`.

### 4.4. Tải hiện tại

Nếu các candidate tương đương, ưu tiên profile có tải thấp hơn, dựa trên:

```text
active_executions thấp hơn
queue_depth thấp hơn
last_assigned_at cũ hơn
```

Không coi `status: ready` là bằng chứng duy nhất về khả năng nhận việc nếu runtime đang có tải thực tế.

### 4.5. Độ ổn định gần đây

Có thể dùng các tín hiệu vận hành làm tiêu chí phụ:

- tỷ lệ hoàn thành;
- tỷ lệ cần repair;
- số lần timeout;
- số lần verification từ chối;
- latency gần đây.

Các tín hiệu này chỉ là điểm phụ hoặc tie-breaker. Một lỗi đơn lẻ không được loại profile vĩnh viễn.

## 5. Quy tắc điểm và điều kiện loại trừ

Nếu cần chấm điểm, Supervisor có thể dùng mô hình sau:

```text
score =
  capability_match      * 100
+ provider_model_match  * 30
+ health_score           * 20
+ availability_score    * 20
+ reliability_score     * 10
- current_load           * 30
```

Role, permission và điều kiện `enabled/status` không nên chỉ được biểu diễn bằng điểm. Đây là điều kiện lọc bắt buộc: sai role hoặc thiếu quyền thì candidate bị loại dù tổng điểm có cao.

## 6. Tie-breaker deterministic

Nếu nhiều candidate có mức phù hợp tương đương, Supervisor phải chọn theo thứ tự deterministic:

1. `ready` trước `working`;
2. tải hiện tại thấp hơn;
3. `last_assigned_at` cũ hơn;
4. `created_at` sớm hơn;
5. `agent_id` theo thứ tự tăng dần.

Không chọn ngẫu nhiên. Kết quả deterministic giúp tái hiện lỗi, audit quyết định và kiểm thử ổn định.

## 7. Kết quả lựa chọn phải được lưu

Execution nên lưu cả candidate và lý do lựa chọn:

```json
{
  "candidate_agent_ids": ["uuid-1", "uuid-2"],
  "selected_agent_id": "uuid-2",
  "selection_reason": {
    "role": "coder",
    "matched_capabilities": ["node", "javascript", "backend"],
    "load": 0,
    "health": "healthy"
  }
}
```

Việc lưu này phục vụ audit, debug, đo chất lượng lựa chọn và khôi phục execution.

## 8. Vai trò của SDK và Forge

Sau khi Supervisor chọn profile, Forge mới tạo session cho provider/model của profile đó. SDK xử lý message, model interaction và các lượt tool-use; Forge cung cấp schema tool, kiểm tra permission, thực thi tool, lưu trạng thái và trả `tool_result` đã được kiểm soát.

```text
Supervisor chọn profile
  → Forge tạo SDK session
  → agent xử lý ticket
  → Forge thực thi tool khi cần
  → Forge nhận kết quả
  → Supervisor trả kết quả về Node
  → kết thúc execution
```

Không khởi tạo SDK trước khi có `selected_agent_id`. Không để Node bypass Supervisor để gọi trực tiếp provider hoặc agent.

## 9. Execution state tối thiểu

```text
queued
  → supervisor_selecting
  → agent_running
  → completed
```

Các nhánh lỗi chính:

```text
supervisor_selecting → failed
agent_running        → failed
```

Repair hoặc verification chỉ được thêm khi policy của workflow yêu cầu; không biến luồng mặc định thành chuỗi gọi agent không giới hạn.
