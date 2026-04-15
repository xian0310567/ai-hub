// vitest.config.ts
//
// Separate from vite.config.ts because Vite's `root: "src"` would hide the
// `tests/` directory from Vitest's default include glob. This config resolves
// relative to the package root so `tests/*.test.ts` is picked up.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.{test,spec}.ts"],
    environment: "node",
  },
});
