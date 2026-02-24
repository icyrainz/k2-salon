import { describe, expect, it, beforeEach, afterEach, jest } from "bun:test";
import {
  shouldSpeak,
  getSpeakerCandidates,
  peekNextSpeakerCandidates,
} from "./speaker.js";
import type { AgentConfig, Personality } from "./types.js";

function makeAgent(name: string, chattiness: number = 0.5): AgentConfig {
  return {
    personality: {
      name,
      color: "cyan",
      tagline: "test",
      traits: ["test"],
      style: ["test"],
      bias: "test",
      chattiness,
      contrarianism: 0.3,
    } as Personality,
    provider: "openrouter",
    model: "test/model",
  };
}

describe("shouldSpeak", () => {
  let randomSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    randomSpy = jest.spyOn(Math, "random");
  });

  afterEach(() => {
    randomSpy.mockRestore();
  });

  it("returns false when agent is lastSpeaker (no double-speak)", () => {
    const agent = makeAgent("Alice", 1.0); // max chattiness
    randomSpy.mockReturnValue(0); // would always speak otherwise
    expect(shouldSpeak(agent, "Alice", 10)).toBe(false);
  });

  it("recency boost capped at 0.4", () => {
    // With chattiness 0 and turnsSince=100, recency = min(100*0.15, 0.4) = 0.4
    // prob = 0 + 0.4 = 0.4
    const agent = makeAgent("Alice", 0);
    randomSpy.mockReturnValue(0.39); // just below 0.4
    expect(shouldSpeak(agent, null, 100)).toBe(true);

    randomSpy.mockReturnValue(0.41); // just above 0.4
    expect(shouldSpeak(agent, null, 100)).toBe(false);
  });

  it("high chattiness means higher probability", () => {
    const chattyAgent = makeAgent("Chatty", 0.9);
    const quietAgent = makeAgent("Quiet", 0.1);

    // With turnsSince=0, prob = chattiness + 0
    // Chatty: 0.9, Quiet: 0.1
    randomSpy.mockReturnValue(0.5);
    expect(shouldSpeak(chattyAgent, null, 0)).toBe(true);
    expect(shouldSpeak(quietAgent, null, 0)).toBe(false);
  });

  it("returns true when random < probability", () => {
    const agent = makeAgent("Alice", 0.7); // prob = 0.7 + boost
    randomSpy.mockReturnValue(0.1);
    expect(shouldSpeak(agent, null, 0)).toBe(true);
  });

  it("returns false when random >= probability", () => {
    const agent = makeAgent("Alice", 0.3);
    randomSpy.mockReturnValue(0.95);
    expect(shouldSpeak(agent, null, 0)).toBe(false);
  });
});

describe("getSpeakerCandidates", () => {
  let randomSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    randomSpy = jest.spyOn(Math, "random");
  });

  afterEach(() => {
    randomSpy.mockRestore();
  });

  it("excludes lastSpeaker from candidates", () => {
    const agents = [makeAgent("Alice", 1.0), makeAgent("Bob", 1.0)];
    randomSpy.mockReturnValue(0); // everyone "wants" to speak
    const turns = new Map([
      ["Alice", 2],
      ["Bob", 2],
    ]);
    const candidates = getSpeakerCandidates(agents, "Alice", turns);
    expect(candidates.map((a) => a.personality.name)).not.toContain("Alice");
    expect(candidates.map((a) => a.personality.name)).toContain("Bob");
  });

  it("falls back to longest-silent agent when no candidates", () => {
    // All agents have very low chattiness, so no one volunteers
    const agents = [makeAgent("Alice", 0), makeAgent("Bob", 0)];
    randomSpy.mockReturnValue(0.99); // nobody speaks
    const turns = new Map([
      ["Alice", 5],
      ["Bob", 10],
    ]);
    const candidates = getSpeakerCandidates(agents, null, turns);
    // Bob has been silent longest (10 turns)
    expect(candidates).toHaveLength(1);
    expect(candidates[0].personality.name).toBe("Bob");
  });

  it("returns empty for empty input", () => {
    const candidates = getSpeakerCandidates([], null, new Map());
    expect(candidates).toHaveLength(0);
  });
});

describe("peekNextSpeakerCandidates", () => {
  it("is deterministic (no random roll)", () => {
    const agents = [makeAgent("Alice", 0.5), makeAgent("Bob", 0.5)];
    const turns = new Map([
      ["Alice", 2],
      ["Bob", 2],
    ]);
    const result1 = peekNextSpeakerCandidates(agents, null, turns);
    const result2 = peekNextSpeakerCandidates(agents, null, turns);
    expect(result1.map((a) => a.personality.name)).toEqual(
      result2.map((a) => a.personality.name),
    );
  });

  it("excludes lastSpeaker", () => {
    const agents = [makeAgent("Alice"), makeAgent("Bob")];
    const turns = new Map([
      ["Alice", 2],
      ["Bob", 2],
    ]);
    const candidates = peekNextSpeakerCandidates(agents, "Alice", turns);
    expect(candidates.map((a) => a.personality.name)).not.toContain("Alice");
  });

  it("includes agents with turnsSince >= 1", () => {
    const agents = [makeAgent("Alice"), makeAgent("Bob")];
    const turns = new Map([
      ["Alice", 1],
      ["Bob", 0],
    ]);
    const candidates = peekNextSpeakerCandidates(agents, null, turns);
    expect(candidates.map((a) => a.personality.name)).toContain("Alice");
    expect(candidates.map((a) => a.personality.name)).not.toContain("Bob");
  });

  it("falls back when no candidates meet threshold", () => {
    const agents = [makeAgent("Alice"), makeAgent("Bob")];
    const turns = new Map([
      ["Alice", 0],
      ["Bob", 0],
    ]);
    // Both have 0 turns since spoke, neither meets >= 1 threshold
    // Fallback: first agent that isn't lastSpeaker
    const candidates = peekNextSpeakerCandidates(agents, "Alice", turns);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].personality.name).toBe("Bob");
  });
});
