import { describe, expect, it } from "vitest";
import config from "../vitest.config.js";

describe("Vitest worker limit", () => {
  it("caps routine test runs without forcing serial execution", () => {
    expect(config.test?.maxWorkers).toBe(4);
    expect(config.test?.maxWorkers).toBeGreaterThan(1);
  });
});
