export const STAGE1_CONVENTIONS = "Use the NodeForge Code Index before requesting context.\nUse File Service for every file read/write and keep changes within the ticket scope.\nNode owns state, filesystem, and checksums. Use only what Node explicitly provides.\nIf the required source context is missing or ambiguous, return code_needed.\nFor every existing file, copy before_checksum exactly from Node-provided context; never recompute or guess it.";

export const PLANNING_INSTRUCTION = "Before making any code changes, you MUST create an implementation plan. The plan MUST identify every file required for the task and classify each file as: NEW (create), MODIFY (edit), or READ_ONLY (inspect only). For every NEW or MODIFY file, briefly state why it is required and what will change. Do not modify or submit code during planning. If the required files cannot be determined from the available repository context, request the necessary context first.";

export const CODE_REQUIRE_INSTRUCTION = `Implement the approved plan now.

- NEW file: format=full_content, exists=false, before_checksum=null; content MUST be the complete file as a string.
- EXISTING file to modify: format=structured_patch, exists=true; copy before_checksum EXACTLY from Node; modify only the approved file.
- READ_ONLY file: do not include it in the response.

For existing files, use only exact context provided by Node. Do not guess, reconstruct, normalize, shorten, or alter expected_content or anchor_text. Do not use line numbers, offsets, placeholders, or schema-undefined fields. Do not use null except before_checksum=null for a NEW file.

If the approved change cannot be implemented safely from the provided context, do not fabricate a patch; return an error according to the Node protocol.

Return submit_code_response only and conform exactly to its schema. Do not return planning, Markdown, or any text outside the response schema.`;

export const STRUCTURED_PATCH_CONTRACT = `For structured_patch operations:
- replace_range: exactly {op, expected_content, new_content}
- delete_range: exactly {op, expected_content}
- insert_after: exactly {op, anchor_text, new_content}
- insert_at_end: exactly {op, new_content}

Every operation MUST include "op" with one of the allowed operation names.
expected_content and anchor_text MUST be non-empty strings copied verbatim from the current Node-provided file context.
Never omit required fields, use null, add fields from another operation, or modify patch context.
Apply operations sequentially against the current in-memory file.`;

export const TASK_REVIEW_INSTRUCTION = "Review the task description first. Determine what repository context is required. If any required file content is missing, report the exact files needed to Node using code_needed. Do not modify code or produce a patch until Node has provided the required context.";

export function buildStage1InstructionBlocks({ includePlanning = false, includeTaskReview = false, includeConventions = true } = {}) {
  return [
    ...(includeConventions ? [{ block_id: "stage1-conventions", content: STAGE1_CONVENTIONS, cacheable: true }] : []),
    ...(includeTaskReview ? [{ block_id: "task-review", content: TASK_REVIEW_INSTRUCTION, cacheable: false }] : []),
    ...(includePlanning ? [{ block_id: "planning", content: PLANNING_INSTRUCTION, cacheable: false }] : [])
  ];
}
