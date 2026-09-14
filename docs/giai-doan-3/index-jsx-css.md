# Kế hoạch index JSX và CSS cho Code Search

## 1. Mục tiêu

Làm giàu Code Index/FTS5 cho các luồng UI bằng cách coi JSX markup và CSS selector là các đơn vị có cấu trúc, có tên và có vị trí dòng. Mục tiêu trực tiếp là giúp Agent đi từ một UI identifier (component, `className`, `id`, selector hoặc attribute) tới đúng file và đúng block code, thay vì phải dò nhiều cửa sổ của file lớn.

Phạm vi ưu tiên là code UI trong `ui/nextjs`: JSX/TSX và CSS. HTML thuần không phải mục tiêu chính của đợt đầu vì ứng dụng hiện dùng Next.js/JSX và không có luồng `.html` đáng kể trong source chính.

## 2. Vấn đề hiện tại

### 2.1 CSS đã được index raw content nhưng chưa ổn định

Incremental indexer hiện ghi toàn bộ content của file vào `file_content_fts`, kể cả file không có extractor, vì registry trả về `emptyExtraction()` (một extraction hợp lệ nhưng rỗng). Do đó CSS có thể tìm thấy bằng raw text sau watcher event.

Ngược lại, full rebuild đang bỏ qua file khi `registry.supports(path)` trả về false. CSS có thể biến mất khỏi index sau rebuild. Cần xử lý sự bất nhất này trong cùng kế hoạch trước khi dựa vào CSS search trong production.

### 2.2 Thiếu symbol/block cho CSS

CSS chưa có extractor nên không có rows trong `symbols` và `symbol_content_fts`. `read_file` preview vì vậy không thể trả `symbol_map` cho CSS; Agent phải đọc mù các window của file lớn như `globals.css`.

### 2.3 JSX mới được hiểu chủ yếu như JavaScript

Extractor JavaScript hiện cung cấp các symbol JavaScript/JSX ở mức component và declaration, nhưng UI metadata như `className`, `id`, HTML tag, ARIA/data attribute chưa được mô hình hóa thành các đơn vị tìm kiếm riêng. Query theo selector hoặc tiêu đề UI vì thế dễ trả về kết quả thiếu liên kết giữa component và style.

## 3. Kết quả mong muốn

Với code tương tự:

```jsx
<select className="architecture-manager-selector" aria-label="Select Architecture Manager">
```

và:

```css
.architecture-manager-selector { ... }
```

Code Search có thể trả về:

- component/file JSX chứa markup;
- symbol UI metadata `architecture-manager-selector` với dòng bắt đầu/kết thúc;
- CSS selector tương ứng với block và dòng;
- snippet của từng block;
- kết quả symbol được xếp hạng cao hơn raw whole-file match khi phù hợp.

`read_file` preview của file UI lớn cũng trả symbol map để Agent chọn window chính xác.

## 4. Thiết kế đề xuất

### 4.1 Mở rộng parser registry theo extension

Đăng ký các extractor UI độc lập trong parser registry:

- `.jsx`, `.tsx`: giữ extractor JavaScript hiện tại và bổ sung extraction metadata UI trong cùng pipeline, không tạo duplicate file index.
- `.css`: thêm CSS extractor.
- `.scss`, `.less`: chỉ đăng ký sau khi xác nhận source UI thực sự dùng các extension này; không mở rộng phạm vi chỉ vì khả năng tương lai.

Extractor phải tuân theo `EXTRACTION_SHAPE` hiện có. Các symbol tối thiểu gồm `name`, `kind`, `start_line`, `end_line`. Imports/exports/calls không được suy diễn cho CSS.

### 4.2 CSS extractor phiên bản đầu

Dùng parser/lexer phù hợp với cú pháp CSS thay vì regex đơn giản nếu dependency và chi phí vận hành cho phép. Nếu chọn regex ở MVP, phải giới hạn rõ các construct an toàn và có test cho comment, string, nested syntax và selector nhiều dòng.

Nên trích xuất:

- class selector, ví dụ `.architecture-manager-selector`;
- ID selector, ví dụ `#project-chat`;
- CSS custom property, ví dụ `--color-primary`;
- `@keyframes`;
- `@media`/container block khi xác định được phạm vi dòng;
- selector group như `.a, .b` thành các tên tìm kiếm riêng nhưng cùng line range hoặc cùng block identity.

Không nên trích xuất mọi element selector (`div`, `span`, `*`) thành symbol mặc định vì gây noise lớn. Có thể giữ chúng trong block content để FTS raw search, chỉ nâng cấp thành symbol khi có nhu cầu đã được đo lường.

