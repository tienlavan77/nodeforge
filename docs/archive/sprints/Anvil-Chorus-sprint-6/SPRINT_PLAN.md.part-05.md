<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
| NF-075 thêm Command/Event mới — nếu đặt tên tuỳ tiện, lặp lỗi đã sửa ở NF-047b | Domain/casing không nhất quán, phải sửa lại sau | Chốt tên trước khi code, theo đúng domain đã có (`sprints.*`), không tự đặt |
| State-machine executor (NF-071) bị hard-code ngầm theo tên state cụ thể dù không cố ý | Vi phạm nguyên tắc STRUCTURE.md, đổi workflow file không hoạt động đúng | Test bắt buộc: đổi tên state trong file rồi chạy lại, không sửa code, vẫn phải đúng |

### Exit criteria

- [ ] NF-076: 1 task chạy hết vòng Builder → Test → Reviewer → Approve qua workflow thật
- [ ] Mọi transition được kiểm tra rule trước khi ghi `state.json` (không phải `status.json`)
- [ ] NF-077 tổng hợp: toàn bộ gate xanh

---

## Sprint 7 — Events & History

**Mục tiêu:** audit trail đầy đủ + project memory nén dần theo thời gian (mục 50).

| Việc | Thư mục | Ghi chú |
|---|---|---|
| Event publication, idempotency, subscriptions | `src/modules/events/` | |
| Audit history, summaries, retention | `src/modules/history/` | Raw History → Event Store → Task Summary → Project Memory |

**Exit:** task sau chỉ nhận facts liên quan từ Project Memory, không cần gửi toàn bộ lịch sử cũ.

---

## Sprint 8 — Transport & tích hợp end-to-end

**Mục tiêu:** nối toàn bộ pipeline qua API/WebSocket/CLI thật, không còn mock.

| Việc | Thư mục | Ghi chú |
|---|---|---|
| HTTP/API, WebSocket/SSE, CLI adapters | `src/transport/` | expose state/stream, không phải source of truth |
| Điều phối Builder/Reviewer thật | `src/application/` | use case layer, không biết transport/storage detail |

**Exit:** chạy full loop trên 1 project thật: sửa file → watcher → index → test →
review → approve, xem được trên UI/CLI theo thời gian thực.

---

## Sprint 9 — Hardening: Failure & Recovery

**Mục tiêu:** mục cuối trong "5 thứ cần chốt" — crash, timeout, cancel, retry, concurrent edits;
đồng thời xác nhận multi-project isolation dưới tải thật.

| Việc | Ghi chú |
|---|---|
| Timeout/cancel/retry cho Agent process | mất kết nối Agent giữa chừng không được làm hỏng state |
| Concurrent edits | 2 nguồn ghi cùng file (Agent + human) trong lúc Node đang index |
| Index rebuild tự động khi inconsistent | mục 13 |
| Multi-project load test | mỗi project state độc lập dưới tải đồng thời (mục 57) |

**Exit:** chaos test (kill Agent process giữa task, sửa file ngoài luồng trong lúc index) không
làm Node crash hoặc để lại state rác trong `.forge/`.

---

## Những thứ để sau (theo mục 59 ARCHITECTURE)

Không đưa vào roadmap Sprint 0–9: UI phức tạp, nhiều loại Agent, tối ưu theo provider cụ thể,
advanced memory, visualization nâng cao, distributed deployment.

---

## Bảng phụ thuộc nhanh

```
Sprint 0 (Schema/Bootstrap)
   └─▶ Sprint 1 (Watcher/Index)
          └─▶ Sprint 2 (Project State/Session)
                 └─▶ Sprint 3 (Agent Protocol)
                        └─▶ Sprint 4 (Verification)
                               └─▶ Sprint 5 (Rule/Context Engine)
                                      └─▶ Sprint 6 (Workflow Engine)
                                             └─▶ Sprint 7 (Events/History)
                                                    └─▶ Sprint 8 (Transport/E2E)
                                                           └─▶ Sprint 9 (Hardening)
```
