<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
                  │               │
                  └───────┬───────┘
                          ▼
                         NODE
```

Node là:

- Communication Hub
- Governance Hub
- Planning Hub
- Runtime State Hub
- Audit Hub
- Recovery Hub

Filesystem/Git vẫn là:

```text
Source of Truth
for Source Code
```

---

# Sprint 12 Success Definition

Sprint 11 đã xây "các bộ phận".

Sprint 12 phải chứng minh:

```text
Các bộ phận đó thực sự được Node bootstrap,
được Node điều phối,
được Node lưu trạng thái,
và có thể chạy qua một operating loop hoàn chỉnh.
```