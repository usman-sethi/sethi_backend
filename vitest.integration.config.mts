import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/database-mongodb/tests/**/*.integration.ts"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
  },
});
