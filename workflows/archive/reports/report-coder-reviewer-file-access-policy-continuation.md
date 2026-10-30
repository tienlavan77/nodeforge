<!-- Báo cáo phần triển khai tiếp theo chỉ dẫn AM, tách bằng chứng đã kiểm tra khỏi authority và điều kiện rollout còn thiếu. -->
# SE: Tiếp tục triển khai file-access policy

**Ngày:** 2026-10-22. **Trạng thái:** triển khai một phần; **BLOCKED rollout**, chưa đạt C1–C6 đầy đủ. Không phải approval, RUN, dispatch hoặc independent review.

## 1. Baseline và authority

- Đã kiểm tra workspace trước mutation; giữ nguyên các thay đổi từ lượt trước, không reset, commit hoặc push.
- HEAD khi bắt đầu: `4ad103575fc83f00be4ef5ae94ed334f329eb3a1`. Implementation đang ở working tree, không phải toàn bộ code trong HEAD.
- Đã đọc đủ `workflows/plan-coder-reviewer-file-access-policy-continuation.md`; SHA-256 `aa4faae73da320418b75fcb122eb2ee7f4947cc01af8008c572e7b71a2a4459f`.
- Hash plan gốc và báo cáo trước khớp E2/E1 của AM: lần lượt `d0fcc50cc6a7bd3af23638b58ab875187f8e0662c4e0fdfc8264499e343a1d3b` và `d5709080470e527660c15f1263930f99f4249c31ca31ea9b0f7a7a77bafd0e08`.
- Chưa có evidence approval qua Node cho policy identity/revision/SHA. Markdown draft không cấp authority; không nối draft trực tiếp vào production composition.
- Hai quyết định §3.1 vẫn chưa được tài liệu AM chốt: nguồn phân loại governance docs và semantics thu hồi quyền đang chạy. Không tự chọn thay decision owner.
- Không kế thừa con số 108/108 thành kết quả lượt này; chỉ chạy các checks liên quan thay đổi mới.

## 2. Thay đổi thực hiện

### Đóng đường Reviewer check chưa được cô lập

- Trước lượt này, `run_review_check` recapture environment live, tạo archive với dependency links live rồi spawn command bằng environment process hiện hành. Archive, argv allowlist và hậu kiểm không ngăn subprocess/tiến trình con vượt scope.
- Đã bỏ đường thực thi đó khỏi `reviewer-forge-tools.js`; diagnostic tool trả `REVIEW_CHECK_ISOLATION_UNSUPPORTED` trước mọi capture/materialization/command.
- Các callback injection cũ không mở lại đường này. Denial được audit bằng `review.tool_call` cùng tool, task/request/agent identity và mã lỗi; không trả PASS hoặc sửa artifact verification.
- Đồng bộ description, prompt Reviewer và rulebook: unsupported khác PASS, không fallback native shell/live dependencies; check độc lập bắt buộc nhưng thiếu evidence phải ghi `request_changes`.
- Đây là đóng lỗ hổng hiện hữu, **không** được tính đạt C3/C4 hoặc thay thế việc triển khai verification hợp lệ.

### Kiểm tra snapshot trước publish/materialize/read

- `loadVerificationEnvironment` kiểm tra JSON/schema ngoài checksum: canonical relative paths, control characters, protected runtime/Git/dependency paths, checksum format, regular-file modes, duplicate và file/descendant collisions.
- Manifest có digest hợp lệ vẫn bị từ chối nếu cấu trúc/path không an toàn. Lỗi JSON nhận mã `VERIFY_ENVIRONMENT_INVALID` mà không đưa nội dung snapshot vào thông báo.
- `persistVerificationEnvironment` đối chiếu manifest identity, file count, path/mode/hash và bytes trước publish blobs.
- `materializeTicketVerification` kiểm tra cùng contract và xung đột ticket ownership trước tạo archive; environment không được thay ticket file, cha hoặc con của ticket path.
- Không thay schema artifact/approval contract. Không tuyên bố validation này xử lý TOCTOU, symlink race hoặc cô lập subprocess.

### Bằng chứng positive và negative mới

