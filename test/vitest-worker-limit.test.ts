import { describe, expect, it } from "vitest";
import config from "../vitest.config.js";

describe("Vitest resource limits", () => {
  it("caps routine test runs without forcing serial execution", () => {
    expect(config.test?.maxWorkers).toBe(4);
    expect(config.test?.maxWorkers).toBeGreaterThan(1);
  });

  it("excludes E2E directories and E2E-named tests", () => {
    expect(config.test?.exclude).toEqual(
      expect.arrayContaining([
        "**/e2e/**",
        "**/*e2e*.test.?(c|m)[jt]s?(x)",
        "**/*e2e*.spec.?(c|m)[jt]s?(x)",
      ]),
    );
  });
});
