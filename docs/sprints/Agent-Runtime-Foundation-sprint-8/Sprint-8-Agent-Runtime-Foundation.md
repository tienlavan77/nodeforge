# Sprint 8 — Agent Runtime Foundation

## Mục tiêu
Xây dựng Agent Runtime nội bộ sử dụng Memory Layer.

## Tickets
- NF-087 — Agent Context Service
- NF-088 — Agent Session Runtime
- NF-089 — Planning Engine
- NF-090 — Action Executor
- NF-091A — Agent Runtime Event Schema
- NF-091 — Agent Event Integration
- NF-092 — Memory Feedback Loop
- NF-093 — Context Budget Manager
- NF-094 — Agent Runtime Integration

## Runtime Flow
Context Service
→ Budget Manager
→ Planning Engine
→ Session Runtime
→ Executor
→ Agent Events
→ History
→ Summary
→ Memory

## Exit Evidence
- Plan steps: 3
- Events published: 9
- Summary facts: 1
- Memory facts: 1

## Exit
Task A tạo memory mới và Task B truy xuất được fact đó.
