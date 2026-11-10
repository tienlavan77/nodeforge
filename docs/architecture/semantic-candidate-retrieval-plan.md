# Kế hoạch Triển khai: Hệ thống Tìm kiếm Candidate Ngữ nghĩa (Bản cập nhật theo SE Critique)

## 1. Mục tiêu
Triển khai Phase 1: **Tự động hóa Biên lai (Receipt) & Đồng bộ Evidence**. Tập trung vào việc "khép kín" dữ liệu mà không làm thay đổi các logic cốt lõi đã vận hành đúng (`matched_symbols`, `AC/Guardrails`).

## 2. Ticket triển khai (Tinh giản theo SE Critique)

### Ticket 1: Tích hợp Sync Evidence vào `select-code-graph-candidates`
- **Mục tiêu:** Đảm bảo metadata được tự động đăng ký sau khi tool trả về candidate.
- **Công việc:**
  - Import `recordSourceMetadata`.
  - Tích hợp logic gọi `recordSourceMetadata` cho các file trong `selected` candidates.
  - Đồng bộ `active_file_checksums` vào `context`.
  - **Lưu ý:** Giữ nguyên logic trả về `matched_symbols` hiện có, chỉ bổ sung đăng ký receipt.

### Ticket 2: Chiến lược Kiểm chứng & Bền vững (Durability & Verification)
- **Mục tiêu:** Đảm bảo hệ thống an toàn khi Sync Evidence.
- **Công việc:**
  - Viết `try-catch` cho các lệnh gọi `recordSourceMetadata`.
  - Tạo tệp biên lai kiểm chứng (Durable Verification Artifact) tại `.forge/runtime/nf/verification/`.

## 3. Quy trình thực thi
1. **SE thực hiện:** Triển khai Ticket 1 & 2.
2. **AM review:** Kiểm tra evidence sau mỗi Ticket.
3. **RV nghiệm thu:** Xác minh biên lai (receipts) xuất hiện trong context sau khi gọi tool.

## 4. Trạng thái kế hoạch
- [ ] Ticket 1: Sync Evidence
- [ ] Ticket 2: Durability & Verification
