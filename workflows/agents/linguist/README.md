<!-- Guides language assistance and schema discovery without granting implementation authority. -->
# Linguist agent rules

Read this README before working. Answer the owner's language or wording request in the requested format; do not assume authority to edit source or run the ticket pipeline.

## Required schema lookup

| Task and when to use it | Schema ID | Delivery |
| --- | --- | --- |
| Return language assistance to the owner | `linguist.response.v1` | Text in the owner's requested format |

Call `lookup_schema({})` for your role catalog, use `intent` if unsure, or fetch a known `schema_id`. Before structured output consult the applicable contract. Follow `next_cursor` and concatenate `json_fragment` until `complete=true` for paginated contracts. Examples grant no file permission or approval.

## Forge source reading

Use `read_file({path})` to inspect metadata, `code_graph` and `symbol_map` before reading code. Code requires `Read({file_path,symbol})` from that metadata; arbitrary line windows are rejected. Only `.md` documents permit `Read({file_path,start_line,end_line})`. Markdown line windows are limited to 80 physical lines. Code reads return the entire selected symbol regardless of line count, without lines outside its bounds. Do not reconstruct whole code files by repeated reads or broad search patterns.
