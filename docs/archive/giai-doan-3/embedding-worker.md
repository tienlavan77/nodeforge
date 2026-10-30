<!-- Summary: Ke hoach tach hang doi embedding va worker xu ly Ollama cho Watcher. -->

# Ke hoach Embedding Worker

## Muc tieu

Tach viec goi Ollama ra khoi Watcher. Watcher chi index source code va ghi job vao SQLite; Embedding Worker xu ly job, retry loi va ghi vector vao `symbol_embeddings`.

```text
Watcher -> embedding_jobs -> Embedding Worker -> Ollama LAN
                                      |
                                      v
                              symbol_embeddings
```

## Trang thai hien tai

- Backfill `embeddinggemma` dang chay va dang ghi truc tiep vao `symbol_embeddings`.
- Watcher dang dung.
- `embeddingStore` da co tai `backend/src/modules/index/embedding-store.js`.
- `embeddingProvider` da co tai `backend/src/modules/index/ollama-embedding-provider.js`.
- `database service` da co tai `backend/src/infrastructure/sqlite/database-service.js`.
- Chua co bang `embedding_jobs`.
- Chua co Embedding Worker rieng.
- Watcher chua duoc noi voi `embeddingStore` va `embeddingProvider`.

## Pha 1 - Lam ngay khi backfill dang chay

Muc tieu cua pha nay la chi viet va kiem thu code, khong dong vao database live va khong anh huong process backfill.

### Duoc phep lam

1. Viet migration moi cho bang `embedding_jobs` trong `index-database.js`.
2. Tao `EmbeddingJobStore` voi cac thao tac enqueue, claim, retry, complete va fail.
3. Tao Embedding Worker doc queue SQLite va goi Ollama tuan tu.
4. Them kiem tra checksum truoc khi ghi vector de bo job stale.
5. Them retry co backoff cho timeout, HTTP 500 va loi mang.
6. Viet unit test voi database tam cho job state machine va checksum.
7. Viet integration test cho worker restart, duplicate job va update lien tuc cung mot symbol.
8. Cap nhat tai lieu, logging va metric cho pending/processing/completed/retry/failed.

### Khong lam trong pha nay

- Khong apply migration vao `.forge/runtime/wc/index.db`.
- Khong start Watcher.
- Khong start Embedding Worker tren database live.
- Khong xoa, sua hoac migrate cac row trong `symbol_embeddings`.
- Khong chay them mot backfill song song.

Backfill hien tai doc database truc tiep va khong tu dong dung migration moi, nen cac thay doi schema chi duoc ap dung sau khi backfill ket thuc.

## Pha 2 - Sau khi backfill hoan tat

### Trinh tu bat buoc

1. Xac nhan backfill da dung va thong ke tong so embedding.
2. Kiem tra khong con process backfill dang chay.
3. Apply migration `embedding_jobs` thong qua `database service`.
4. Chay migration/test smoke tren mot database tam truoc khi mo database live.
5. Start Embedding Worker voi model `embeddinggemma`, concurrency = 1.
6. Chay reconciliation mot lan de tao job cho symbol thieu embedding hoac sai checksum.
7. Sua Watcher de enqueue job `pending` sau khi index symbol thanh cong.
8. Start Watcher va theo doi queue trong thoi gian ngan.
9. Chay backfill thong qua queue Worker neu con symbol thieu.

## Schema de xuat

Migration moi tao bang `embedding_jobs` trong cung index database:

```sql
CREATE TABLE embedding_jobs (
  job_id TEXT PRIMARY KEY,
  symbol_id TEXT NOT NULL,
  content_checksum TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 100,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (symbol_id) REFERENCES symbols(symbol_id) ON DELETE CASCADE
);

CREATE INDEX embedding_jobs_ready
  ON embedding_jobs(status, priority, next_retry_at, created_at);

CREATE UNIQUE INDEX embedding_jobs_active_symbol
  ON embedding_jobs(symbol_id, model)
  WHERE status IN ('pending', 'processing', 'retry_wait');
```

## State machine

```text
pending -> processing -> completed
                    \-> retry_wait -> processing
                    \-> failed
pending ------------> superseded
```

- `pending`: Watcher hoac reconciliation vua tao job.
- `processing`: Worker da claim job.
- `completed`: vector da ghi thanh cong.
- `retry_wait`: loi tam thoi, cho den `next_retry_at`.
- `failed`: vuot qua so lan retry, can theo doi hoac retry thu cong.
- `superseded`: checksum cu khong con la noi dung hien tai.

## Quy tac dong bo

- Watcher chi ghi `pending`, khong goi Ollama.
- Worker la process duy nhat ghi `symbol_embeddings`.
- Worker phai doc lai `symbol_content_fts` va doi checksum truoc khi upsert.
- Job moi hon cua cung symbol duoc uu tien hon job backfill.
- Chi giu mot job active cho moi `symbol_id + model`.
- Dung SQLite WAL va busy timeout thong qua `database service`.
- Khong dung `fileService` de truyen job embedding.

## Tieu chi hoan thanh

- Watcher khong bi block boi request Ollama dai hon 20 giay.
- Restart Worker khong lam mat job pending/processing.
- Ollama timeout duoc retry va co log ro rang.
- File sua lien tuc chi tao embedding cho noi dung moi nhat.
- Reconciliation tim duoc symbol thieu hoac stale.
- Khong con embedding cua checksum cu cho symbol dang co noi dung moi.
