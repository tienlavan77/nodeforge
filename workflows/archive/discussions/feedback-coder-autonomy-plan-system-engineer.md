<!-- Phản biện System Engineer cho plan Coder autonomy, dùng để trao đổi thống nhất với AM. -->
# Phản biện của System Engineer: Plan "Coder tự quyết cách làm, nghiệm thu bằng hành vi"

Trạng thái: tài liệu phản biện để owner trao đổi với AM; chưa phải Sprint Plan, chưa cấp quyền RUN/dispatch, không sửa plan gốc.

Phạm vi phản biện: `workflows/plan-coder-autonomy-behavior-verification.md` (gồm cả Phụ lục discovery autonomy). Mọi nhận định dưới đây đã đối chiếu code/rule/prompt thực tế; line number ghi theo bản hiện hành trên branch `ui-chat`.

## 0. Bối cảnh: bốn nguyên tắc owner đặt ra

1. Forge là nơi **cung cấp công cụ** cho agent.
2. Forge là **người gác cổng containment**, không để agent vượt quá thư mục chỉ định của một dự án.
3. Forge **đứng ngoài điều phối**, không nhúng sâu vào việc làm giữa các agent (không quy định phương pháp).
4. Coder được **tự do tư duy, chọn phương án** để hoàn tất ticket.

Mục tiêu plan với AM: gỡ các nút thắt biến (3)+(4) thành vi phạm, tức nơi prompt/schema/rule chỉ huy *cách làm* thay vì chỉ chặn *vượt quyền*. Phần phản biện này lọc đúng ranh giới: bỏ ràng buộc kiểu "phương pháp", giữ ràng buộc kiểu "biên giới".

## 1. Đồng ý với hướng của plan (xác nhận bằng code)

- Plan tách đúng outcome/contract/guardrail (bắt buộc) khỏi guidance (Coder tự quyết); giữ nguyên gate manifest/budget/checksum/independent review/exact-revision evidence; không cho Coder hạ AC. Đây là khung đúng.
- Phụ lục "nới discovery autonomy" khớp với nguyên tắc (3)+(4): hạ cap theo loại và deadline ép-edit thành cảnh báo, giữ cap tổng. Tôi xác nhận các hard-throw này có thật trong runtime (mục 2).
- `discoveryNotice` đã có sẵn hạ tầng để trả cảnh báo mà không cần throw (`backend/src/tools/exploration-state.js` dòng 132–171: `by_type`, `remaining`, `edit_must_start_by`, `suggested_next_action`). Nên hướng "cap thành notice" là khả thi, không phải viết lại gate.

## 2. Nút thắt THẬT ở runtime — đề xuất AM cho vào phạm vi sửa

Tất cả nằm trong `backend/src/tools/exploration-state.js`, hiện là `ConfigurationError` **hard-throw** — Forge cắt ngang hành vi khám phá của Coder giữa chừng:

| Chokepoint | Dòng | Loại | Vi phạm | Đề xuất |
| --- | --- | --- | --- | --- |
| `TARGET_KNOWN_SKIP_CANDIDATES` | 85–86 | ép phương pháp | Cấm dùng candidate discovery vì ticket có target — Forge quyết định *cách* tìm code, không phải biên giới an toàn. | Hạ thành hint trong `discoveryNotice`. |
| `EXPLORATION_TYPE_BUDGET_EXHAUSTED` (candidate/search/read) | 105–108 | ép phương pháp | Chặn theo *loại tool* khi Coder vẫn còn tổng budget — ép đổi cách làm. | Hạ thành cảnh báo per-type. |
| `EXPLORATION_PREEDIT_DEADLINE` | 111–113 | ép phương pháp | Ép edit trước khi hết budget qua `edit_must_start_by`. Vi phạm nặng (3)+(4). | Đặt `edit_must_start_by = null`, hoặc không thấp hơn trần tổng (theo Phụ lục O2). |
| `EXPLORATION_STAGNANT` | 217–220 | một phần hợp lệ | Chặn vòng lặp vô ích là đúng, nhưng hard-throw vẫn là can thiệp vào cách làm. | Thành cảnh báo; giữ counter vô ích làm thông tin. |

Phải GIỮ đúng vai gác cổng (2):
- `EXPLORATION_BUDGET_EXHAUSTED` tổng (dòng 119–125) + escalation một lần: là giới hạn tài nguyên, không phải phương pháp.
- `allowed_file_paths` / root containment / mutable-file budget / tool authorization / security / contract / verification / commit-before-report / independent review / exact evidence: không được nới.

## 3. Nút thắt ở PROMPT — khuếch đại runtime throw, cần hạ thành advisory

File `backend/src/modules/supervisor/nodeforge-task-prompts.js`. Hai builder nhồi cùng tư duy ép-phương-pháp vào lời dặn:

- `buildCodexTicketPrompt` dòng 44: "The next action ... is edit_diff or write_diff; do not spend the full budget ... start editing promptly."
- `buildToolTicketPrompt` dòng 139: "start editing before it reaches 0."

Khi đi kèm hard-throw mục 2, text này biến thành quy trình bắt buộc trên thực tế. Theo (3), prompt chỉ nên nêu ngân sách để Coder tự cân nhắc, không chỉ huy bước đi. Đề xuất: đổi thành advisory và **đồng nhất cả hai nhánh** để regeneration/repair không kéo lại checklist (đúng §3.2 của plan).

