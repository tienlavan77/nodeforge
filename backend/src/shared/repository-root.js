// Identifies this checkout for repository-owned tooling, so running commands from
// backend does not create a second .forge tree. External project roots remain
// explicit inputs to application services and are not redirected by this value.
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
