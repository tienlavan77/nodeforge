Hệ thống hiện gồm khoảng 10 lớp chức năng, 3 process vận hành chính, 2 SQLite database, 1 project log và 1 kênh SSE hội thoại.

  ## 1. Ba process đang chạy

  Hiện tại:

  1. Control API / Node
      - PID 1815718
      - Port 3100
      - Entry: scripts/start-control-api.mjs
      - Điều phối ticket, agent, execution, git, verification, roadmap, history và SSE.

  2. Project Watcher
      - PID 1738894
      - Entry: scripts/start-project-watcher.mjs
      - Theo dõi file thay đổi, index, verification sau khi file được ghi.

  3. Vite Web UI
      - PID 1816374
      - Port 4174
      - Entry: web/vite.config.js
      - Frontend chính: web/src/main.jsx

  ## 2. Các lớp chính

  ### A. Transport

  - HTTP API: src/transport/http/server.js
  - SSE conversation stream: src/transport/sse/conversation-stream.js
  - UI gọi HTTP và mở EventSource theo conversation.

  HTTP hiện có các nhóm:

  - owner message
  - decisions
  - agent settings
  - architecture workspace
  - dashboard
  - sprint plan
  - ticket delete
  - sprint run
  - history
  - task/session
  - project memory

  ### B. Owner Chat / Command Layer

  - src/application/owner-chat-service.js
  - src/application/ticket-command-parser.js
  - src/application/prose-ticket-service.js

  Nhiệm vụ:

  - Nhận message từ owner.
  - Nhận diện /ticket <id>.
  - Nhận diện JSON/prose ticket mới.
  - Validate ticket theo schema.
  - Ghi roadmap nếu ticket hợp lệ.
  - Dispatch ticket sang Builder.

  ### C. Governance / Roadmap

  - src/modules/governance/roadmap-store.js
  - src/modules/governance/sprint-plan-projection.js
  - src/application/sprint-plan-upload-service.js
  - provenance và architecture decision stores.

  Đây là nơi lưu:

  - roadmap
  - sprint
  - ticket
  - trạng thái ticket
  - provenance
  - dependency/decision liên quan

  ### D. Agent Layer

  - src/modules/agent/agent-gateway.js
  - provider adapters
  - agent runtime
  - context engine
  - memory retriever
  - session store.

  Các agent chính:

  - Architecture Manager
  - Sprint Leader
  - Builder
  - Reviewer

  Builder là agent đặc biệt vì có thể:

  - nhận /ticket
  - chạy execution
  - ghi file
  - chạy verification
  - chạy git
  - phát event real-time.

  ### E. Execution Layer

  - src/application/execution-layer.js
  - src/application/dispatch-change.js

  Các bước điển hình:

  1. kiểm tra checksum
  2. apply unified diff
  3. full file replace
  4. search/replace block
  5. structured patch
  6. trả execution result
  7. ghi Project Log
  8. phát node.execution_step hoặc execution.step.

  ### F. Verification Layer

  - src/modules/verification/check-runner.js
  - src/modules/verification/runner.js
  - verification orchestrator.

  Các gate thường gặp:

  - lint
  - typecheck
  - test
  - build
  - schema validation

  ### G. Git Layer

  Git được điều phối trong Control API:

  - git.status
  - git.add
  - git.commit

  Các event này được ghi log và phát qua unified stream để UI hiển thị.

  ### H. Watcher / Index Layer

  - src/modules/watcher
  - src/modules/index
  - src/modules/context

  Luồng:

  file write
    -> watcher
    -> incremental indexer
    -> verification
    -> context/memory update

  ### I. Persistence

  Có hai SQLite database:

  1. .forge/runtime/nf/index.db
      - Control API
      - communication
      - roadmap
      - agent profile
      - events
      - sessions
      - tasks

  2. .forge/runtime/wc/index.db
      - watcher
      - file index
      - symbols
      - context/indexing data

  Ngoài ra:

  - .forge/runtime/nf/project.log
  - dùng để lưu project execution/audit log và replay.

  ### J. Frontend

  - web/src/main.jsx
  - web/src/services/node-client.js
  - web/src/styles.css

  Frontend có:

  - chat theo conversation
  - optimistic owner message
  - SSE live events
  - history replay
  - cursor
  - work-step summary
  - expandable raw payload
  - ticket/sprint dashboard
  - Builder working state
  - timeout handling.

  ## 3. Luồng vận hành một ticket

  Owner UI
    -> POST /conversations/{id}/messages
    -> Control API
    -> prose/parser hoặc /ticket parser
    -> roadmap validation
    -> roadmap SQLite save
    -> Builder dispatch
    -> Agent Gateway
    -> execution-layer
    -> file write
    -> watcher/indexer
    -> verification
    -> git status/add/commit
    -> Project Log + communication bus
    -> SSE conversation stream
    -> UI render/replay

  Chi tiết event:

  execution.step
  git.status
  git.add
  git.commit
  verification.*
  index.*
  ticket.status_change
  node.status_change

  ## 4. Hai đường event chính

  ### Đường live

  producer
    -> unifiedStreamOrder
    -> internalBus
    -> communication bus
    -> SSE
    -> browser EventSource

  ### Đường replay

  project.log / event store / communication store
    -> conversation-stream
    -> cursor filter
    -> SSE replay
    -> UI merge với live state

  UI hiện cố gắng chống lỗi history ghi đè event live bằng Map merge theo message ID.

  ## 5. Schema hiện có

  Repo có:

  - 51 schema JSON được validator nạp
  - 78 fixture đang được kiểm tra
  - khoảng 135 file trong thư mục schemas/ nếu tính cả examples, docs và fixture.

  Nhóm schema:

  - core
  - agent
  - node
  - stream
  - execution
  - verification
  - governance
  - roadmap
  - project
  - results
  - log
  - context.

  Schema là hợp đồng dữ liệu giữa các lớp, nhưng hiện validation chủ yếu chạy trên fixture tĩnh; chưa validate tự động mọi event
  runtime trước khi phát SSE.

  ## 6. Những điểm dễ lỗi nhất

  Các vùng rủi ro cao nhất hiện nay:

  1. Schema stream không bao phủ hết event runtime
      - Schema mới biết node.*, nhưng backend còn phát execution.*, git.*, verification.*, index.*.

  2. Event verification thiếu conversation routing
      - Một số node.command/node.command_result chưa có conversation_id, có thể bị SSE loại bỏ.

  3. Roadmap và sprint projection
      - Ticket có thể được lưu nhưng nằm ở sprint khác với sprint UI đang hiển thị.
      - Projection hiện ưu tiên sprint đầu tiên.

  4. Ticket validation error
      - Giá trị enum sai như priority: "medium" bị trả thành lỗi “thiếu thông tin” thay vì báo sai enum.

  5. Live event và history replay
      - Nếu ID, timestamp, sequence hoặc conversation ID không nhất quán, UI có thể:
          - mất event
          - hiện trùng event
          - dồn event cuối ticket
          - không replay đủ khi reconnect.

  6. Status cleanup
      - node.status_change và ticket.status_change phải đồng bộ với workingByAgent; nếu thiếu một loại, “Builder is working” có
        thể còn sau khi ticket done.

  Tóm lại, hệ thống là một pipeline Node điều phối agent và execution, với Control API làm trung tâm, SQLite/project log làm
  persistence, watcher làm hậu xử lý file, SSE làm kênh live/replay và Vite UI làm lớp hiển thị.