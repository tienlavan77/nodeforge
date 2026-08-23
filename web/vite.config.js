import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import { loadNodeforgeEnv } from "../scripts/nodeforge-env.mjs";

loadNodeforgeEnv();

const nodeApiUrl = process.env.VITE_NODE_API_URL ?? "http://192.168.1.181:3100";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: {
    port: 4174,
    strictPort: false,
    proxy: {
      "/projects": { target: nodeApiUrl, changeOrigin: true },
      "/agents": { target: nodeApiUrl, changeOrigin: true },
      "/tasks": { target: nodeApiUrl, changeOrigin: true },
      "/sessions": { target: nodeApiUrl, changeOrigin: true }
    }
  },
  build: { outDir: "dist", emptyOutDir: true }
});
