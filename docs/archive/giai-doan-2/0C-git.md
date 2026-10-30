 Các yêu cầu chính:

  1. createBranch("task/FORGE-VALIDATE-006")
      - Kiểm tra tên branch an toàn.
      - Không ghi đè branch đã tồn tại.
      - Trả branch name và commit base.

  2. commit(message, { paths })
      - Chỉ git add đúng các path được phép.
      - Kiểm tra git status.
      - Không tạo commit rỗng.
      - Trả commit SHA.

  3. merge(branch)
      - Merge vào branch hiện tại.
      - Phát hiện conflict rõ ràng.
      - Không tự động bỏ qua conflict.

  4. discardBranch(name)
      - Xóa branch task sau khi đã xác nhận.
      - Không cho xóa branch hiện tại hoặc protected branch như main.

  5. Mọi lệnh:
      - Chạy qua một executor duy nhất.
      - Có timeout.
      - Ghi event git.status, git.add, git.commit, git.merge, git.branch.
      - Không dùng shell string ghép trực tiếp để tránh injection.

  Trạng thái hiện tại:

  - start-control-api.mjs đang gọi git status, git add, git commit trực tiếp qua execFile.
  - Chưa có module Git wrapper riêng.
  - 1c chưa thể dùng branch riêng đúng kiến trúc cho đến khi 0c được triển khai.

  File nên tạo:

  backend/src/infrastructure/git/git-service.js
  backend/tests/unit/git-service.test.js

  Sau 0c, bước 1c sẽ nối createBranch("task/<ticket_id>") trước lần patch đầu tiên.

  Tổng kết 0c:

  Đã triển khai:

  - 0c.1: tạo Git Service wrapper tại backend/src/infrastructure/git/git-service.js.
  - 0c.2: hỗ trợ commit an toàn:
      - Chỉ stage explicit paths.
      - Kiểm tra staged files.
      - Chặn commit rỗng.
      - Trả commit SHA.

  - 0c.3: hoàn thiện:
      - createBranch
      - merge
      - discardBranch
      - Kiểm tra branch tồn tại, self-merge, protected/current branch.

  - 0c.4: thêm audit events:
      - git.status
      - git.add
      - git.commit
      - git.merge
      - git.branch

  - 0c.5: nối Git Service vào flow commit ticket của Control API; event vẫn phát lên stream và project log.

  Verification:

  - Git Service tests pass.
  - Backend lint pass.
  - Backend typecheck pass.
  - git diff --check pass.

  Trạng thái hiện tại trong implementation plan: ◐ Một phần.

  Còn lại:

  - Nối createBranch("task/<ticket_id>") vào orchestration trước patch — thuộc bước 1c.
  - Nối đầy đủ merge/discard vào lifecycle ticket.
  - Bổ sung xử lý lỗi executor Git theo exit code cho các lệnh native như merge conflict.
  - Có thể bỏ dần helper runGitLogged cũ sau khi toàn bộ Git flow chuyển sang service.