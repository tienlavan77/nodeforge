<!-- Tóm tắt: Ghi graph dễ đọc mà search_code trả cho agent khi tìm file Supervisor loop. -->
# Code graph mà agent nhận: `supervisor-loop.js`

Ví dụ dưới đây là **kết quả đã chạy bằng `search_code`**, không phải quan hệ tự suy ra từ mã nguồn. Để kiểm tra định dạng mới mà không phụ thuộc index đang chạy của dự án, lần thử tạo index tạm từ ba file thật: `errors.js`, `supervisor-loop.js`, `production-runtime.js`. SHA-256 của `supervisor-loop.js` khớp ảnh chụp trước: `7ec18864c45bf65f975180f5c14900db8db07f3a6a81f857201c74ab1bbfb008`. `IDX-3` là phiên bản của **index tạm**, không phải index của dự án. `task_id: "CODE-EXAMPLE"` chỉ là ngữ cảnh của lần gọi thử.

Input:

```json
{
  "query": "supervisor-loop",
  "kind": "file",
  "projection": "graph",
  "limit": 1,
  "allowed_prefixes": ["backend/src/"]
}
```

Trường `graph` agent nhận trong kết quả đầu tiên:

```json
{
  "imports": [
    {
      "path": "backend/src/shared/errors.js",
      "name": "ConfigurationError",
      "kind": "named",
      "broken": false
    }
  ],
  "imported_by": [
    {
      "path": "backend/src/modules/supervisor/production-runtime.js",
      "name": "createSupervisorLoop",
      "kind": "named",
      "broken": false
    }
  ],
  "calls": [
    {
      "caller": { "path": "backend/src/modules/supervisor/supervisor-loop.js", "name": "start" },
      "target": { "path": "backend/src/modules/supervisor/supervisor-loop.js", "name": "selectAgent" },
      "line": 13
    },
    {
      "caller": { "path": "backend/src/modules/supervisor/supervisor-loop.js", "name": "start" },
      "target": { "path": "backend/src/modules/supervisor/supervisor-loop.js", "name": "emitAgentWorking" },
      "line": 15
    },
    {
      "caller": { "path": "backend/src/modules/supervisor/supervisor-loop.js", "name": "onEvent" },
      "target": { "path": "backend/src/modules/supervisor/supervisor-loop.js", "name": "startRepairRound" },
      "line": 60
    },
    {
      "caller": { "path": "backend/src/modules/supervisor/supervisor-loop.js", "name": "onEvent" },
      "target": { "path": "backend/src/modules/supervisor/supervisor-loop.js", "name": "terminal" },
      "line": 66
    },
    {
      "caller": { "path": "backend/src/modules/supervisor/supervisor-loop.js", "name": "onEvent" },
      "target": { "path": "backend/src/modules/supervisor/supervisor-loop.js", "name": "startRepairRound" },
      "line": 67
    },
    {
      "caller": { "path": "backend/src/modules/supervisor/supervisor-loop.js", "name": "onEvent" },
      "target": { "path": "backend/src/modules/supervisor/supervisor-loop.js", "name": "terminal" },
      "line": 68
    }
  ],
  "index_version": "IDX-3"
}
```

Ngoài `graph`, cùng kết quả còn có `path`, `score`, `reason`, `language`, `sha256`, `size_bytes` và danh sách tám `symbols` với khoảng dòng. Tool chỉ trả quan hệ trong `allowed_prefixes`; nó không tự đọc nội dung các file liên quan. Nếu dùng phạm vi `backend/src/modules/supervisor/`, import tới `shared/errors.js` sẽ bị lọc.

Graph vẫn chỉ gồm các cạnh mà Code Index nhận diện trực tiếp. Các lời gọi qua object trả về như `loop.start()`, `loop.reset()` và `loop.onEvent()` chưa được nhận diện; bản đối chiếu mã nguồn nằm trong [code-graph-supervisor-loop.md](code-graph-supervisor-loop.md). Lần thử này xác nhận định dạng qua tool với index tạm, **chưa phải lượt gọi của agent thật**.
