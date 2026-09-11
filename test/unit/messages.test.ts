import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_LENGTH, validateMessageBody } from "../../src/server/domain/messages.ts";

describe("validateMessageBody", () => {
  it("keeps the message as written, trimmed", () => {
    expect(validateMessageBody("  I think we should slip.\n\nMarch is safer.  ")).toBe(
      "I think we should slip.\n\nMarch is safer."
    );
  });

  it("rejects a message with nothing in it", () => {
    expect(() => validateMessageBody("")).toThrow(/cannot be empty/);
    expect(() => validateMessageBody("   \n  ")).toThrow(/cannot be empty/);
  });

  it("rejects a body that is not a string at all", () => {
    expect(() => validateMessageBody(undefined)).toThrow(/cannot be empty/);
    expect(() => validateMessageBody(42)).toThrow(/cannot be empty/);
  });

  it("rejects a message past the length bound, but accepts one at it", () => {
    expect(validateMessageBody("x".repeat(MAX_MESSAGE_LENGTH))).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(() => validateMessageBody("x".repeat(MAX_MESSAGE_LENGTH + 1))).toThrow(/under/);
  });
});
