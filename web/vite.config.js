import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: {
    port: 4173,
    strictPort: false,
    proxy: { "/projects": { target: "http://127.0.0.1:3100", changeOrigin: true } }
  },
  build: { outDir: "dist", emptyOutDir: true }
});
