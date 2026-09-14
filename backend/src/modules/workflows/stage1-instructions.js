export const STAGE1_CONVENTIONS = "Use the NodeForge Code Index before requesting context.\nUse File Service for every file read/write and keep changes within the ticket scope.\nNode owns state, filesystem, and checksums. Use only what Node explicitly provides.\nIf the required source context is missing or ambiguous, return code_needed.\nFor every existing file, copy before_checksum exactly from Node-provided context; never recompute or guess it.\nFile write rules: new file or file under 8 KB use write_diff with full content; existing large file with a local change use read_file {offset,limit} around the target then edit_diff {anchor, replacement} with a unique exact anchor; scattered changes use multiple edit_diff calls. write_diff over 8 KB is rejected with CONTENT_TOO_LARGE — retry with edit_diff.";

export const PLANNING_INSTRUCTION = "Before making any code changes, you MUST create an implementation plan and call the planning tool exactly once. Return one plan item per required filesystem file (never one item per action): every path MUST appear exactly once and have exactly one action. Allowed actions are NEW (create), MODIFY (edit), and READ_ONLY (inspect only). If the same path could receive multiple actions, resolve that conflict before responding by choosing the highest-priority action in this exact order: NEW, then MODIFY, then READ_ONLY. If a file must be inspected and modified, classify it as MODIFY; do not emit both entries. Each NEW or MODIFY entry MUST briefly state why the file is required and what will change; each READ_ONLY entry MUST state why it must be inspected. Use only concrete relative file paths with extensions; do not use directories, semantic labels, placeholders, prose, Markdown, code, or a second response. If the required files cannot be determined from the available repository context, request the necessary context first. Before returning, verify the plan has no duplicate paths and that every path has exactly one action."

export const CODE_REQUIRE_INSTRUCTION = `Execute the approved plan now.

- The response.files array MUST contain every NEW and MODIFY entry in the approved plan. Omitting any approved file is invalid.
- NEW file: format=full_content; content MUST be the complete final file content as a string; exists=false, before_checksum=null.
- EXISTING file to be MODIFIED: Node provides the complete current content as context. Return format=structured_patch with content={operations:[...]}; exists=true and copy before_checksum EXACTLY from Node.
- READ_ONLY file: do not include it in the response.

Use only the exact context provided by Node. Do not guess, normalize, shorten, or omit source content. Do not use line numbers, offsets, placeholders, patches, or fields not defined in the schema. Do not use null except before_checksum=null for a NEW file.

If an approved change cannot be implemented safely from the provided context, do not fabricate content; return an error according to the Node protocol.

Only return submit_code_response and adhere strictly to its schema. Do not return planning, Markdown, or any text outside the response schema.`;

export const STRUCTURED_PATCH_CONTRACT = `For structured_patch operations, return a patch for every approved MODIFY path; never return only NEW-file content when MODIFY paths exist:
- replace_range: exactly {op, expected_content, new_content}
- delete_range: exactly {op, expected_content}
- insert_after: exactly {op, anchor_text, new_content}
- insert_at_end: exactly {op, new_content}

Every operation MUST include "op" with one of the allowed operation names.
expected_content and anchor_text MUST be non-empty strings copied verbatim from the current Node-provided file context.
Never omit required fields, use null, add fields from another operation, or modify patch context.
Apply operations sequentially against the current in-memory file.`;

export const SELECT_CODE_GRAPH_CANDIDATES_INSTRUCTION = "You must call select_code_graph_candidates before using code_needed for discovery. Use it to explore the project by searching for files related to your task using the task context, the acceptance criteria, or any other context you infer to be relevant to the task. After discovery, if you still need context, respond with code_needed and list individual file paths only; do not request directories.";

export const TASK_REVIEW_INSTRUCTION = "Review the task description first. Determine what repository context is required. If any required file content is missing, report the exact files needed to Node using code_needed after discovering relevant files with select_code_graph_candidates. files_requested must list individual file paths with extensions only — never directories. Do not modify code or produce a patch until Node has provided the required context.";

export function buildStage1InstructionBlocks({ includePlanning = false, includeTaskReview = false, includeConventions = true, includeCodeGraphCandidates = false } = {}) {
  return [
    ...(includeConventions ? [{ block_id: "stage1-conventions", content: STAGE1_CONVENTIONS, cacheable: true }] : []),
    ...(includeTaskReview ? [{ block_id: "task-review", content: TASK_REVIEW_INSTRUCTION, cacheable: false }] : []),
    ...(includePlanning ? [{ block_id: "planning", content: PLANNING_INSTRUCTION, cacheable: false }] : []),
    ...(includeCodeGraphCandidates ? [{ block_id: "select_code_graph_candidates", content: SELECT_CODE_GRAPH_CANDIDATES_INSTRUCTION, cacheable: false }] : [])
  ];
}
