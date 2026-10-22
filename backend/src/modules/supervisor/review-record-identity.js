// Assigns stable content identities to immutable review records and query snapshots.
import { createHash } from "node:crypto";

// Detects changed evidence independently of filenames, response wording or array position.
export function reviewRecordHash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