`kind` cần ổn định, ví dụ `css_class`, `css_id`, `css_variable`, `css_keyframes`, `css_at_rule`. Tên symbol phải bỏ dấu chấm/hash nhưng content block vẫn giữ selector nguyên bản.

### 4.3 JSX UI metadata

Bổ sung metadata vào extraction của `.jsx`/`.tsx` mà không làm mất symbol component hiện có. Ưu tiên:

- `className` string và các literal trong template/class expression;
- `id` literal;
- HTML/JSX tag name (`select`, `button`, `input`, ...);
- `aria-*` và `data-*` attributes;
- literal UI label/heading chỉ khi có line range rõ ràng.

Mỗi metadata symbol phải có line range hẹp nhất có thể. Với class expression động, chỉ index các literal tĩnh; không cố đoán giá trị runtime. Cần tránh tạo quá nhiều symbol cho từng token vô nghĩa hoặc giá trị không định danh.

Các `kind` đề xuất: `jsx_class`, `jsx_id`, `jsx_tag`, `jsx_aria`, `jsx_data`, `jsx_text`. Component symbol hiện có vẫn giữ nguyên để không phá các query đang hoạt động.

### 4.4 Index và FTS5

Tận dụng đường ghi hiện tại:

1. extractor ghi rows vào `symbols`;
2. `indexContent()` tạo block content từ line range;
3. block được ghi vào `symbol_content_fts`;
4. Code Search query cả `symbol_content_fts` và `file_content_fts`;
5. symbol/block match trả `symbol_name`, `symbol_kind`, `start_line`, `end_line`, snippet và score.

Cần cập nhật `languageForPath`/language mapping để CSS, SCSS, LESS được phân loại đúng nếu các extension đó được chấp thuận. Cần xác định rõ `symbol_content_fts` có cần thêm cột selector/attribute chuyên biệt hay không; MVP có thể dùng `name`, `kind` và `content` hiện có, tránh thay đổi schema nếu chưa chứng minh cần thiết.

Ranking nên ưu tiên theo thứ tự:

1. exact symbol/selector match;
2. symbol block match;
3. JSX component/UI metadata match;
4. whole-file content match.

Không dùng token phổ biến như `div`, `button` hoặc `className` làm tín hiệu mạnh hơn identifier cụ thể.

### 4.5 Rebuild và watcher consistency

Đảm bảo full rebuild và incremental indexing áp dụng cùng chính sách hỗ trợ file:

- file UI đã đăng ký extractor phải được full rebuild index;
- file CSS/JSX được watcher theo dõi và reindex khi tạo/sửa/xóa/đổi tên;
- nếu quyết định index raw content cho một extension không có extractor, rebuild cũng phải index raw content theo cùng chính sách;
- không để kết quả search phụ thuộc vào việc file được index qua watcher hay rebuild.

Sau khi extractor được đăng ký, cần rebuild index một lần và xác nhận số file/symbol trước khi thử Agent thật.

## 5. Lộ trình triển khai

### Giai đoạn A — CSS MVP

- Chốt danh sách construct CSS và loại noise.
- Viết extractor CSS theo extraction contract.
- Đăng ký `.css` và cập nhật language mapping.
- Sửa consistency giữa full rebuild và incremental indexing.
- Thêm unit tests cho symbol, line range, malformed/empty CSS và selector group.
- Rebuild index local, kiểm tra `file_content_fts`, `symbols`, `symbol_content_fts` và `search_code`.

### Giai đoạn B — JSX metadata

- Mở rộng extractor JSX/TSX để lấy class/id/tag/ARIA/data literal.
- Giữ nguyên component/declaration extraction hiện có.
- Thêm tests cho JSX static, conditional class expression, multiline markup và dynamic-only value.
- Kiểm tra duplicate symbol và giới hạn số symbol trên file lớn.

### Giai đoạn C — Search ranking và Agent retrieval

- Đánh giá query theo component name, class, id, label và selector.
- Điều chỉnh bm25/bonus chỉ khi benchmark cho thấy noise hoặc thứ hạng sai.
- Xác nhận `read_file` preview trả symbol map hữu ích cho CSS/JSX.
- Chạy tool-lab rồi chạy ticket UI thật; đo số discovery calls trước edit và số window read.

### Giai đoạn D — Mở rộng có điều kiện

Chỉ thực hiện nếu source audit cho thấy có nhu cầu:

- `.scss`/`.less`;
- HTML thuần;
- CSS nesting/container query nâng cao;
- quan hệ heuristic giữa JSX class và CSS selector.

