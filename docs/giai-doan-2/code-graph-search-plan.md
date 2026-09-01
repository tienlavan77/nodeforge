# Kế hoạch Code Graph và Search

## Mục tiêu

Xây lớp tra cứu tĩnh giúp Node biết file nào liên kết với file nào, function nào gọi function nào, và chọn vùng code liên quan cho ticket lớn. Lớp này không thay thế happy path `1e` và chưa tự dispatch Agent.

## Nguyên tắc

- Code Index chỉ là metadata/search index; source thật luôn được đọc qua File Service.
- Protocol Storage không dùng làm Code Index.
- Không index hoặc trả về secret, generated files, binary và runtime artifacts.
- Mọi kết quả có `sha256`, `index_version`, `confidence`.
- Bắt đầu bằng truy vấn tĩnh và keyword; chưa cần embedding.
- Giới hạn graph depth, số file và ngân sách token.

## Milestone tối thiểu

### M1 — File graph

Dùng các bảng `files`, `imports_exports`, `dependency_edges`. API:

```text
getImports(path)
getImporters(path)
getDependencies(path, depth = 1)
getDependents(path, depth = 1)
```

Kết quả có path, loại cạnh, broken flag, checksum và index version.

### M2 — Function graph

Dùng `symbols` và `calls`. API:

```text
getFunctions(path)
getCallers(path, functionName)
getCallees(path, functionName)
```

Phải trả riêng vị trí định nghĩa (`start_line/end_line`) và vị trí gọi (`line`). Trước mắt hỗ trợ static identifier call; member call như `publisher.publish()` là mở rộng sau.

### M3 — Search tối thiểu

Tìm theo path/filename, symbol name và keyword. Kết quả có path, symbol/line range nếu có, score/reason, checksum và index version.

## Bản mở rộng

### E1 — Content index

Thêm FTS5 cho nội dung file/symbol. Nội dung do File Service đọc lúc index; file lớn chỉ index signature/metadata. FTS là bản sao tìm kiếm, không phải source-of-truth.

### E2 — Relevant tree

Từ `title`, `objective`, `acceptance_criteria`: trích keyword → search path/symbol/content → xếp hạng seed → mở rộng import/caller depth 1–2 → thêm test/route → loại file ignore → giới hạn file/token. Mỗi entry có `score`, `reason`, `symbols`, `relations`, `confidence`.

### E3 — Context Planner

Agent nhận relevant tree và chọn file qua `code_needed`; Node xác minh path, đọc source qua File Service. Checksum lệch thì trả `CONTEXT_STALE`, re-index rồi yêu cầu truy vấn lại; không trả context cũ.

## Incremental indexing

```text
watcher -> File Service readForIndex -> sha256/size/language
  -> parse symbols/imports/exports/calls
  -> cập nhật metadata + graph + content index trong transaction
  -> tăng index_version
```

Delete/rename phải cập nhật đồng bộ files, symbols, calls, relations, FTS và index version.

## Ignore và bảo mật

Indexer/Search bỏ qua độc lập với protected-path ghi file:

```text
.git/  .forge/runtime/  .next/  .next.stale-*/
.DS_Store  ._*  .env  .env.*  *.pem  *.key  *.p12
credential/secret config và binary files
```

## Metadata tương lai

File Service, Code Index và Protocol Storage dùng chung `sha256:<64 hex>`. Bảng `files` chuẩn bị `worktree_id`/`branch` nullable cho multi-agent; Giai đoạn 1–2 chưa dùng.

## Test và gate

Test import/reverse-import, dependency depth/broken edge, function caller/callee/line, path/symbol/keyword search, watcher update/delete/rename, stale checksum, ignore rules, ranking và giới hạn budget. Gate:

```text
pnpm --dir backend lint
pnpm --dir backend typecheck
pnpm --dir backend validate:schemas
node --test backend/tests/...
git diff --check
```

Thứ tự: `contract → File Service readForIndex → file graph → function graph → search tối thiểu → content index → relevant tree → context planner → tests`. Chỉ nối vào pipeline 9 bước sau khi M1–M3 ổn định.

