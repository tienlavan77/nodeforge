# Sprint 7 — Events, History & Memory

## Mục tiêu
Xây dựng Memory Layer cho Nodeforge.

## Tickets
- NF-078 — Event Store & Publisher
- NF-079 — Event Publication Idempotency
- NF-080 — Event Subscriptions
- NF-081 — Raw History Audit Trail
- NF-082 — Task Summary Store
- NF-083 — Project Memory Store
- NF-084 — History Compaction & Archive
- NF-085 — Memory Retriever
- NF-086 — Memory Pipeline Verification

## Kết quả
Event → History → Task Summary → Project Memory → Retrieval

## KPI NF-086
- History records: 100
- Summary facts: 9
- Memory facts: 2
- Retrieved facts: 1

## Exit
Agent chỉ nhận fact liên quan, không đọc toàn bộ history.