- Qua registry Reviewer thực tế, `read_lines`, `list_files`, `search_text` vẫn dùng recorded caller ngoài diff sau khi caller live bị sửa rồi xóa; cache/source fallback được cài trap và không được gọi.
- Provenance environment trong kết quả khớp binding đã persist; blob bị sửa làm read/search thất bại, không thay bằng dependency live.
- Manifest malformed nhưng hash đúng, bytes không khớp và ticket/environment collision đều bị từ chối; invalid snapshot không tạo archive hoặc publish blob.
- Test snapshot dùng fixture Node và filesystem thật, nhưng SDK provider được mô phỏng; không phải một vòng Coder → verification → Reviewer độc lập.

## 3. Inventory hiện trạng

| Role / provider / mode | Boundary và nguồn dữ liệu hiện thấy | Fresh / resume / restart; bằng chứng và giới hạn |
| --- | --- | --- |
| Coder Claude v2 | Node grant, Forge tools; native tools cấu hình `[]`; live project/cache/graph còn phụ thuộc path checks | Fresh chưa qualify production. Resume yêu cầu callback reconcile; restart chưa có issuance/migration đầy đủ. Chưa chứng minh object/race boundary. Không tuyên bố route đủ điều kiện rollout. |
| Coder Codex CLI v2 | Binding từ chối `FILE_ACCESS_PROVIDER_UNSUPPORTED` vì native filesystem routes chưa tương đương | Deny trước dispatch; không fallback. Fresh/resume/restart chưa có supported positive flow. |
| Coder OpenAI và provider khác v2 | Gateway có Forge tool definitions; executor/composition parity chưa chứng nhận | Không suy ra support từ shared definitions. Fresh/resume/restart: NOT CERTIFIED. |
| Coder v2 verification | `run_check` giữ readiness lock, không suy verification grant từ read grant | UNSUPPORTED; chưa có positive subprocess/dependency/isolation evidence. |
| Coder legacy / context không có version | Giữ code legacy hiện hữu, không cấp read scope mới | Thiếu field vẫn chưa chứng minh provenance legacy. Versioned legacy và unknown-context/restart migration chưa hoàn tất. |
| Reviewer snapshot / các provider dùng Forge registry | Git commit cố định + recorded environment blobs; tree/list/search/read cùng nguồn, không lấy cache live làm evidence | Positive/negative focused tests đạt, gồm caller ngoài diff bị sửa/xóa và blob corruption. Không chứng nhận native SDK parity hoặc toàn bộ checkpoint/restart matrix. |
| Reviewer Claude native | `createClaudeForgeOptions` cấu hình native tools `[]`, MCP allowlist | Config test đạt; chưa provider-live hoặc permission-route certification. |
| Reviewer OpenAI native | Gateway chỉ tạo tools từ options/Forge definitions; shell chỉ khi option riêng được cấp | Chưa smoke provider live hoặc recovery parity; registry tests không chứng minh toàn bộ gateway surface. |
| Reviewer Codex CLI native | Gateway vẫn có CLI sandbox options; MCP allowlist không vô hiệu hóa mọi native route | NOT CERTIFIED; chưa được coi là v2 snapshot-isolated provider. Coder admission deny không tự bảo vệ Reviewer path. |
| Reviewer `run_review_check` / mọi provider trong registry này | Luôn trả unsupported; không spawn/capture/materialize | Deny test và audit test đạt. Không còn legacy injected runner bypass tại tool này. Chưa có supported checks. |
| Owner conversation / legacy non-ticket Reviewer | Boundary hiện hữu; không tự đổi thành ticket snapshot | Ngoài phần cấp quyền v2 mới; không dùng làm fallback để vượt denial của ticket review. |

Production vẫn gọi `createRuntimeToolGovernance({ database, eventStore })` tại `production-runtime.js`, chưa có approved authority source để cấp v2. Không coi constructor option hiện có là wiring production đã hoàn thành.

## 4. Kiểm tra và artifact code

