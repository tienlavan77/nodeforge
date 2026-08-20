import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: { port: 4173, strictPort: false },
  build: { outDir: "dist", emptyOutDir: true }
});
