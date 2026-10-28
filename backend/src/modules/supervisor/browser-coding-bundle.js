// Bundles exact ticket sources with controlled external I/O for real-browser acceptance without touching production data.
import { fileURLToPath } from "node:url";
import { resolve, basename } from "node:path";

// Uses the production Coding page for presence checks and preserves existing monitor scenarios for other assertions.
export async function buildCodingBrowserFixture({ build, sourceRoot, presence = false, layout = false }) {
  const moduleUrl = new URL(layout ? "./browser-coding-layout-fixture.js" : presence ? "./browser-coding-presence-fixture.js" : "./browser-coding-fixture.js", import.meta.url);
  const adapters = fileURLToPath(new URL("./browser-coding-presence-adapters.js", import.meta.url));
  return build({ entryPoints: [fileURLToPath(moduleUrl)], bundle: true, write: false, outdir: "browser-fixture", platform: "browser", jsx: "automatic",
    alias: { "@ticket/ui": resolve(sourceRoot, "ui/nextjs"), react: resolve(sourceRoot, "ui/nextjs/node_modules/react"), "react-dom": resolve(sourceRoot, "ui/nextjs/node_modules/react-dom") },
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
    // Defines setup method behavior for browser-coding-bundle.js.
    plugins: presence ? [{ name: "controlled-coding-io", setup(builder) {
      builder.onResolve({ filter: /\/(?:node-client|home-page-event-stream|home-page-constants|conversation-sidebar)\.[jt]sx?$/ }, (args) => {
        if (!args.importer.startsWith(resolve(sourceRoot, "ui/nextjs") + "/")) return null;
        if (["node-client.js", "home-page-event-stream.js", "home-page-constants.js", "conversation-sidebar.jsx"].includes(basename(args.path))) return { path: adapters };
        return null;
      });
    } }] : [] });
}