- Focused unit run: **34/34 PASS**, 0 fail, 0 skip. Files: `verification-environment-boundary`, `coder-reviewer-capabilities`, `reviewer-forge-tools`, `reviewer-snapshot-discovery`, `review-worker`, `reviewer-discovery-tools` trong `backend/tests/unit/`.
- Lệnh: `GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null TMPDIR="$PWD/.nodeforge/test-tmp" OPENSSL_CONF=/dev/null node --test --test-reporter=spec` kèm đúng sáu test files trên. Không chạy full suite.
- ESLint chỉ trên bảy JavaScript files của lượt này; kiểm tra diff và giới hạn 250 `code_lines` riêng cho files thay đổi.
- Đã chạy integration `backend/tests/integration/ticket-verification-environment.test.js`: **1 PASS, 1 FAIL** trên Node `v18.19.1`. Failure tại `entry.parentPath` của archive materialization, API/runtime không tương thích; expression này đã có trong HEAD trước patch. Project yêu cầu Node `>=22.5.0`. Chưa chạy lại bằng runtime được hỗ trợ; không đánh dấu integration PASS hoặc sửa unrelated runtime compatibility.
- Namespace probe `unshare --user --map-root-user -- true` trả 0 và có binary `bwrap`; chỉ là khảo sát khả năng host, không chứng minh command/filesystem/environment isolation. Không bật route dựa trên probe này.
- Không chạy provider live, coordinated race test, integration revocation/cache shrink, smoke v2 hoặc independent review.

SHA-256 code trong working tree của lượt này:

| File | SHA-256 |
| --- | --- |
| `backend/src/modules/supervisor/reviewer-forge-tools.js` | `4e83b2a6a6b43d3daf16f0e16d7278c45fc8e1b2bb1d98b70a66563e9a4cd413` |
| `backend/src/modules/supervisor/ticket-verification-environment.js` | `d08a83ad3cf915944ef20dc894919ddf01fa4c0f7cff31a7a8f8bc4a6bce0fe6` |
| `backend/src/modules/supervisor/ticket-verification-materialization.js` | `b299c09cfdedb754722b98b37b558e1b3b15e26eab9bfcc53c4d97f91e5c8b74` |
| `backend/src/modules/supervisor/review-worker.js` | `6cc9d892e23b83f6f33f422a41b474cbb6817eb04335a78f677ecc938fec4df3` |
| `backend/tests/unit/verification-environment-boundary.test.js` | `2e4aac1ba0e6b4f696b6ce555a441074d1c5f11d0de9dad6e6f0465268a71c79` |

## 5. Mapping nghiệm thu và bàn giao AM

| Outcome tiếp tục | Trạng thái | Mapping / phần thiếu |
| --- | --- | --- |
| C1 | PARTIAL / BLOCKED authority | Có baseline/hash/inventory; chưa Node approval hoặc hai quyết định §3.1. O1/O2/O5; F3/F4 chưa hoàn tất. |
| C2 | PARTIAL | Có recorded caller allow và corruption/ownership deny thực tế; live path-race và cache/index dưới authority thu hẹp chưa chứng minh. O1/O3/O5; F1/F5 chưa hoàn tất. |
| C3 | BLOCKED kỹ thuật và authority | Giữ Coder verification deny; không có supported subprocess route hoặc verification grant riêng production. O3/O5/O6; F1 chưa đạt. |
| C4 | PARTIAL | Đạt phần snapshot read/discovery và tamper controls trong focused tests; checks/toolchain/dependency isolation và Reviewer độc lập còn thiếu. O4/O6; F2 chưa hoàn tất. |
| C5 | BLOCKED | Chưa production authority wiring, versioned legacy provenance hoặc đầy đủ provider/recovery matrix. O1/O2/O5; F3/F4/F5 chưa đạt. |
| C6 | NOT RUN / BLOCKED | Chưa smoke supported coding → verification → independent review cùng revision; không đủ gates để rollout. |

**AM cần xử lý:** đối chiếu nguồn policy hiệu lực và chốt/trình đúng owner hai quyết định §3.1 bằng identity/revision/SHA và semantics có thể kiểm tra qua Node. Báo cáo này không tự cấp quyền ghi governance hoặc quyết định thu hồi.

**Công việc kỹ thuật còn lại của SE/SL:** object-boundary chống race cho live filesystem; sandbox verification cùng source/dependency/toolchain provenance; production issuance/recovery/legacy provenance; cache/revocation integration và toàn bộ provider/mode evidence; chạy lại integration trên Node hỗ trợ, rồi smoke và independent review. Không chuyển những việc kỹ thuật này thành yêu cầu owner duyệt từng helper; không báo hoàn tất chỉ vì đã bổ sung deny controls.
