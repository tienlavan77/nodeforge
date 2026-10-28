<!--
Mục đích nghiệp vụ: Tài liệu hướng dẫn và đối chiếu chuẩn hóa khung kế hoạch kiến trúc theo định hướng JSON-first (architecture_manager.architecture_plan.v1) dành cho Owner, Architecture Manager, System Engineer và Sprint Leader. Tài liệu giúp đồng bộ hóa mẫu kế hoạch theo kết quả đầu ra (outcomes) trong workflows/agents/architecture/README.md với hợp đồng kiểm tra dữ liệu thực tế của hệ thống, đảm bảo mọi bản kế hoạch tạo từ hội thoại đều hợp lệ ngay từ lần đầu mà không làm thay đổi ranh giới phân quyền giữa Architecture Manager và Sprint Leader.
Mô tả kỹ thuật: Ánh xạ chi tiết từng đề mục từ mẫu Markdown 7 phần truyền thống sang 10 trường dữ liệu bắt buộc của ARCHITECTURE_PLAN_JSON_SCHEMA trong backend/src/modules/governance/architecture-plan-json.js, giải thích quy trình 3 pha (Clarification Discovery, Plan Generation, và RFC 7396 JSON Merge Patch Update) trong backend/src/application/conversation-planning-service.js, đồng thời liệt kê đầy đủ các biểu thức chính quy và điều kiện kiểm tra của assertPlanSchema cùng cách thức trích xuất phụ thuộc outcome trong backend/src/modules/governance/markdown-sprint-scope.js.
-->
# Khung Architecture Plan JSON-First (`architecture_manager.architecture_plan.v1`)

Tài liệu này chuẩn hóa **Mẫu kế hoạch kiến trúc theo Outcomes (Mục 5 trong `workflows/agents/architecture/README.md`)** sang định dạng **JSON-first** khớp tuyệt đối với schema runtime trong `backend/src/modules/governance/architecture-plan-json.js` và luồng điều phối trong `backend/src/application/conversation-planning-service.js`.

---

## 1. Quy trình 3 pha JSON-First do Node điều phối

Khi tạo hoặc cập nhật Architecture Plan từ hội thoại (hoặc khi dùng schema `architecture_manager.architecture_plan.v1`), Architecture Manager (AM) **không tự trả Markdown** và **không tự lưu file plan**, mà trả đúng JSON theo từng pha:

1. **Pha 1 — Clarification Discovery (Khám phá câu hỏi cần Owner chốt)**:
   - Chỉ trả về 1 JSON object duy nhất:
     ```json
     {
       "questions": [
         {
           "id": "STORAGE_POLICY",
           "title": "Chính sách lưu trữ dữ liệu",
           "reason": "Quyết định ảnh hưởng trực tiếp tới ranh giới bảo mật và chi phí vận hành thuộc thẩm quyền Owner.",
           "options": [
             {
               "id": "LOCAL_ONLY",
               "label": "Lưu cục bộ",
               "description": "Chỉ lưu trên thiết bị người dùng, không đồng bộ lên server."
             },
             {
               "id": "SERVER_SYNC",
               "label": "Đồng bộ server",
               "description": "Lưu trên server có kiểm soát quyền truy cập."
             }
           ],
           "recommended_option_id": "LOCAL_ONLY"
         }
       ]
     }
     ```
   - Nếu không có câu hỏi thuộc thẩm quyền Owner, trả về `{"questions":[]}`.

2. **Pha 2 — Plan Generation (Tạo bản kế hoạch gốc `r1`)**:
   - Sau khi khảo sát repository bằng Forge tools và nhận các quyết định đã chốt của Owner, AM trả về **1 JSON object duy nhất** theo đúng schema `architecture_manager.architecture_plan.v1` (mục 2 bên dưới).
   - Node sẽ tự kiểm tra schema (`parseArchitecturePlanJSON`), chuẩn hóa thứ tự khóa (`canonicalizeArchitecturePlanJSON`), tính `source_sha256`, render ra Markdown 7 mục (`renderArchitecturePlanMarkdown`), đính kèm bản ghi quyết định của Owner (`appendArchitectureDecisions`) và khóa revision `r1`.

