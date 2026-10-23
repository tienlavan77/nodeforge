<!-- Ghi nhận known issue cần điều tra riêng cho retrieval eval. -->
# Retrieval known issue: 1789618154255

- Priority: non-urgent; does not block the `0.65` lexical / `0.35` semantic default.
- Question: verify whether `backend/src/modules/protocol/conversation-state-store.js` reaches the candidate pool before the limit cut.
- Compare its normalized lexical and cosine scores with the candidate that displaces it.
- Determine whether the miss comes from similarity scoring or the eight-file shortlist limit.
