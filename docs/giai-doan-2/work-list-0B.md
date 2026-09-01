 Work list cho 0b — Protocol Storage:

  1. Tạo module protocol-storage.js -> done
      - API:

        createProtocolStorage({ fileService, root = ".forge/runtime/protocol-storage" })

      - Public:

        save(ref, data)
        get(ref)
        exists(ref)

      - Không gọi trực tiếp fs.writeFile, rename, link; mọi ghi qua File Service.

  2. Chuẩn hóa và kiểm tra ref   -> done
      - Chỉ nhận logical ref tương đối:

        task/<task_id>/round_<n>/request
        task/<task_id>/round_<n>/response

      - Chặn absolute path, .., null byte, backslash traversal, ký tự ngoài allowlist.
      - Luôn resolve bên dưới:

        .forge/runtime/protocol-storage/

  3. Stable JSON serialization     -> done
      - Recursively sort object keys.
      - Giữ nguyên thứ tự array.
      - UTF-8, kết thúc newline.
      - Từ chối circular/unsupported values.
      - Cùng dữ liệu phải tạo cùng bytes.

  4. Checksum    -> done
      - SHA-256 trên chính bytes được lưu.
      - Lưu metadata cạnh data:

        request.json
        request.meta.json

      - Metadata gồm:

        {
          "ref": "...",
          "sha256": "...",
          "bytes": 1234,
          "created_at": "...",
          "schema_id": "..."
        }

  5. save(ref, data)   -> done
      - Serialize stable.
      - Tính checksum.
      - Gọi fileService.atomicCreate() cho data.
      - Gọi fileService.atomicCreate() cho metadata.
      - Không overwrite.
      - Nếu ref đã tồn tại:
          - cùng checksum → idempotent, trả record hiện có;
          - checksum khác → STORAGE_CONFLICT.

      - Nếu ghi data thành công nhưng metadata lỗi, phải báo lỗi và cleanup/recovery rõ ràng.

  6. get(ref)  -> done
      - Đọc data và metadata qua File Service.
      - Tính lại checksum.
      - Nếu metadata thiếu → STORAGE_METADATA_MISSING.
      - Nếu checksum lệch → STORAGE_CHECKSUM_MISMATCH.
      - Nếu ref không tồn tại → STORAGE_NOT_FOUND.
      - Parse JSON rồi trả object.

  7. exists(ref)
      - Chỉ kiểm tra thông qua File Service/read capability.
      - Không lộ đường dẫn vật lý.
      - Phân biệt missing data và missing metadata.

  8. Metadata schema
      - Tạo schemas/agent/protocol-storage-metadata.schema.json.
      - Validate ref, sha256, bytes, created_at.
      - Không cho metadata tùy ý.

  9. Test bắt buộc
      - Save/get object.
      - Stable serialization khác thứ tự key nhưng cùng checksum.
      - Array order vẫn được giữ.
      - Missing ref.
      - Invalid traversal ref.
      - Null byte/backslash ref.
      - Save trùng ref cùng dữ liệu → idempotent.
      - Save trùng ref khác dữ liệu → STORAGE_CONFLICT.
      - Metadata bị sửa → checksum mismatch.
      - Metadata bị xóa → metadata missing.
      - Data bị sửa → checksum mismatch.
      - Atomic temp file không còn sau save.
      - Concurrent save cùng ref.
      - Concurrent save khác ref.
      - Data ghi được nhưng metadata fail.
      - File Service bắt buộc; không có service thì fail lúc khởi tạo.

  10. Tích hợp với envelope/transcript
      - full_request_ref và full_response_ref trỏ đúng ref.
      - Lưu nguyên envelope + payload, không chỉ payload.
      - parent_id, request_id, type, role, timestamp được giữ nguyên.
      - Protocol Storage không ghi event log và không đưa dữ liệu vào Code Index.

  11. Config
      - Mặc định:

        .forge/runtime/protocol-storage

      - Cho phép cấu hình qua:

        FORGE_PROTOCOL_STORAGE_ROOT

      - Nếu cấu hình là relative path, resolve theo project root.
      - Không cho root vượt ra ngoài project root.

  12. Verification/gate
      - Unit tests Protocol Storage.
      - File Service tests.
      - pnpm --dir backend lint.
      - pnpm --dir backend typecheck.
      - git diff --check.
      - Sau khi pass mới cập nhật 0b thành hoàn tất.

  Phân biệt rõ:

  Code Index
    -> path/symbol/import/line range

  Protocol Storage
    -> full request/response/transcript + checksum

  Event Log
    -> event vận hành, trạng thái, lỗi, thời gian