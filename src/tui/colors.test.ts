import { describe, expect, it } from "bun:test";
import { toHexColor } from "./colors.js";

describe("toHexColor", () => {
  it("maps known AgentColors to hex", () => {
    expect(toHexColor("cyan")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(toHexColor("redBright")).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("returns white hex for unknown colors", () => {
    expect(toHexColor("unknown" as any)).toBe("#ffffff");
  });
});
