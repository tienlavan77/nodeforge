## Giai đoạn 5 — Format code nâng cao

> `5a` (chỉ `full`) thực chất đã xong từ `1-5b` (Giai đoạn 1 chỉ chấp nhận `full`, coi format khác là lỗi) — không có việc mới, giữ dòng này chỉ để đánh dấu mốc đã qua. Việc thật của Giai đoạn 5 là `5b`/`5c`/`5d`.

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 5a | Chỉ hỗ trợ `format: full` | ✅ Đã có (từ 1-5b) | Không cần làm gì thêm — chỉ chuyển trạng thái để phản ánh đúng thực tế. |

### 5b — Chọn và validate format nâng cao

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 5b-1 | `decideFormat(filePath, retryCount)` | ☐ Chưa làm | File mới → `full_content`; file tồn tại → ưu tiên `structured_patch`; escalation theo policy 5d. |
| 5b-2 | Gắn `decideFormat` vào nơi build `code_provide` (1-5a / `handleCodeExchange` 2a-1) | ☐ Chưa làm | Thêm field `required_output_format` cho từng file trong payload gửi agent — schema đã có sẵn (0a-3), chỉ cần Node điền đúng giá trị. |
| 5b-3 | `validateFull(file)` | ☐ Chưa làm | Kiểm tra `content` không rỗng, trả `{valid, finalContent}`. |
| 5b-4 | `validateDiff(file)` | ☐ Chưa làm | Dùng thư viện diff (`applyPatch`) thử áp lên nội dung file thật (đọc qua `guardedRead` 3b-3) — trả `{valid, finalContent, error}`. |
| 5b-5 | `validateSyntax(language, content)` | ☐ Chưa làm (tái dùng) | Đây chính là phần trong `verifySyntax` (4b-2) — tách ra thành hàm dùng chung `validateSyntax(language, content)`, để cả `verifySyntax` (verify cấp task) lẫn `validateFile` (validate cấp file, ở đây) gọi cùng 1 hàm, không viết 2 lần. |
| 5b-6 | `validateFile(file)` — điều phối theo `format` | ☐ Chưa làm | `full` → 5b-3, `unified_diff` → 5b-4; case `patch` tạm để `throw "chưa hỗ trợ"` (bổ sung ở 5c). Sau bước format-specific, luôn chạy tiếp `validateSyntax` (5b-5) trên `finalContent`. |
| 5b-7 | Gắn `validateFile` vào nhánh patch (1-5b và trong `handleCodeExchange`) — validate TRƯỚC KHI ghi | ☐ Chưa làm | Validate hết toàn bộ file trong response trước, fail bất kỳ file nào → **reject cả round** (atomic), không ghi file nào — build request retry mới (`metadata.previous_error`) quay lại state machine, không tự sửa diff giùm agent. |
| 5b-8 | Test case: agent trả diff không áp được (context lines lệch) | ☐ Chưa làm | Xác nhận: không file nào bị ghi, round retry được tạo đúng với lỗi cụ thể kèm `current_file_state` (nội dung file thật) gửi lại. |

### 5c — Hai dạng patch

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 5c-1 | `structured_patch` dùng `operations[]`; `apply_patch` giữ patch text | ✅ Đã làm | Tối thiểu: `insert_after` (anchor_line, new_content), `replace_range` (start_line, end_line, new_content), `insert_at_end` (new_content) — đã phác thảo trong thiết kế, giờ cố định lại thành field chuẩn. |
| 5c-2 | `validatePatch(file)` | ✅ Đã làm | Với mỗi operation: check `anchor_line` có tồn tại trong file thật / `end_line` không vượt số dòng — fail 1 operation thì fail cả file, không áp phần còn lại. Áp toàn bộ operations atomic mới trả `finalContent`. |
| 5c-3 | Materialize structured patch trước khi ghi | ✅ Đã làm | |
| 5c-4 | Xác nhận adapter parse đúng field `content` khi `format: patch` | ☐ Chưa làm | Với OpenAI: `content` là string đã `JSON.stringify` (đã ghi chú trong `forge-agent-response-schemas.json`) — adapter phải `JSON.parse()` lại trước khi đưa vào `validatePatch`. Với Claude: `content` đã là object sẵn, không cần parse. |

