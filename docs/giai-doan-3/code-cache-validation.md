<!-- Ghi lại bằng chứng nghiệm thu Code Cache và các lỗi nền còn cần người phụ trách xử lý. -->
# Kiểm tra Code Cache, 2026-09-27

## Kết quả tái lập

Chạy từ root `/home/data/sites/nodeforge`:

| Lệnh | Kết quả |
|---|---|
| `node --test backend/tests/tools/rg-search.test.js backend/tests/integration/code-cache-watcher-http.test.js backend/tests/integration/code-cache-watcher-real-cases.test.js backend/tests/integration/wf003-builder-evidence.test.js` | 18/18 pass |
| `pnpm typecheck` | pass |
| `pnpm validate:schemas` | pass, 97 schema và 91 fixture |
| `node node_modules/eslint/bin/eslint.js --rulesdir eslint-rules backend/src/tools/rg-search.js backend/tests/tools/rg-search.test.js backend/tests/fixtures/cache-control-process.mjs backend/tests/fixtures/cache-watcher-process.mjs backend/tests/integration/code-cache-watcher-http.test.js backend/tests/integration/code-cache-watcher-real-cases.test.js backend/tests/integration/wf003-builder-evidence.test.js backend/scripts/validate-schemas.mjs --max-warnings=0` | pass |
| `git diff --check` | pass |
| `pnpm lint` | fail, 44 lỗi ngoài các file được kiểm tra ở hàng lint trên; log đầy đủ tại `code-cache-lint.log` |

`rg_search` so kết quả cache với ripgrep native trên nhiều file, `-i`, `-n`, `-F`, `-w`, `--max-count`, type/glob, không kết quả và regex sai. Flag context/output như `--context` hiện không thuộc contract được hỗ trợ; input bị từ chối. Test race sau `rg --files` xác nhận file thay đổi được đọc qua File Service và file đã xóa được bỏ qua, không có fallback đọc source trực tiếp bằng ripgrep. Cache hit trước watcher event vẫn theo freshness contract hiện hành của Code Cache.

NF-CACHE-007 chạy Control API, watcher và incremental indexer ở các process riêng. Test ghi file lần hai sau marker `pre-index` trong lúc indexer bị trì hoãn 500 ms; kiểm tra kết quả cuối sau khi hai event ổn định: nội dung mới nhất, checksum cache và checksum event khớp, cache hit, trạng thái refresh và một entry. Test khác kiểm tra rename/delete, checksum mismatch và project ID khác. Child process được dừng trong `finally`, có SIGKILL sau 3 giây nếu không dừng; thư mục tạm được xóa cả khi assertion/timeout lỗi. Control fixture ghi kết quả bằng rename nguyên tử để tránh JSON đọc dở.

## Lỗi lint còn lại

Log đầy đủ: `docs/giai-doan-3/code-cache-lint.log`. 44 lỗi nằm ở các file khác phần cache/`rg_search` và các fixture/schema vừa sửa. `code-search.js` có hai biến chưa dùng đã có trong HEAD; `start-control-api.mjs` có các lỗi từ thay đổi đang làm dở của worktree. Các nhóm còn lại: script hỗ trợ, application/supervisor, parser và test/eval. Không sửa các phần này trong NF-CACHE để tránh đổi phạm vi.

Theo dõi đề xuất: `NF-LINT-BASELINE` (chưa tạo ticket chính thức); owner đề xuất: người phụ trách chất lượng backend của dự án (chưa được chỉ định). Cần gán owner và ticket trước khi dùng lint toàn repo làm cổng nghiệm thu.
