Đã ghi nhận, chưa code.

  Work list cho 0a-4 theo hướng (a):

  1. Tạo đủ 6 payload schema Agent → Node: done
      - agent-code-needed.schema.json
      - agent-code-response.schema.json
      - agent-usage-needed.schema.json
      - agent-no-wiring-needed.schema.json
      - agent-completed.schema.json
      - agent-continue.schema.json

  2. Tạo registry ánh xạ theo role:type: done

     agent:code_needed
     agent:submit_code_response
     agent:usage_needed
     agent:no_wiring_needed
     agent:completed
     agent:continue

  3. Xây hàm validator dùng chung: done 

     validateEnvelope(envelope, options?)

     Giai đoạn này options.state là tùy chọn, chưa bắt buộc.

  4. Tầng validate thứ nhất: done
      - Kiểm tra envelope shape.
      - Kiểm tra UUID/date-time/type/role/payload.

  5. Tầng validate thứ hai: done
      - Dùng role + type chọn payload schema.
      - Báo lỗi riêng nếu type không hỗ trợ hoặc role không được gửi type đó.
      - Validate payload theo schema đã chọn.

  6. Chưa làm state-machine validation trong 0a-4. 
      - Sau khi hoàn thành 1d, bổ sung options.state.
      - Dùng lại validateEnvelope, không tạo hàm validator thứ hai.

  7. Viết test: 
      - Envelope hợp lệ.
      - Payload hợp lệ.
      - Sai payload.
      - Sai role/type.
      - Thiếu nhánh no_wiring_needed phải bị phát hiện nếu registry chưa đăng ký.
      - State validation chỉ bật khi truyền options.state.

  Mình đã chỉ cập nhật phần ghi chú/work list trong kế hoạch, chưa triển khai schema, registry, validator hay
  test.

  trước 0B
   1. atomicCreate/atomicWrite: Chưa có. đã có done
  2. Temp + link(temp, destination): Chưa có; File Service vẫn fsWriteFile() trực tiếp. -> đã có done
  3. EEXIST no-overwrite: Chưa có. done
  4. Quyền .forge/runtime: Đã mở một phần, nhưng đang mở toàn bộ .forge/runtime/**, chưa tách riêng protocol-
     storage khỏi runtime khác.

  5. Execution handlers qua File Service: Chưa; nhiều handler vẫn gọi trực tiếp fs.writeFile().
  6. Queue/lock đa process: Chưa đủ; hiện chỉ có queue trong một File Service instance.
  7. Test race/no-overwrite/crash cleanup: Chưa có.


  Có thể code để xử lý, nhưng nên làm theo từng nhóm để không phá runtime hiện tại.

  Thứ tự an toàn:

  1. Mở rộng File Service:
      - atomicCreate
      - atomicWrite
      - appendFile
      - createLock
      - runtime-specific path policy

  2. Chuyển các writer text/JSON:
      - nf/conversations/*.jsonl
      - project.log
      - workflow state
      - project registry
      - agent config
      - protocol storage

  3. Chuyển execution handlers:
      - full-file
      - unified diff
      - apply patch
      - structured patch
      - search/replace
      - backup

  4. Giữ riêng các loại không nên dùng source File Service:
      - SQLite/WAL/SHM: do SQLite tự quản lý.
      - lock PID/process: dùng capability lock riêng trong cùng hạ tầng.
      - secrets: dùng capability secret riêng.
      - node_modules/.bin: maintenance service riêng.

  5. Thêm test:
      - atomic publish.
      - EEXIST no-overwrite.
      - concurrent writes.
      - append offset/length.
      - lock contention.
      - secret/runtime path isolation.
      - crash/temp cleanup.

  Điểm cần giữ nguyên:

  Watcher vẫn ignore .forge/**
  Agent File Service không được ghi toàn bộ .forge
  Runtime capability chỉ được ghi các path được cấp quyền

  Có thể triển khai toàn bộ, nhưng không nên gom thành một patch duy nhất quá lớn. Phần hiện đã code mục 1–3 của
  atomic File Service; bước tiếp theo hợp lý là bổ sung appendFile và chuyển agent-communication-store cùng
  project-log-service, vì đây là hai đường ghi runtime quan trọng nhất.