Các giai đoạn triển khai Code Graph/Search nên đi theo thứ tự này:

  1. Contract và phạm vi

  - Chốt node/edge:
      - file -> file: import, export, require, dependency.
      - function -> function: call, caller, callee.

  - Chuẩn hóa kết quả gồm path, line, checksum, index_version, confidence.
  - Giữ 1e độc lập, chưa phụ thuộc Graph/Search.

  2. File Service cho indexing

  - Thêm API readForIndex(path).
  - Trả content, sha256, size_bytes, language.
  - Kiểm tra path và loại secret/binary/runtime files.
  - Không cho indexer đọc filesystem trực tiếp.

  3. M1 — File Graph

  - Hoàn thiện truy vấn từ files, imports_exports, dependency_edges.
  - Xây:
      - getImports
      - getImporters
      - getDependencies
      - getDependents

  - Hỗ trợ depth giới hạn và broken edge.
  - Viết test hai chiều.

  4. M2 — Function Graph

  - Dùng symbols và calls.
  - Xây:
      - getFunctions
      - getCallers
      - getCallees

  - Trả dòng định nghĩa, dòng gọi, caller function, target function.
  - Trước mắt hỗ trợ static identifier call.

  5. M3 — Search tối thiểu

  - Tìm theo:
      - path;
      - filename;
      - symbol;
      - keyword.

  - Trả score/reason, line range, checksum, index version.
  - Chưa cần embedding hoặc FTS.

  6. Incremental index integration

  Mỗi create/modify:

  watcher
    -> File Service readForIndex
    -> checksum/size/language
    -> parse
    -> update metadata + graph
    -> tăng index_version

  Delete/rename phải xóa hoặc cập nhật đồng bộ toàn bộ cạnh và symbol liên quan.

  7. E1 — Content Index

  - Thêm FTS5 cho nội dung file/symbol.
  - File lớn chỉ index signature/metadata.
  - FTS chỉ phục vụ search, không phải source-of-truth.
  - Nội dung thật vẫn đọc lại qua File Service.

  8. E2 — Relevant Tree

  ticket text
    -> trích keyword/identifier
    -> path/symbol/content search
    -> ranking seed files
    -> mở rộng import/caller depth 1-2
    -> thêm test/route liên quan
    -> loại file bị ignore
    -> giới hạn file/token
    -> relevant_tree

  9. E3 — Context Planner

  - Agent nhận relevant_tree.
  - Agent trả code_needed.
  - Node xác minh path bằng Code Index.
  - Node đọc source qua File Service.
  - Checksum lệch:
      - trả CONTEXT_STALE;
      - re-index;
      - yêu cầu truy vấn lại;
      - không trả context cũ.

  10. Test và gate

  Test:

  - import/reverse-import;
  - dependency depth;
  - function caller/callee;
  - line number;
  - keyword/symbol/content search;
  - watcher update/delete/rename;
  - stale checksum;
  - ignore secret/generated files;
  - ranking và budget limit.

  Gate:

  pnpm --dir backend lint
  pnpm --dir backend typecheck
  pnpm --dir backend validate:schemas
  node --test backend/tests/...
  git diff --check

  11. Nối lại pipeline 9 bước

  Chỉ sau khi M1–M3 ổn định:

  relevant_tree
    -> task
    -> code_needed
    -> code_provide
    -> submit_code_response

  Thứ tự tổng quát:

  Contract
    -> File Service
    -> M1 File Graph
    -> M2 Function Graph
    -> M3 Search tối thiểu
    -> Incremental integration
    -> E1 Content Index
    -> E2 Relevant Tree
    -> E3 Context Planner
    -> Tests/Gates
    -> Pipeline integration

    Đúng. Theo sơ đồ đó, watcher chỉ xử lý nhánh External change. Pipeline Node/Agent không phụ thuộc
  watcher:

  Build Graph ban đầu
  → tạo Code Index

  Node/Agent
  → File Service ghi file
  → Index Service cập nhật ngay

  Vì vậy khi chỉ có thay đổi do Node/Agent tạo ra:

  - Không cần chạy watcher daemon.
  - Không cần rebuild toàn bộ graph sau mỗi ticket.
  - File Service ghi xong thì Node gọi Index Service/incremental indexer trực tiếp.
  - Search/Graph dùng được dữ liệu mới ngay.
  - Watcher chỉ cần bật nếu có thay đổi bên ngoài như editor, git checkout, script khác.

  Sơ đồ đầy đủ vẫn giữ nguyên để hỗ trợ cả hai nguồn:

  External change ──> Watcher ──> Incremental Indexer
                                            │
  Node/Agent ──> File Service ──────────────┘
                     │
                     └──> Index Service cập nhật ngay

  Tóm lại: build graph một lần lúc khởi động; sau đó Node cập nhật index trực tiếp qua Index Service.
  Watcher là tùy chọn, không phải dịch vụ bắt buộc.

  Có. Để truy vấn chính xác hơn, nên bổ sung các cơ chế sau theo thứ tự ưu tiên:

  1. Suy ra phạm vi từ ticket

  Từ title/objective/criteria, Node xác định:

  {
    "scope": "ui",
    "allowed_prefixes": ["ui/nextjs/"],
    "excluded_prefixes": ["backend/", "tests/", ".forge/", ".next/"]
  }

  Với FORGE-UI-040, candidate chính chỉ được lấy trong ui/nextjs/**. Backend chỉ là fallback khi
  không tìm thấy file UI phù hợp.

  2. Tách từ khóa theo trọng số

  Không chấm mọi từ ngang nhau:

  - Agent Profile, page, Next.js: trọng số cao.
  - navigation, layout, component: trọng số trung bình.
  - application, state, data, create, ticket: trọng số thấp hoặc stop word theo ngữ cảnh.

  Ví dụ:

  Agent Profile = 3.0
  page = 2.5
  Next.js = 2.5
  navigation = 1.5
  application = 0.2

  3. Tìm theo nhiều dạng cùng lúc

  Thực hiện song song:

  - Path search: page, agent, profile
  - Symbol search: AgentPage, AgentProfile, Profile
  - Content search: agent profile, navigation
  - Extension/language filter: .jsx, .tsx cho UI ticket

  Sau đó hợp nhất theo path, không để một file xuất hiện nhiều lần.

  4. Ưu tiên tên file và symbol khớp trực tiếp

  Điểm ưu tiên nên là:

  symbol exact > filename exact > path segment > content match > graph relation

  Vì file page-agent.jsx khớp trực tiếp với nhiệm vụ hơn file backend có symbol create hoặc state.

  5. Lọc scope trước khi cắt top-N

  Hiện tại Relevant Tree lấy top 30 toàn repository rồi mới lọc, khiến file UI bị loại sớm. Cần đổi
  thành:

  query index -> filter allowed_prefixes/extensions -> score -> graph expansion -> top 3

  Không được:

  query toàn repo -> top 30 -> mới lọc UI

  6. Graph expansion có điều kiện

  Chỉ mở rộng dependency/dependent sau khi đã có primary UI candidate. Với page-agent.jsx, có thể
  lấy:

  - NodeForgeApp.jsx
  - node-client.js
  - file layout/navigation trực tiếp liên quan

  Không mở rộng từ backend seed chỉ vì có từ profile.

  7. Phân loại candidate

  Mỗi kết quả nên có:

  {
    "path": "ui/nextjs/app/page-agent.jsx",
    "role": "primary",
    "score": 4.8,
    "match_reasons": ["filename", "symbol", "content"]
  }

  Các nhóm:

  - primary: tối đa 3 file, gửi đầu tiên.
  - wiring: import/export trực tiếp, ban đầu chỉ gửi metadata.
  - reference: snippet hoặc signature.
  - excluded: tests, generated, runtime, backend ngoài scope.

  8. Yêu cầu Agent xác nhận context

  Sau khi gửi primary files, Node hỏi Agent:

  Context này đã đủ để thực hiện ticket chưa?
  Nếu chưa, hãy trả code_needed với path/symbol cụ thể.

  Agent không được tự suy đoán hoặc yêu cầu ".".

  9. Trả về confidence và lý do

  Nếu không có file nào đạt ngưỡng, Node phải báo:

  CODE_CONTEXT_INSUFFICIENT

  thay vì gửi các file backend điểm thấp. Điều này chính xác hơn việc cố đủ 3 file.

  Với ticket này, sau các cải tiến trên, kết quả kỳ vọng là:

  1. ui/nextjs/app/page-agent.jsx       primary
  2. ui/nextjs/app/NodeForgeApp.jsx     wiring
  3. ui/nextjs/lib/node-client.js       wiring/reference

  Đề xuất quan trọng nhất: thêm scope + allowed_prefixes vào Relevant Tree API và lọc trước khi top-
  N.