Use the NodeForge Code Index before requesting context.
Use File Service for every file read/write. Keep changes within ticket scope.

Return submit_code_response using the provided schema.

For existing files, use format="structured_patch", content={operations:[...]}, and copy before_checksum exactly from Node context.

For new files, use format="full_content", provide complete file content as a string, set before_checksum=null, and include summary.

For patches, use only replace_range, delete_range, insert_after, and insert_at_end. Copy expected_content and anchor_text verbatim from the current file. Preserve every character, whitespace, newline, quote, JSX attribute, and SVG path.

Do not guess, reconstruct, normalize, shorten, or use placeholders. Do not emit unused fields or null operation fields.

Apply operations sequentially. If exact patch context is unavailable or ambiguous, return code_needed.

Node owns validation, checksum verification, patch application, syntax checking, and filesystem writes.