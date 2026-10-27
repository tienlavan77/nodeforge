// Tracks source-to-summary conversion independently from source checksums so existing
// indexes can acquire purpose summaries without changing historical source comments.
// A receipt is committed with the normal extraction transaction, making interrupted
// conversion retryable while preserving the accepted extraction and processing contracts.
// Identifies the accepted source summary contract separately from source hashes.
const CONTRACT = "purpose-summary-v1";

// Creates durable conversion receipts without altering source, graph or symbol storage.
// Missing receipts intentionally mean conversion is still required, including files
// whose source checksum has not changed since the previous indexing contract.
export function createSummaryConversion(database) {
  // Defers schema initialization until conversion work is requested, preserving
  // side-effect-free indexer construction and its established transaction boundary.
  // Repeating the idempotent statement also handles a caller's rolled-back DDL.
  function ensureStorage() {
    database.run("CREATE TABLE IF NOT EXISTS purpose_summary_conversion (file_id TEXT PRIMARY KEY REFERENCES files(file_id) ON DELETE CASCADE, source_checksum TEXT NOT NULL, contract TEXT NOT NULL)");
  }
  return {
    // Checks the committed source version rather than treating absent comments as
    // unfinished work; a successfully parsed file with no summary is still converted.
    needed(file) {
      ensureStorage();
      const receipt = database.all("SELECT source_checksum, contract FROM purpose_summary_conversion WHERE file_id = ?", [file.file_id])[0];
      return !receipt || receipt.source_checksum !== file.sha256 || receipt.contract !== CONTRACT;
    },
    // Records success inside the caller's extraction transaction so parse, read or
    // write failures cannot leave a false completion receipt for the next restart.
    complete(fileId, checksum) {
      ensureStorage();
      database.run("INSERT INTO purpose_summary_conversion (file_id, source_checksum, contract) VALUES (?, ?, ?) ON CONFLICT(file_id) DO UPDATE SET source_checksum = excluded.source_checksum, contract = excluded.contract", [fileId, checksum, CONTRACT]);
    }
  };
}