Không triển khai HTML extractor chỉ để đạt độ bao phủ trên giấy.

## 6. Contract kết quả cần giữ

`search_code` vẫn là tool metadata-first, không trả full file. Symbol/block result nên giữ các field hiện có:

- `path`;
- `language`;
- `symbol_name`;
- `symbol_kind`;
- `start_line`;
- `end_line`;
- `snippet`;
- `score` và `reason`;
- `index_version`.

Nếu cần phân biệt selector với symbol thường, dùng `symbol_kind`, không thêm một result shape riêng khi chưa cần thiết.

`read_file` preview dùng cùng symbol lookup hiện tại; không tạo đường đọc filesystem mới chỉ cho CSS/JSX.

## 7. Kiểm thử và nghiệm thu

### Unit/integration

- CSS class/id/custom property/keyframes có đúng tên và line range.
- Selector group không tạo block trùng hoặc range sai.
- Comment/string chứa `.fake-selector` không bị index nhầm.
- CSS malformed không làm hỏng toàn bộ index; hành vi lỗi phải nhất quán với extractor hiện có.
- JSX static class/id/tag/ARIA/data được index.
- JSX dynamic expression không bị ghi thành tên giả.
- Component symbol cũ vẫn tồn tại và query cũ không regression.
- Rebuild và watcher tạo kết quả tương đương cho cùng một snapshot.
- Xóa/sửa file dọn đúng `symbols`, `symbol_content_fts` và `file_content_fts` cũ.

### Benchmark retrieval

Tạo bộ query đại diện:

- component: `ArchitectureManagerSelector`;
- CSS class: `architecture-manager-selector`;
- ID;
- ARIA label;
- CSS variable;
- selector phổ biến (`button`, `select`) để đo noise;
- query kết hợp tiếng Việt/tiếng Anh đã được hỗ trợ bởi FTS5 hiện tại.

Tiêu chí đạt:

- query identifier trả đúng file/block trong top results;
- result có line range dùng được để gọi `read_file`;
- Agent không cần đọc toàn bộ `globals.css` để sửa selector liên quan;
- không làm giảm kết quả chính xác của JavaScript/TypeScript search;
- discovery budget được sử dụng cho edit sớm hơn, không tăng số lần dò mù.

### Tool-lab và real run

- chạy toàn bộ unit tests liên quan parser/index/search;
- chạy `search_code` trong Tool Lab;
- rebuild index production-like;
- chạy một ticket UI kiểm soát qua Codex;
- kiểm tra log execution, discovery count, read windows, edit diff và verification.

## 8. Rủi ro và giới hạn

- CSS nesting, preprocessor syntax và selector phức tạp có thể vượt khả năng extractor MVP.
- JSX className động không thể biết đầy đủ ở static analysis.
- Index mọi tag/attribute sẽ làm tăng symbol count và noise, đồng thời tăng thời gian rebuild.
- Heuristic nối class JSX với CSS cùng tên không chứng minh được quan hệ runtime.
- Thay đổi ranking quá mạnh có thể làm query code backend kém chính xác.
- `globals.css` lớn nên cần đo kích thước index và thời gian rebuild trước khi bật production.

Nguyên tắc an toàn: khi extractor không chắc chắn, giữ raw file match thay vì tạo symbol sai; một symbol sai nguy hiểm hơn việc thiếu một symbol.

## 9. Ngoài phạm vi

- Không triển khai feature UI của ticket dùng để kiểm thử pipeline.
- Không sửa Add Ticket UI/CSS.
- Không index build artifacts, `.next`, backup hoặc dependency directories.
- Không xây dựng CSS AST đầy đủ hoặc suy luận cascade/specificity.
- Không thêm synonym dictionary hay spellfix vào cùng đợt nếu chưa có benchmark chứng minh nhu cầu.
- Không thay đổi discovery budget hoặc prompt governance trong tài liệu này.

## 10. Phụ thuộc và thứ tự ưu tiên

Trước khi chạy Agent UI tiếp theo, nên sửa prompt governance đang mô tả riêng `4 search_code + 4 read_file` thành mô tả đúng hard budget dùng chung 8 discovery calls. Đây là thay đổi tài liệu hành vi nhỏ, độc lập với extractor, nhưng tránh Agent hiểu sai quota.

Thứ tự đề xuất:

1. Sửa mô tả hard budget trong prompt.
2. CSS MVP và rebuild consistency.
3. JSX metadata.
4. Benchmark/ranking.
5. HTML hoặc preprocessor chỉ khi source audit yêu cầu.

Mọi bước viết code cần được duyệt riêng trước khi triển khai.