3. **Pha 3 — Plan Update (Cập nhật bản kế hoạch sang `r<n+1>`)**:
   - Khi Owner yêu cầu chỉnh sửa plan trong hội thoại, AM trả về **1 JSON object theo chuẩn RFC 7396 JSON Merge Patch** dựa trên bản JSON canonical hiện hành:
     - Chỉ gửi các trường thay đổi với giá trị mới.
     - Các trường giữ nguyên thì lược bỏ (omit).
     - **Tuyệt đối không** gán `null` cho bất kỳ trường nào trong 10 trường bắt buộc ở cấp root.

---

## 2. Mẫu JSON chuẩn theo Outcomes (Thay thế mẫu Markdown ở Mục 5 `README.md`)

Dưới đây là khung JSON chuẩn thể hiện đầy đủ tinh thần **Mẫu plan theo outcomes** của `workflows/agents/architecture/README.md`, đồng thời vượt qua 100% các chốt chặn của `assertPlanSchema` và `validateMarkdown`:

```json
{
  "title": "<Tên ngắn, định hướng kết quả (tối đa 200 ký tự)>",
  "objective": "<Vấn đề cần giải quyết, kết quả quan sát được khi hoàn thành và giá trị mang lại (tối đa 4000 ký tự)>",
  "background": "<Bối cảnh hiện trạng của hệ thống, nguyên nhân gốc rễ, kiến trúc hiện tại và lý do cần thay đổi (tối đa 8000 ký tự)>",
  "scope": [
    "In scope: <Khả năng / outcome bắt buộc cần bàn giao trong kế hoạch này>",
    "Out of scope: <Hành vi, refactor hoặc migration nằm ngoài phạm vi, không được tự ý mở rộng>"
  ],
  "outcomes": [
    {
      "id": "O1",
      "outcome": "<Kết quả bắt buộc cần giao ở cấp kiến trúc — không chia nhỏ thành từng thao tác code>",
      "acceptance_criteria": [
        "<Hành vi, hợp đồng hoặc kiểm tra quan sát được chứng minh O1 đạt yêu cầu>",
        "<Tiêu chí nghiệm thu thứ hai của O1 (nếu có)>"
      ],
      "guardrails": [
        "<Ràng buộc bắt buộc về contract / security / compatibility mà Sprint Leader và Coder không được phá vỡ>"
      ]
    },
    {
      "id": "O2",
      "outcome": "<Kết quả bắt buộc tiếp theo>",
      "acceptance_criteria": [
        "<Tiêu chí nghiệm thu kiểm chứng được của O2>"
      ],
      "guardrails": [
        "O1",
        "<Ràng buộc kiến trúc riêng của O2; ghi mã 'O1' như phần tử riêng khi O2 phụ thuộc bắt buộc vào O1>"
      ]
    }
  ],
  "evidence": [
    {
      "path": "backend/src/modules/governance/architecture-plan-json.js",
      "location": "L28-L46",
      "fact": "<Sự thật kỹ thuật đã đọc trực tiếp từ file nguồn — nêu rõ vai trò thành phần và hành vi hiện tại>"
    },
    {
      "path": "workflows/agents/architecture/README.md",
      "location": "L47-L61",
      "fact": "<Sự thật về quy tắc phân quyền giữa Architecture Manager và Sprint Leader>"
    }
  ],
  "assumptions": [
    "<Giả định chưa thể xác minh trực tiếp từ mã nguồn hoặc quyết định còn để ngỏ cho Sprint Leader trong phạm vi được ủy quyền (bắt buộc có ít nhất 1 phần tử)>"
  ],
  "constraints": [
    "<Ràng buộc bắt buộc toàn cục: public contract, dữ liệu, security, backward-compatibility cần giữ và lý do>",
    "<Hướng tiếp cận đề xuất hoặc gợi ý delivery không bắt buộc (SL có quyền chủ động phân rã ticket trong phạm vi này)>"
  ],
  "risks": [
    "[Major] <Mô tả rủi ro kỹ thuật/hợp đồng> — Tác động: <ảnh hưởng nếu xảy ra> — Xử lý: <cách giảm thiểu hoặc người chịu trách nhiệm chốt>"
  ],
  "verification": "<Chiến lược kiểm chứng cấp kế hoạch: các tiêu chí kiểm tra tự động/tích hợp mà Sprint Leader phải chứng minh đầy đủ coverage trước khi hoàn tất>"
}
```

---

## 3. Bảng ánh xạ từ Mẫu Markdown 7 mục cũ sang 10 trường JSON chuẩn

