trả lời các câu hỏi
## Nhóm 1: "nó là project nào?"
1. tạo forge CLI để cài đặt project, bước này bao gồm
   a. lấy thư mục gốc
   b. tạo ID cho project
   c. nếu là project đã có code sẵn thì build index cod, graph code, thu thập cấu trúc thư mục, khảo sát dự án
2. để tránh lầm lẫn mỗi project sẽ có 1 route riêng phân biệt /:id (/:id/system, /:id/architectur, /:id/coding), route / là nơi người dùng truy cập vào các project hiện có.
3. chỉ 1 repo cho 1 project, mỗi 1 project là 1 repo riêng, thư mục riêng.

## nhóm 2: "session thuộc về ai?"
4. 1 sesstion chỉ thuộc đúng 1 project.
5. với 1 prroject là 1 route riêng thì không phải lo khái niệm project mặc định

## nhóm 3: "Mỗi project một bộ máy riêng" (runtime cô lập — phần nặng nhất)
6. watcher dùng chung, index code, graph code dựa vào id project để ghi đúng database vào thư mục tương ứng.
7. mỗi project là 1 bộ index riêng, mỗi project là 1 file database.
8. event phải gắn nhãn project.
9. mỗi project tạo 1 stream project riêng không lẫn lộn.

## nhóm 4:  "File và git phải nhốt đúng trong project" (ranh giới an toàn)
10. api control cũng chạy cùng 1 process nên cần phân biệt theo project id để ghi đúng thư mục phù hợp.
11. git là của riêng từng repo phân biệt qua project id
12. 

## Nhóm 5 — "Agent/thợ làm việc chạy cho ai?" (điều phối & tranh chấp tài nguyên)
13. agent/worker dùng chung cho tất cả các project
14. bộ nhớ phân biệt theo project id
15. thống nhất lại là project id

## Nhóm 6 — "Cấu hình & vòng đời"
16. đăng ký lúc chạy (runtime) -> tham khảo trả lời nhóm 1, 1
17. 1 prrocess 1 cổng

## Nhóm 7 — "Vận hành & xử lý sự cố"
18. đúng phải gắn thêm project Id cho mỗi log
19. đúng, đồng ý!

## Nhóm 8: "Giao diện"
20. đồng ý, tham khảo trả lời 2 nhóm 1

## Ghi chú trùng lặp

- `workflows/plan-multi-project-management.md` là bản chính của plan multi-project (sha256:53aeea37…, đã cập nhật đầy đủ quyết định owner: lifecycle manager O1, embedding worker gap, Q4, "foundation trước, CLI sau").
- File `workflows/multiproject/plan-multi-project-management.md` bị File Service từ chối tạo với lỗi CHECKSUM_MISMATCH lặp lại (không ghi được nội dung mới dù chưa tồn tại) — cần Node kiểm tra index/scope cho thư mục `workflows/multiproject/`.

