import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const schema = require("../../../../schemas/agent/response-openai.schema.json");
