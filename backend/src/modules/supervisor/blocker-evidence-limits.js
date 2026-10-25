/** Keeps receipt discovery, readability checks and agent reads on the same
 * bounded storage budget. Exact Node-issued receipts may include test output
 * larger than source files; tool responses still use their own output windows. */
export const BLOCKER_RECEIPT_MAX_BYTES = 4 * 1024 * 1024;
