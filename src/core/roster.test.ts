import { describe, expect, it } from "bun:test";
import { PERSONALITY_PRESETS, randomLeaveExcuse, randomJoinGreeting } from "./roster.js";
import type { AgentColor } from "./types.js";

const VALID_COLORS: AgentColor[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "gray", "redBright", "greenBright", "yellowBright", "blueBright",
  "magentaBright", "cyanBright", "whiteBright",
];

describe("PERSONALITY_PRESETS", () => {
  it("has exactly 8 presets", () => {
    expect(PERSONALITY_PRESETS).toHaveLength(8);
  });

  it("every preset has all required personality fields", () => {
    for (const preset of PERSONALITY_PRESETS) {
      const p = preset.personality;
      expect(p.name).toBeTruthy();
      expect(p.color).toBeTruthy();
      expect(p.tagline).toBeTruthy();
      expect(p.traits.length).toBeGreaterThan(0);
      expect(p.style.length).toBeGreaterThan(0);
      expect(p.bias).toBeTruthy();
      expect(typeof p.chattiness).toBe("number");
      expect(typeof p.contrarianism).toBe("number");
      expect(p.chattiness).toBeGreaterThanOrEqual(0);
      expect(p.chattiness).toBeLessThanOrEqual(1);
      expect(p.contrarianism).toBeGreaterThanOrEqual(0);
      expect(p.contrarianism).toBeLessThanOrEqual(1);
    }
  });

  it("every preset has a valid AgentColor", () => {
    for (const preset of PERSONALITY_PRESETS) {
      expect(VALID_COLORS).toContain(preset.personality.color);
    }
  });

  it("every preset has a provider and model", () => {
    for (const preset of PERSONALITY_PRESETS) {
      expect(preset.provider).toBeTruthy();
      expect(preset.model).toBeTruthy();
    }
  });

  it("all preset names are unique", () => {
    const names = PERSONALITY_PRESETS.map(p => p.personality.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("randomLeaveExcuse", () => {
  it("returns a non-empty string", () => {
    const excuse = randomLeaveExcuse();
    expect(typeof excuse).toBe("string");
    expect(excuse.length).toBeGreaterThan(0);
  });
});

describe("randomJoinGreeting", () => {
  it("returns a non-empty string", () => {
    const greeting = randomJoinGreeting();
    expect(typeof greeting).toBe("string");
    expect(greeting.length).toBeGreaterThan(0);
  });
});
