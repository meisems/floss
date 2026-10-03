import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only this project's tests (never copies of the project nested inside it).
    include: ["test/**/*.test.ts"],
  },
});