Không phải nút thắt, giữ nguyên: `CODER_AUTONOMY_PROMPT` (dòng 34/130) và "choose the files yourself / No file is a mandatory target merely because it was found first" (dòng 20/116). Mâu thuẫn nằm ở dòng budget-discipline + runtime throw, không ở phần autonomy.

## 4. SCHEMA / RULE: không có nút thắt, và plan đang citing evidence lỗi thời

- **Schema không khóa phương pháp:** `schemas/governance/ticket.schema.json` giữ AC là array chuỗi + verification coverage; không có field ép thuật toán/helper. => Không cần đổi schema. Việc nới quyền Coder **không đụng contract**. (Phù hợp mặc định §3.2 của plan.)
- **Rulebook đã nhất quán, evidence §4 của plan bị sai.** Plan dòng 77 ghi "Architecture §6 **còn** ghi trần bốn mutable files"; §6 risk row ghi "Hai rulebook **không thống nhất** file cap". Nhưng bản hiện hành **cả hai đã bỏ trần 4 file**:
  - `workflows/agents/architecture/README.md:134`: "...mutable-file budget nguyên dương phù hợp công việc; **không áp trần bốn file toàn cục**."
  - `workflows/agents/sprint-leader/README.md:67,69`: "without a global maximum... **there is no global four-file cap**."

  => Không còn mâu thuẫn để gỡ. Nếu giữ nguyên, plan sẽ chỉ đạo SL/Coder "sửa" một xung đột không tồn tại — chính là loại nút thắt giả plan muốn loại. Đề xuất cho AM:
  1. Cập nhật entry §4 và risk row §6: ghi "đã reconcile tại README revision này" + lưu checksum/revision.
  2. Hoặc chuyển thành **regression guard** (test rằng không admission path nào còn trần bốn) thay vì mô tả như xung đột đang mở.

## 5. Nguyên tắc phân lớp đề xuất chuẩn hóa (liên quan trực tiếp (3))

Nút thắt sâu nhất không phải con số cap mà là **mô hình**: Forge đang dùng `ConfigurationError` (throw) cho ràng buộc *phương pháp*. Theo (3), mọi giới hạn về "cách khám phá" nên là **tín hiệu trong kết quả tool (notice/hint)**; **throw chỉ dành cho vi phạm biên giới (2)**. Đề xuất ghi thành chuẩn phân lớp ngay trong plan để về sau không có cap kiểu "phương pháp" bị nhét lại vào runtime throw.

## 6. Điểm cần revalidate trước khi chốt (giữ đúng tinh thần evidence-driven của plan)

- §4 tự thừa nhận mới khảo sát một phần; các entrypoint `ticket-sprint-leader.js`, `ticket-crud-service.js`, `plan-handoff-service.js`, `review-worker.js` chưa đọc đầy đủ. Nâng "truy vết production governed vs legacy" lên thành **điều kiện chặn cho O3**: `assertReportScope` chỉ chạy khi `!governed` (dòng 30–58/§4, §6), nên không được mặc định nó là nguyên nhân production. Không tái hiện được trường hợp bị chặn sai qua entrypoint thật thì ghi "chưa có căn cứ sửa", không sửa gate suy đoán.
- Agent behavioral evaluation (O4) phải chốt ngân sách run + giới hạn **ngay trong plan** (provider/model, số run, pass/fail, cách tách lỗi hệ thống/tool/provider với biến thiên hành vi), vì đây là phần đắt và dễ tái sinh checklist vô cớ mà plan đang muốn bỏ. Hai hàm cùng pass unit test không đủ O4.
- Rollout: phần Phụ lục (mở discovery autonomy) nên rollout **sau** khi semantics chính (rule/prompt/runtime binding) đã chứng minh bind được qua repair/resume; không mở quyền trong lúc chưa chứng minh semantics đã bind. Drain phải tính cả checkpoint còn quyền Resume, không chỉ process đang chạy (đúng §3.3).

## 7. Kết luận cho buổi trao đổi với AM

Đồng ý khung plan và Phụ lục. Hai việc cần chốt với AM trước khi approve:
1. **Sửa evidence file-budget ở §4 và risk row §6** vì rulebook đã nhất trí bỏ trần bốn file (mục 4). Nếu không, O1/§6 sẽ bắt giải quyết một xung đột không tồn tại.
2. **Nâng "truy vết production vs legacy" thành gate cứng cho O3** và chuẩn hóa nguyên tắc phân lớp "notice cho phương pháp, throw cho biên giới" (mục 5–6).

Phạm vi sửa dự kiến khi được duyệt (chỉ nêu để AM cân nhắc, chưa thực hiện): hạ `TARGET_KNOWN_SKIP_CANDIDATES`, per-type cap, `EXPLORATION_PREEDIT_DEADLINE` thành notice/hint trong `exploration-state.js`; giữ hard-throw cho tổng budget và containment; làm mềm dòng budget-discipline trong hai prompt builder cho đồng nhất; cập nhật §4/§6 và thêm regression guard cho file budget.

Lưu ý minh bạch: phản biện này dựa trên **đọc file + grep**, chưa phải runtime verification; tôi chưa chạy test trong phiên này và **chưa sửa file plan gốc** (file đang ở trạng thái modified — giữ nguyên để tránh đè thay đổi chưa liên quan).
