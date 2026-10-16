// Explains planning failures without asking owners to reload when Architecture must repair repository discovery.

// Offers session refresh only for stale choices, keeping discovery and generation retries on the existing owner decisions.
export function architectureClarificationError(error) {
  const code = error?.code ?? error?.error_code;
  if (code === "DISCOVERY_INCOMPLETE") return { message: "Architecture chưa hoàn tất khảo sát mã nguồn hoặc chưa ghi đủ dẫn chứng và phần giả định/chưa kiểm chứng. Lựa chọn đã lưu vẫn được giữ; dùng nút Thử tạo plan lại để Architecture khảo sát lại. Tải lại trang không sửa được lỗi này.", reload: false };
  if (code === "ARCHITECTURE_SESSION_STALE") return { message: "Lựa chọn trên màn hình đã cũ. Cập nhật lựa chọn mới nhất trước khi tiếp tục; phần nháp chưa lưu sẽ được thay thế.", reload: true };
  if (["ARCHITECTURE_SOURCE_CHANGED", "ARCHITECTURE_SOURCE_MISSING"].includes(code)) return { message: "Nguồn lập plan đã thay đổi hoặc không còn khả dụng. Kiểm tra nguồn rồi dùng Phân tích lại nguồn; không tạo plan từ lựa chọn cũ.", reload: false };
  return { message: error?.message ?? "Chưa tạo được plan. Lựa chọn đã lưu vẫn được giữ; có thể thử tạo plan lại.", reload: false };
}
