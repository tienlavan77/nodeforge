# Project Stream SSE — schema và API đề xuất

## Quyết định

NodeForge dùng một kênh SSE thống nhất tại `/forge/v1/stream`, thay vì mở một kênh riêng cho Watcher, Conversation, Sprint và Runtime.
Kênh này chỉ là transport; mỗi bản tin vẫn có `event_type` riêng để UI định tuyến đúng component. Scope project được truyền qua query và luôn được lặp lại trong envelope.

Schema chuẩn nằm tại `schemas/stream/project-stream-event.schema.json`.

## Tên API

```text
GET /forge/v1/stream?project={project_id}
```

Query tùy chọn:

```text
?after={event_id}
?replay_limit=100
```

Headers hỗ trợ:

```text
Accept: text/event-stream
Last-Event-ID: {event_id}
```

`project` là query parameter bắt buộc. Backend không được trả event của project khác. Mọi event vẫn phải chứa `project_id` để UI kiểm tra scope độc lập với URL.

## SSE framing

Mỗi event được gửi theo chuẩn SSE:

```text
id: EVT-123
event: watcher.file_indexed
data: {"event_id":"EVT-123","event_type":"watcher.file_indexed",...}

```

`data` luôn là một JSON object hợp lệ theo schema. `event` trùng với `data.event_type` để trình duyệt có thể lọc nhanh.
Heartbeat là SSE comment, không phải event nghiệp vụ:

```text
: keep-alive

```

## Envelope

Bắt buộc:

| Field | Ý nghĩa |
|---|---|
| `event_id` | ID ổn định, dùng làm SSE `id` và cursor reconnect |
| `event_type` | Namespace + hành động, ví dụ `watcher.file_indexed` |
| `schema_version` | Version của envelope/payload; bản hiện tại là `1` |
| `project_id` | Project scope |
| `timestamp` | ISO-8601 UTC |
| `payload` | Dữ liệu nghiệp vụ của event |

`sequence`, `task_id` và `correlation_id` là metadata tùy chọn khi event cần ordering hoặc liên kết execution.

## Danh sách event giai đoạn đầu

```text
stream.connected
stream.snapshot
watcher.file_indexed
watcher.file_removed
stream.error
```

Đây là danh sách được chốt cho phiên bản schema `1`. Không phát event ngoài danh sách này cho đến khi có thay đổi contract/schema được duyệt.

Heartbeat không phải event JSON; nếu cần giữ connection sống, backend dùng SSE comment:

```text
: keep-alive

```

Snapshot được gửi sau khi mở connection để UI có dữ liệu ngay, trước các event realtime. Khi reconnect, backend dùng `Last-Event-ID` hoặc `after` để replay phần còn thiếu; nếu cursor không còn trong retention window thì gửi snapshot mới.

## Watcher contract

`watcher.file_indexed.payload` gồm `path`, `indexed_at`, `operation`, `activity` và metadata tùy chọn `language`, `size_bytes`, `sha256`. `activity` chứa các dòng hiển thị cho Watcher UI.
Snapshot chứa tối đa 4 event trong `payload.watcher.recent_events`. Backend có thể trả theo newest-first; UI chuẩn hóa thành oldest-first khi render để file mới nhất nằm ở dòng dưới cùng.

Không gửi full content file qua stream. Stream chỉ thông báo metadata; Agent/UI phải dùng tool hoặc API đọc file khi cần.

## Quy tắc mở rộng

- Giữ ổn định envelope và ý nghĩa của type đã phát hành.
- Khi cần thêm type mới, phải cập nhật enum `event_type`, payload schema và tài liệu trước khi phát hành.
- Thêm field không bắt buộc phải tương thích ngược.
- Thay đổi breaking phải tăng `schema_version` hoặc tạo type mới.
- Payload của type đã biết dùng `additionalProperties: false`.
- Backend validate trước khi `response.write()`.

## Luồng UI

```text
mount
  → mở GET /forge/v1/stream?project={id}
  → nhận stream.snapshot
  → render snapshot
  → nhận watcher.file_indexed
  → cập nhật tối đa 4 event
  → reconnect bằng Last-Event-ID khi connection đóng
```

Kênh này không thay thế các API CRUD/snapshot hiện có; nó chỉ cung cấp cập nhật realtime và replay có giới hạn.

## Ngoài phạm vi tài liệu này

Chưa triển khai endpoint, publisher, Node client hoặc UI handler. Đây là contract/schema để duyệt trước khi nối vào pipeline.
