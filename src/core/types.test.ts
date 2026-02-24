import { describe, expect, it } from "bun:test";
import { makeId, parseId } from "./types.js";

describe("makeId", () => {
  it("creates content IDs with -m suffix", () => {
    expect(makeId(0, "chat")).toBe("0000-m");
    expect(makeId(3, "user")).toBe("0003-m");
  });

  it("creates event IDs with -e suffix", () => {
    expect(makeId(1, "join")).toBe("0001-e");
    expect(makeId(2, "leave")).toBe("0002-e");
    expect(makeId(0, "system")).toBe("0000-e");
  });

  it("pads to 4 digits", () => {
    expect(makeId(42, "chat")).toBe("0042-m");
    expect(makeId(9999, "chat")).toBe("9999-m");
  });
});

describe("parseId", () => {
  it("extracts sequence number from content ID", () => {
    expect(parseId("0042-m")).toBe(42);
  });

  it("extracts sequence number from event ID", () => {
    expect(parseId("0001-e")).toBe(1);
  });

  it("returns -1 for invalid IDs", () => {
    expect(parseId("invalid")).toBe(-1);
    expect(parseId("")).toBe(-1);
  });
});
