import { describe, expect, it } from "vitest";
import { missingEnv, parseDeployedUrl } from "../../scripts/setup.ts";

describe("missingEnv", () => {
  const required = ["A", "B"];
  it("accepts fully populated env", () => {
    expect(missingEnv({ A: "1", B: "2" }, required)).toEqual([]);
  });
  it("reports absent and blank values alike", () => {
    expect(missingEnv({ A: "1", B: "   " }, required)).toEqual(["B"]);
    expect(missingEnv({}, required)).toEqual(["A", "B"]);
  });
});

describe("parseDeployedUrl", () => {
  it("extracts the workers.dev URL from deploy output", () => {
    expect(
      parseDeployedUrl("Deployed async-decision-facilitator triggers\n  https://adf.example.workers.dev\n")
    ).toBe("https://adf.example.workers.dev");
  });
  it("returns undefined when absent", () => {
    expect(parseDeployedUrl("Total Upload: 1 KiB")).toBeUndefined();
  });
});