### 5d — Escalation tự động

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 5d-1 | Track `retryCountPerFile` (theo `task_id + path`, KHÁC round counter theo task ở Giai đoạn 3) | ☐ Chưa làm | Tăng mỗi khi 1 file cụ thể fail `validateFile` và cần agent tạo lại — không liên quan số round tổng của cả task. |
| 5d-2 | Xác nhận `decideFormat` (5b-1) đọc đúng `retryCountPerFile` này | ☐ Chưa làm | Điều kiện `retryCount ≥ 2 → full` đã viết sẵn ở 5b-1 — chỉ cần đảm bảo nguồn dữ liệu đếm đúng theo từng file, không lẫn giữa các file khác nhau trong cùng task. |
| 5d-3 | Thêm `format_escalation_notice` vào request retry khi ép về `full` | ☐ Chưa làm | Câu text rõ ràng ("diff đã fail N lần, từ giờ bắt buộc format full cho file này") — tránh agent hiểu nhầm là yêu cầu tuỳ hứng. |

**Thứ tự làm khuyến nghị:** `5b-3→5b-6` (viết các hàm validate, test độc lập bằng file mẫu + diff mẫu, chưa cần agent thật) → `5b-1/5b-2` (Node quyết định format, gắn vào request) → `5b-7/5b-8` (nối vào nhánh patch, test bằng mock trả diff cố ý sai) → `5c` (thêm patch, làm sau vì phụ thuộc cấu trúc `validateFile` đã ổn định từ 5b) → `5d` (escalation, phụ thuộc 5b-1 đã có sẵn điều kiện, chỉ cần nối đúng nguồn đếm).

---

