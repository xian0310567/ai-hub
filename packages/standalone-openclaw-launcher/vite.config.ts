// vite.config.ts
import { defineConfig } from "vite";

// Tauri expects the frontend dist under `../dist` relative to `src-tauri/`,
// which is `<package>/dist` from the Vite root. `tauri dev` sets
// `TAURI_ENV_DEBUG`; we just mirror the standard Tauri-friendly config.
export default defineConfig({
  root: "src",
  publicDir: "../public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
  },
  clearScreen: false,
});
