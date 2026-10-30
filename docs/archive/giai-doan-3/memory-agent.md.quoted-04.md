<!-- Preserves a quoted historical document section so engineers can read archived examples without treating them as new executable definitions; removing quote prefixes reconstructs the exact original bytes. -->
> 2. locked_new_files lớn                    → cắt, giữ path + after_checksum
> 3. submitted_content / failed_operations   → cắt
> 4. current_content của MODIFY invalid      → KHÔNG BAO GIỜ
> ```
> 
> ## Vấn đề phụ: `transcript` array trong RAM
> 
> `round-controller.js:9` — `transcript` khác `transcriptBlocks`. Nó giữ **full payload** trong memory:
> 
> ```js
> transcript.push({ type: "request", round: roundNumber, request_id: envelope.request_id, payload: envelope.payload });
> ```
> 
> (`round-controller.js:234`)
> 
> Không gửi cho Agent, không persist. Với R4, R5 nó phình theo mỗi round vì payload chứa full file content. Đây là memory leak tiềm ẩn khi repair chain dài — nội dung đó đã nằm trong Protocol Storage, giữ bản thứ hai trong RAM là trùng lặp. Nên giới hạn hoặc bỏ.
> 
> ## Thứ tự triển khai
> 
> ```text
> 1. appendTranscriptBlock cho round 3 + round repair        ← làm ngay, độc lập
> 2. dedup key → request_id; in_window bất biến; field mới   ← làm ngay
> 3. làm giàu response_summary + outcome                     ← làm ngay
>    --- chờ tool xong ---
> 4. nối toolRegistry: production-runtime → round-controller → payload
> 5. nới sender-worker.js:33 cho code_provide
> 6. đổi adapter nhận messages[] thay vì tự buildMessages
> 7. thêm tool loop + turn budget + audit trong Sender Worker
> 8. rút gọn R4 payload sang mô hình push-fact / pull-content
> ```
> 
> Bước 8 phải làm sau cùng. Rút gọn payload trước khi có loop thì Agent không có ký ức **và** không có content — hỏng cả hai đường.
> 
> Hai mô hình không loại nhau: push là fallback an toàn khi chưa có loop, pull là tối ưu khi loop đã chạy.
> 
> ## Kiểm chứng
> 
> Tầng 1 (không cần tool):
> 
> 1. Chạy một task qua `backend/scripts/start-control-api.mjs`, để pipeline đi hết R1 → R2 → R3.
> 2. Đọc `task/{task_id}/round_3/request` trong Protocol Storage, kiểm tra `payload.transcript_blocks` chứa đủ `round-1`, `round-2` (hiện tại thiếu `round-2` ở một số nhánh lặp và **không bao giờ** có `round-3`).
> 3. Sau khi sửa, R4 (khi repair round có) phải chứa `round-1` .. `round-3`, mỗi block có `request_id`, `round_kind`, `closed_at`, `response_summary` không phải chỉ là type thô.
> 4. Kiểm tra block cũ **bất biến** giữa hai request liên tiếp (diff JSON) — điều kiện prompt cache hit.
> 5. Test hiện có không được vỡ: `node --test backend/tests/tools/*.test.js` (bốn tool có test riêng) và `node --test backend/tests/unit/stage1-fixture.test.js`.
> 
> Tầng 2 (khi tool xong): chạy lại các script Tool Lab có sẵn để xác nhận registry đủ 4 tool —
> `backend/scripts/test-read-transcript-tool.mjs`, `test-search-code-tool.mjs`, `test-read-code-tool.mjs`, `test-select-code-graph-candidates-tool.mjs`.
> 
> ## Ghi chú phạm vi
> 
> Tài liệu này không kèm thay đổi code nào ngoài `round-controller.js` ở Tầng 1. Việc nối tool vào Supervisor bị hoãn tới khi tool xây xong, theo đúng chỉ đạo hiện tại.
> 