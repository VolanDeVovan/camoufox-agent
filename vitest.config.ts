import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    // Every file runs its own daemon and real browsers (about 1 GB each).
    maxWorkers: 4,
    minWorkers: 1,
  },
});