giai-doan-5.md đang mô tả đúng hướng, nhưng trạng thái và một số contract chưa khớp
  implementation hiện tại.

  Nhận xét chính

  1. 5a đã hoàn tất nhưng tên format phải thống nhất
      - Code canonical dùng full_content, không phải full.
      - full chỉ còn là alias tương thích trong submission-format.js.
      - Tài liệu nên ghi format: full_content.

  2. 5b chưa đúng trạng thái “chưa làm” hoàn toàn
     Hiện đã có:
      - unified_diff parser/apply trong execution-handlers/unified-diff.js.
      - applyUnifiedDiff(..., dry_run: true) để validate trước khi ghi.
      - Stage-1 submit handler đã materialize diff thành full content.
      - OpenAI request builder đã constrain schema theo unified_diff hoặc apply_patch.
      - Prompt cho unified diff/apply patch đã có.

     Vì vậy 5b nên tách thành:
      - Đã có: parser, dry-run, provider prompt/schema, atomic validation.
      - Còn thiếu: decideFormat() tự động theo file size/retry và validation syntax dùng
        chung.

  3. 5b-3/5b-4 đang dùng tên hàm chưa tồn tại
     Tài liệu nêu validateFull() và validateDiff(), nhưng code hiện dùng:
      - materializeChanges()
      - applyUnifiedDiff()
      - applyApplyPatch()

     Cần quyết định một trong hai:
      - đổi tài liệu theo tên hàm thật;
      - hoặc tạo facade validateFile() rồi bên trong gọi các handler hiện có.

  4. 5b-4 ghi guardedRead, nhưng implementation thực tế phải dùng File Service
     Theo nguyên tắc đã chốt, Node/Agent không đọc filesystem trực tiếp. Diff validation nên
     gọi:

     fileService.readFile({ path })

     Không nên đưa guardedRead vào tài liệu nếu đó không phải API chính thức đang dùng.

  5. 5b-5 chưa có validator syntax dùng chung
     Verification hiện chạy command-level:
      - lint;
      - build;
      - typecheck;
      - test.

     Chưa có hàm validateSyntax(language, content) dùng chung cho từng file. Không nên đánh
     dấu mục này hoàn tất chỉ vì verification runner tồn tại.

  6. 5c apply patch thực tế đã có phần lớn
     apply-patch.js đã hỗ trợ dialect:

     *** Begin Patch
     *** Update File: path
     @@
     -old
     +new
     *** End Patch

     Nhưng nó chưa phải structured operations như tài liệu mô tả (insert_after,
     replace_range, insert_at_end). Vì vậy cần đổi tên rõ:
      - apply_patch hiện tại = text patch có context;
      - structured operations[] = một format/schema khác, chỉ thêm nếu thực sự cần.

     Không nên mô tả rằng structured operations đã được phác thảo nếu schema canonical hiện
     chưa nhận object operations.

  7. 5c-4 có nguy cơ sai contract OpenAI
     Tài liệu nói OpenAI gửi content là JSON string rồi adapter parse lại. Cần kiểm tra
     schema/provider normalizer thực tế trước khi chốt. Hiện stage1-submit-code-handler.js
     yêu cầu file.content là string đối với apply_patch; nếu chuyển sang object operations
     thì phải cập nhật cả:
      - canonical schema;
      - OpenAI tool schema;
      - normalizer;
      - submit handler;
      - tests.

  8. 5d escalation hiện mới là retry toàn request, chưa phải theo từng file
     Runner đang có formatRetries cấp task/round. Chưa có:

     retryCountPerFile[task_id + path]

     Do đó chưa thể nói đã có escalation riêng cho từng file. Đây là khác biệt quan trọng khi
     response chứa nhiều file, chỉ một file bị lỗi.

  9. Retry format escalation
     Runtime hiện đã có notice chuyên biệt khi chuyển format. Policy canonical là:

     structured_patch → apply_patch → unified_diff → full_content (chỉ khi file <= 3 KiB)

     Mỗi bước retry giữ checksum/context do Node cung cấp. File lớn không được ép
     full_content; khi mọi format phù hợp thất bại, task chuyển `needs_human_review`.

  10. Thứ tự triển khai đã hiệu chỉnh theo code hiện tại
     1. Chuẩn hóa contract/schema mapping cho bốn format.
     2. Hoàn thiện validateFile và dry-run atomic trước khi ghi qua File Service.
     3. Hoàn thiện decideFormat theo file mới/cũ, kích thước 3 KiB và retry state.
     4. Nối format selection vào mọi code-exchange path.
     5. Hoàn thiện retry theo từng file: structured_patch → apply_patch → unified_diff
        → full_content; hết format an toàn thì `needs_human_review`.
     6. Bổ sung test file mới, file lớn, syntax/checksum lỗi, atomic reject và escalation.
     7. Chạy schema validation, lint, typecheck và integration test trước khi đánh dấu hoàn tất.

  Kết luận

  Giai đoạn 5 chưa nên đánh dấu hoàn tất. Thực tế hiện tại là:

  - 5a: đã có, nhưng canonical là full_content.
  - 5b: đã triển khai validate/format handling; tiếp tục hoàn thiện các gate và test còn thiếu.

  - 5c: đã có text `apply_patch` và `structured_patch` operations[].
  - 5d: đã có escalation theo chuỗi format; retry state per-file được theo dõi trong runtime và cần tiếp tục kiểm thử giới hạn.

  Điểm cần sửa đầu tiên trong tài liệu là phân biệt rõ đã có parser/apply format với chưa có
  policy tự động chọn format.

  STRUCTURED PATCH REQUIREMENTS

For every existing file that must be modified:

1. Return "format": "structured_patch".
2. "content" MUST be a JSON object containing "operations".
3. "operations" MUST contain only the supported structured operations defined by the schema.
4. Operations are applied sequentially by Node in the order returned.
5. Do not return unified diff, apply_patch text, Markdown code fences, or patch strings.
6. Do not return full file content when format is "apply_patch".
7. Each operation MUST describe an exact transformation of the file context supplied by Node.
8. Do not invent line numbers.
9. Line numbers MUST refer to the current file state at the point where that operation is applied.
10. Do not use placeholders such as "...", "[unchanged]", or "[rest of file]".

CHECKSUM REQUIREMENTS

11. For "exists": true, "before_checksum" MUST be copied exactly from the corresponding file context supplied by Node.
12. Never calculate, regenerate, modify, shorten, normalize, or guess the checksum.
13. If the file context or checksum is missing, invalid, or ambiguous, return "code_needed" instead of generating operations.

NODE OWNERSHIP

14. The Node owns the filesystem and applies all operations.
15. The agent must not assume that an operation has been applied until Node confirms it.