| Mục trong `README.md` (Mẫu cũ) | Trường trong JSON (`ARCHITECTURE_PLAN_JSON_SCHEMA`) | Cách Node render sang Markdown (`renderArchitecturePlanMarkdown`) | Quy tắc viết để giữ nguyên ngữ nghĩa kiến trúc |
|---|---|---|---|
| `# Plan: <tên ngắn>` | `title` (`string`, `1..200` ký tự) | `# Plan: ${plan.title}` | Ngắn gọn, định hướng kết quả, không chứa ký tự xuống dòng. |
| **1. Mục tiêu / kết quả mong đợi** (`Vấn đề`, `Kết quả`, `Giá trị`) | `objective` (`string`, `1..4000`) & `background` (`string`, `1..8000`) | `## 1. Objective` và `## 2. Background` | Đưa **Kết quả mong đợi & Giá trị** vào `objective`; đưa **Vấn đề & Bối cảnh hiện trạng** vào `background`. |
| **2. Phạm vi** (`In scope` / `Out of scope`) | `scope` (`string[]`, `1..40` phần tử, mỗi phần tử `<= 1000` ký tự) | `## 3. Scope` (danh sách bullet `- ...`) | Schema không tách trường `out_of_scope` riêng; cần ghi rõ tiền tố `"In scope: ..."` và `"Out of scope: ..."` ngay trong mảng `scope`. |
| **3. Hướng tiếp cận và guardrails** | `constraints` (`string[]`, `0..40`) & ` outcomes[].guardrails` (`string[]`, `min: 1`) | `## 4. Constraints and risks` (`- Constraint: ...`) & Cột `Guardrails` ở bảng Mục 5 | Ràng buộc toàn cục và hướng đề xuất ghi vào `constraints`. Ràng buộc gắn với từng outcome ghi vào `outcomes[].guardrails`. |
| **4. Khu vực dự kiến ảnh hưởng và evidence** | `evidence` (`object[]`, `1..60` phần tử: `{ path, fact, location? }`) | `## 7. Evidence and assumptions` (`- [Evidence: path#location] fact`) | Nêu rõ khu vực bị ảnh hưởng, vai trò và sự thật đã khảo sát trong `fact`. Các file nêu tại đây là định hướng discovery, không khóa cứng mutable-file manifest của SL. |
| **5. Outcomes và điều kiện nghiệm thu** | `outcomes` (`object[]`, `1..20` phần tử: `{ id, outcome, acceptance_criteria, guardrails }`) | `## 5. Outcomes` (`\| Outcome \| Result \| Acceptance \| Guardrails \|`) | Mỗi `id` khớp `^O[1-9][0-9]*$` (`O1`, `O2`...) và không trùng lặp. Nếu `O2` phụ thuộc bắt buộc vào `O1`, thêm chuỗi `"O1"` vào mảng `guardrails` của `O2` để `markdown-sprint-scope.js` nhận diện đúng dependency. |
| **6. Rủi ro, giả định và câu hỏi mở** | `risks` (`string[]`, `0..40`) & `assumptions` (`string[]`, `1..40`) | `## 4. Constraints and risks` (`- Risk: ...`) & `## 7. Evidence and assumptions` (`- Assumption (unverified): ...`) | Mức độ (`[Blocker]`/`[Major]`/`[Minor]`), tác động và hướng xử lý ghi trong từng phần tử của `risks`. Các giả định ghi vào `assumptions`. |
| **7. Acceptance criteria của plan** | `verification` (`string`, `1..4000` ký tự) | `## 6. Verification` + câu xác nhận `Repository discovery complete...` | Nêu rõ yêu cầu kiểm chứng cấp kế hoạch và nguyên tắc SL phải chứng minh coverage tới từng outcome trước khi dispatch. |

---

## 4. Các ràng buộc kỹ thuật bắt buộc của Validator (`assertPlanSchema`)

Để không bị Node từ chối với lỗi `ARCHITECTURE_PLAN_JSON_INVALID` (không tạo được revision), phản hồi JSON của AM phải thỏa mãn **tất cả** điều kiện sau:

1. **Đúng 10 trường cấp root, không thiếu, không thừa, không `null`**:
   - Bắt buộc có đủ: `title`, `objective`, `background`, `scope`, `outcomes`, `evidence`, `assumptions`, `constraints`, `risks`, `verification`.
   - Không được thêm bất kỳ thuộc tính lạ nào ngoài 10 trường trên (ví dụ: không thêm `plan_id`, `revision`, `out_of_scope`, `tickets`, `summary`...).
