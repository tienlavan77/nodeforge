// Executes the configured UI production build through the bounded diagnostic
// runner, retaining its real compiler output and exit code for Phase A evidence.
// This invokes pnpm build against the project itself; it does not mock the
// compiler, suppress failures, or substitute a fixture for production assets.
import { verifyUiProductionBuild } from "./diagnose-ui-production-build.mjs";
await verifyUiProductionBuild(false);
