<!-- Preserves a quoted historical document section so engineers can read archived examples without treating them as new executable definitions; removing quote prefixes reconstructs the exact original bytes. -->
> NF-137A — Agent Connection Profile & Real Agent Gateway
> 
> Mục tiêu
> 
> Mở rộng 4 Agent Chat Panel để Project Owner có thể cấu hình
> Agent thật thông qua Node.
> 
> Mỗi Agent Chat Panel phải có menu "Agent Settings" cho phép:
> 
> - Set Gateway URL
> - Set API Key
> - Tạo / cập nhật Agent Profile
> - Kiểm tra connection
> - Enable / disable connection
> 
> Các Agent:
> 
> - Architecture Manager
> - Sprint Leader
> - Builder
> - Reviewer
> 
> Web UI KHÔNG lưu API Key và KHÔNG kết nối Agent trực tiếp.
> 
> Flow:
> 
> Project Owner
>       ↓
> Web UI
>       ↓
> Node Control API
>       ↓
> Agent Profile / Environment Store
>       ↓
> Node Agent Gateway
>       ↓
> Real Agent
>       ↓
> Node
>       ↓
> SSE
>       ↓
> Web UI
> 
> 
> ==================================================
> 1. AGENT PROFILE
> ==================================================
> 
> Mỗi Agent phải có profile riêng.
> 
> Profile tối thiểu:
> 
> - agent_id
> - agent_name
> - gateway_url
> - api_key reference
> - enabled
> - status
> - created_at
> - updated_at
> 
> Không để API key plaintext xuất hiện trong:
> 
> - UI
> - conversation
> - Event Store
> - Communication Store
> - History
> - Memory
> - log
> - error message
> - SSE payload
> 
> 
> ==================================================
> 2. GATEWAY URL
> ==================================================
> 
> Project Owner có thể cấu hình Gateway URL cho từng Agent.
> 
> Ví dụ:
> 
> Architecture Manager
> → https://...
> 
> Sprint Leader
> → https://...
> 
> Builder
> → https://...
> 
> Reviewer
> → https://...
> 
> Node là bên sử dụng Gateway URL.
> 
> Không được:
> 
> Web UI → Gateway URL
> 
> 
> ==================================================
> 3. API KEY
> ==================================================
> 
> Project Owner nhập API Key trong Agent Settings.
> 
> Web UI chỉ gửi credential tới Node qua secure local/API
> configuration flow.
> 
> Node phải:
> 
> - nhận API Key
> - lưu theo cơ chế environment/config hiện hành
> - không đưa key vào Communication Store
> - không đưa key vào Event Store
> - không đưa key vào Agent message
> - không đưa key vào SSE
> - không log plaintext key
> 
> UI phải hiển thị dạng masked:
> 
> ********
> 
> 
> ==================================================
> 4. NODE ENVIRONMENT CONFIGURATION
> ==================================================
> 
> Node tự tạo / cập nhật environment configuration cho Agent.
> 
> Ví dụ conceptual:
> 
> ARCHITECTURE_MANAGER_GATEWAY_URL=...
> ARCHITECTURE_MANAGER_API_KEY=...
> 
> SPRINT_LEADER_GATEWAY_URL=...
> SPRINT_LEADER_API_KEY=...
> 
> BUILDER_GATEWAY_URL=...
> BUILDER_API_KEY=...
> 
> REVIEWER_GATEWAY_URL=...
> REVIEWER_API_KEY=...
> 
> Tên biến thực tế phải follow convention của repository.
> 
> KHÔNG hard-code credential trong source code.
> 
> KHÔNG commit credential vào Git.
> 
> Environment/config file phải được:
> 
> - tạo tự động nếu chưa tồn tại
> - cập nhật an toàn
> - giữ các configuration khác
> - không overwrite ngoài scope
> - có filesystem permission phù hợp nếu platform hỗ trợ
> 
> 
> ==================================================
> 5. AGENT CONNECTION SERVICE
> ==================================================
> 
> Node cần có một lớp connection/gateway abstraction.
> 
> Flow:
> 
> Agent Profile
>       ↓
> Node Agent Gateway
>       ↓
> Gateway URL
>       ↓
> Real Agent
> 
> Không để Agent Adapter tự đọc UI/config trực tiếp.
> 
> Không để Web UI tự gọi Gateway.
> 
> Không đưa Gateway implementation vào React component.
> 
> 
> ==================================================
> 6. REAL AGENT CONNECTION
> ==================================================
> 
> Đây là điểm quan trọng nhất của NF-137A.
> 
> 