2. **Các mảng bắt buộc có ít nhất 1 phần tử (`min: 1`)**:
   - `scope`: tối thiểu 1 chuỗi không rỗng (`1..40`).
   - `outcomes`: tối thiểu 1 phần tử (`1..20`). Trong mỗi outcome, cả `acceptance_criteria` và `guardrails` đều bắt buộc có **ít nhất 1 chuỗi không rỗng** (nếu không có dependency bắt buộc, vẫn phải ghi ít nhất 1 guardrail kỹ thuật hoặc `"None — SL decides delivery within scope"`).
   - `evidence`: tối thiểu 1 phần tử (`1..60`).
   - `assumptions`: **bắt buộc tối thiểu 1 chuỗi không rỗng** (`1..40`). Ngay cả khi mọi thứ đã rõ, vẫn phải ghi rõ giả định biên (ví dụ: giả định về môi trường runtime hoặc phạm vi ủy quyền cho SL), tuyệt đối không trả `"assumptions": []`.
   - Riêng `constraints` và `risks` được phép rỗng (`[]`, `min: 0`), nhưng khuyến khích ghi rõ ràng buộc kiến trúc và rủi ro.
3. **Định dạng nghiêm ngặt của `evidence`**:
   - `path`: Chỉ chấp nhận đường dẫn tương đối nằm trong 6 thư mục nguồn: `backend/`, `schemas/`, `ui/`, `web/`, `docs/`, hoặc `workflows/` (khớp regex `^(?:backend|schemas|ui|web|docs|workflows)\/[A-Za-z0-9._/-]+$`). Không dùng đường dẫn tuyệt đối, không dẫn tới `.forge/` hay file ở thư mục gốc như `package.json`.
   - `location` (tùy chọn): Khi có mặt, **chỉ được viết tọa độ dòng tăng dần** theo mẫu `L17` hoặc `L17-L75` hoặc nhiều đoạn nối bằng dấu chấm phẩy `L17-L75; L98-L106` (khớp regex `^L([1-9][0-9]*)(?:[-–—]L?([1-9][0-9]*))?$`). Tuyệt đối không viết chữ mô tả (như `"section 5"` hay `"lines 10 to 20"`) vào `location`.
4. **Quy tắc ghi Outcome Dependency cho Sprint Leader (`markdown-sprint-scope.js`)**:
   - Khi Node render bảng Mục 5, các phần tử trong `outcomes[].guardrails` được nối bằng `"; "`.
   - Bộ đọc phạm vi Sprint (`readMarkdownSprintScope` trong `backend/src/modules/governance/markdown-sprint-scope.js`) tách cột `Guardrails` theo dấu `;` hoặc `,` và nhận diện các token khớp `^O[1-9][0-9]*$` là `mandatory_outcome_ids`.
   - Do đó, nếu `O2` phụ thuộc bắt buộc vào `O1`, hãy truyền `"O1"` thành một phần tử độc lập trong mảng `guardrails` của `O2`:
     ```json
     "guardrails": [
       "O1",
       "Giữ nguyên định dạng phản hồi của API hiện hành"
     ]
     ```

---

## 5. Mẫu RFC 7396 JSON Merge Patch khi cập nhật Plan (Pha 3)

Khi Owner yêu cầu cập nhật kế hoạch đã tạo trong hội thoại, AM chỉ trả về JSON Merge Patch chứa các trường thay đổi:

```json
{
  "objective": "<Mục tiêu đã cập nhật theo yêu cầu mới của Owner>",
  "outcomes": [
    {
      "id": "O1",
      "outcome": "<Giữ hoặc cập nhật O1>",
      "acceptance_criteria": [
        "<Tiêu chí nghiệm thu đã bổ sung>"
      ],
      "guardrails": [
        "<Guardrail của O1>"
      ]
    }
  ]
}
```

- **Lưu ý quan trọng với mảng trong RFC 7396**: Trong JSON Merge Patch, nếu gửi một trường kiểu mảng (như `outcomes`, `scope`, `evidence`), mảng mới sẽ **thay thế toàn bộ** mảng cũ của trường đó. Vì vậy, khi sửa 1 phần tử trong `outcomes`, AM phải gửi đầy đủ danh sách các phần tử `outcomes` cần giữ lại cùng với phần tử đã sửa.
