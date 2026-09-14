import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { string_decoder: "node:string_decoder" } },
  test: { include: ["test/**/*.test.ts"] },
});
