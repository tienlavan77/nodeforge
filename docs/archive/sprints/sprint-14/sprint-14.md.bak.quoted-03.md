<!-- Preserves a quoted historical document section so engineers can read archived examples without treating them as new executable definitions; removing quote prefixes reconstructs the exact original bytes. -->
> 12. EXISTING ARCHITECTURE
> ==================================================
> 
> Không được phá:
> 
> - Agent Contract NF-108
> - Builder Adapter NF-109
> - Reviewer Adapter NF-110
> - External Agent Orchestrator NF-111
> - SSE NF-106 / NF-137
> - Communication Store NF-122
> - Communication Bus NF-123
> - Agent Registry NF-126
> - Agent Bootstrap NF-127
> - Governance Orchestrator NF-128
> - Architecture Manager NF-118
> - Architecture Manager Runtime Adapter NF-130
> - Sprint Leader Runtime Adapter NF-131
> - Agent Result Router NF-132
> - Persistent Agent Session NF-133
> - Full Operating Loop NF-134
> 
> NF-137A phải bổ sung real-agent connectivity
> trên các abstraction hiện có.
> 
> 
> ==================================================
> 13. TEST REQUIREMENTS
> ==================================================
> 
> Builder phải thêm tests cho:
> 
> 1. Agent Profile validation
> 2. Gateway URL validation
> 3. API Key handling
> 4. Environment/config generation
> 5. Environment/config update
> 6. Multiple Agent profiles
> 7. Connection test
> 8. Real Agent request routing
> 9. Real Agent response routing
> 10. Real Agent streaming
> 11. Credential redaction
> 12. Duplicate/idempotent configuration update
> 13. Invalid gateway handling
> 14. Agent disabled handling
> 
> Phải có test chứng minh API Key không xuất hiện trong:
> 
> - persisted communication
> - events
> - logs nếu test harness hỗ trợ
> - SSE payload
> 
> 
> ==================================================
> 14. REAL INTEGRATION TEST
> ==================================================
> 
> Builder phải tạo một real-agent integration path.
> 
> Không được dùng fake Agent response cho acceptance.
> 
> Nếu môi trường Builder không có credential / Gateway thật,
> Builder phải báo rõ:
> 
> REAL AGENT TEST BLOCKED
> 
> và không được báo PASS bằng mock thay thế.
> 
> Có thể dùng mock chỉ cho unit tests của connection layer.
> 
> Acceptance real-agent phải phân biệt rõ:
> 
> UNIT:
> mock gateway được phép
> 
> INTEGRATION:
> real configured gateway bắt buộc
> 
> ==================================================
> 15. BROWSER VERIFICATION
> ==================================================
> 
> Sau khi hoàn tất:
> 
> 1. Start Node:
> 
> npm run dev:node
> 
> 2. Start Web:
> 
> npm run dev
> 
> 3. Mở:
> 
> http://localhost:4174/
> 
> 4. Mở Agent Settings.
> 
> 5. Cấu hình một Agent.
> 
> 6. Test Connection.
> 
> 7. Gửi message.
> 
> 8. Xác nhận request đi qua Node.
> 
> 9. Xác nhận Real Agent trả response.
> 
> 10. Xác nhận response được stream về đúng panel.
> 
> Builder phải cung cấp:
> 
> - Node command
> - Web command
> - Browser URL
> - Agent configuration procedure
> - Connection result
> 
> 
> ==================================================
> 16. ACCEPTANCE CRITERIA
> ==================================================
> 
> NF-137A PASS khi:
> 
> [ ] 4 Agent có Agent Settings
> 
> [ ] Gateway URL configurable
> 
> [ ] API Key configurable
> 
> [ ] Agent Profile configurable
> 
> [ ] Node tạo/cập nhật environment configuration
> 
> [ ] Credential không nằm trong Git
> 
> [ ] Credential không nằm trong Communication Store
> 
> [ ] Credential không nằm trong Event Store
> 
> [ ] Credential không nằm trong History
> 
> [ ] Credential không nằm trong Memory
> 
> [ ] Credential không nằm trong SSE
> 
> [ ] Test Connection hoạt động
> 
> [ ] Node kết nối Gateway thật
> 
> [ ] Real Agent nhận request
> 
> [ ] Real Agent trả response thật
> 
> [ ] Node nhận response
> 
> [ ] Node persist/audit communication an toàn
> 
> [ ] Node stream response lên đúng Agent Chat
> 
> [ ] Không fake response trong real-agent path
> 
> [ ] Không Agent direct connection từ Web UI
> 
> [ ] Browser verification PASS
> 
> 
> ==================================================
> 17. QUALITY GATES
> ==================================================
> 
> Phải chạy:
> 
> - NF-137 tests
> - Web tests
> - Agent tests
> - Governance regression
> - Runtime regression
> - Recovery regression
> - Sprint 10 regression
> - Sprint 11 regression
> - Sprint 12 regression
> - Lint
> - Typecheck nếu repository có gate tương ứng
> - Schema validation
> - git diff --check
> 
> 