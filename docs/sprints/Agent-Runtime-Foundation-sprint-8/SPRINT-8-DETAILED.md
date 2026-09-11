# Sprint 8 — Agent Runtime Foundation

## Goal
Xây dựng Agent Runtime nội bộ sử dụng Memory Layer của Sprint 7.

## Architecture
Context Service
→ Budget Manager
→ Planning Engine
→ Session Runtime
→ Executor
→ Agent Events
→ History
→ Summary
→ Memory

## Tickets

### NF-087 Agent Context Service
- Chuẩn hóa context cho agent
- Không đọc trực tiếp History/Event Store

### NF-088 Agent Session Runtime
States:
- CREATED
- RUNNING
- PAUSED
- COMPLETED
- FAILED

### NF-089 Planning Engine
- Deterministic planning
- Task → Ordered Steps

### NF-090 Action Executor
- Sequential execution
- Stop on failure

### NF-091A Agent Event Schema
- Bổ sung 6 event types cho Agent Runtime

### NF-091 Agent Event Integration
Events:
- agent.started
- agent.plan.created
- agent.step.started
- agent.step.completed
- agent.failed
- agent.completed

### NF-092 Memory Feedback Loop
Agent Events → History → Summary → Memory

### NF-093 Context Budget Manager
- Limit facts
- Deterministic selection

### NF-094 Agent Runtime Integration
- E2E Runtime Integration

## Exit Evidence
- Plan Steps: 3
- Events Published: 9
- Summary Facts: 1
- Memory Facts: 1

## Exit Criteria
Task A tạo Memory mới.
Task B truy xuất được Memory đó.
