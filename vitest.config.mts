import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/tests/**/*.test.ts",
      "examples/**/tests/**/*.test.ts",
    ],

    environment: "node",

    clearMocks: true,
    restoreMocks: true,

    coverage: {
      include: [
        "packages/*/src/**/*.ts",
        "examples/*/src/**/*.ts",
      ],

      exclude: [
        "packages/*/src/index.ts",
        "examples/*/src/index.ts",
      ],
    },
  },
});