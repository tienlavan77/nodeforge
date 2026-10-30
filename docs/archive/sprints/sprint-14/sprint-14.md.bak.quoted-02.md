<!-- Preserves a quoted historical document section so engineers can read archived examples without treating them as new executable definitions; removing quote prefixes reconstructs the exact original bytes. -->
> Sau NF-137A:
> 
> Architecture Manager Chat
>         ↓
> Node
>         ↓
> Configured Gateway
>         ↓
> REAL Architecture Manager Agent
>         ↓
> Node
>         ↓
> SSE
>         ↓
> Browser
> 
> Tương tự:
> 
> Sprint Leader
> Builder
> Reviewer
> 
> Không dùng fake response trong real-agent path.
> 
> Không hard-code:
> 
> "architecture.message.received"
> 
> hoặc response giả để giả lập Agent.
> 
> Events phải phản ánh lifecycle thực tế của Agent.
> 
> 
> ==================================================
> 7. STREAM REAL AGENT RESPONSE
> ==================================================
> 
> Node phải nhận response từ Agent thật và stream lên
> đúng Agent Chat Panel.
> 
> Ví dụ:
> 
> Real Agent
>    ↓
> partial response / working event
>    ↓
> Node
>    ↓
> SSE
>    ↓
> Builder Chat
> 
> Nếu Gateway hỗ trợ streaming:
> 
> Real Agent
>    ↓
> stream chunks/events
>    ↓
> Node
>    ↓
> SSE
>    ↓
> Browser
> 
> Nếu Gateway chỉ trả response hoàn chỉnh:
> 
> Node vẫn phải:
> 
> - nhận response thật
> - persist communication
> - publish result
> - stream result lên UI
> 
> Không fake streaming.
> 
> ==================================================
> 8. CONNECTION TEST
> ==================================================
> 
> Agent Settings phải có:
> 
> [ Test Connection ]
> 
> Flow:
> 
> Web UI
>  ↓
> Node
>  ↓
> configured Gateway
>  ↓
> Real Agent / gateway health
>  ↓
> Node
>  ↓
> UI
> 
> Kết quả:
> 
> CONNECTED
> hoặc
> FAILED
> 
> Error phải an toàn.
> 
> Không hiển thị API Key trong error.
> 
> ==================================================
> 9. AGENT PROFILE UI
> ==================================================
> 
> Mỗi Agent panel có menu:
> 
> ┌──────────────────────────────────────┐
> │ Architecture Manager            ⚙  │
> └──────────────────────────────────────┘
> 
> Menu:
> 
> Agent Profile
> ────────────────
> Agent Name
> Agent ID
> 
> Gateway URL
> [.................................]
> 
> API Key
> [***********************]
> 
> [ Test Connection ]
> 
> [ Save Profile ]
> 
> Status:
> ● Connected
> 
> 
> Builder phải thiết kế UI theo convention hiện tại,
> không tự thay đổi layout 2/5 + 3/5 đã được Project Owner
> phê duyệt.
> 
> 
> ==================================================
> 10. PERSISTENCE / CONFIG BOUNDARY
> ==================================================
> 
> Conversation persistence tiếp tục dùng:
> 
> - Communication Store
> - Event Store
> - History
> - Memory
> 
> Agent credential/config KHÔNG đưa vào các store trên.
> 
> Agent configuration thuộc Node configuration boundary.
> 
> Node là nơi đọc configuration khi dispatch Agent.
> 
> 
> ==================================================
> 11. SECURITY REQUIREMENTS
> ==================================================
> 
> API Key tuyệt đối không được:
> 
> - render plaintext sau khi save
> - persist vào chat
> - persist vào event
> - persist vào history
> - persist vào memory
> - commit vào Git
> - xuất hiện trong console.log
> - xuất hiện trong exception message
> - gửi qua SSE
> 
> Nếu Builder cần debug:
> 
> chỉ log:
> 
> agent_id
> gateway_url (nếu gateway URL không chứa secret)
> connection status
> request correlation_id
> 
> Không log Authorization header.
> 
> 
> ==================================================
> 