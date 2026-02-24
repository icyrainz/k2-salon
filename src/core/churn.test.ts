import { describe, expect, it, beforeEach, afterEach, jest } from "bun:test";
import { evaluateChurn } from "./churn.js";
import type { AgentConfig, Personality } from "./types.js";

function makeAgent(
  name: string,
  opts: { priority?: number; chattiness?: number } = {},
): AgentConfig {
  return {
    personality: {
      name,
      color: "cyan",
      tagline: "test",
      traits: ["test"],
      style: ["test"],
      bias: "test",
      chattiness: opts.chattiness ?? 0.5,
      contrarianism: 0.3,
    } as Personality,
    provider: "openrouter",
    model: "test/model",
    priority: opts.priority,
  };
}

const phrases = {
  randomLeaveExcuse: () => "gotta go",
  randomJoinGreeting: () => "hey all",
};

describe("evaluateChurn", () => {
  let randomSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    randomSpy = jest.spyOn(Math, "random");
  });

  afterEach(() => {
    randomSpy.mockRestore();
  });

  it("no leave when at minAgents", () => {
    const active = [makeAgent("A"), makeAgent("B"), makeAgent("C")];
    randomSpy.mockReturnValue(0); // force leave to trigger if possible
    const decision = evaluateChurn(
      active,
      [],
      { minAgents: 3, maxAgents: 5 },
      phrases,
    );
    expect(decision.leave).toBeUndefined();
  });

  it("no join when at maxAgents", () => {
    const active = [
      makeAgent("A"),
      makeAgent("B"),
      makeAgent("C"),
      makeAgent("D"),
      makeAgent("E"),
    ];
    const benched = [makeAgent("F")];
    randomSpy.mockReturnValue(0); // force join to trigger if possible
    const decision = evaluateChurn(
      active,
      benched,
      { minAgents: 3, maxAgents: 5 },
      phrases,
    );
    // Leave may happen (bringing us to 4), but even then join check uses activeAfterLeave
    // With 5 active and no leave (all might be evictable), check that join doesn't exceed max
    // Actually with random=0 and 5 active > 3 min, leave will trigger first
    // After leave: 4 active < 5 max, so join can happen
    // But the test should check that when exactly at maxAgents and no leave happens,
    // join shouldn't happen. Let's force no-leave by making all priority
    const activeAllPriority = active.map((a, i) =>
      makeAgent(a.personality.name, { priority: i }),
    );
    const d2 = evaluateChurn(
      activeAllPriority,
      benched,
      { minAgents: 3, maxAgents: 5 },
      phrases,
    );
    // All priority = no evictable agents, so no leave. 5 active = max, so no join.
    expect(d2.join).toBeUndefined();
  });

  it("priority agents never evicted", () => {
    const active = [
      makeAgent("Priority1", { priority: 1 }),
      makeAgent("Priority2", { priority: 2 }),
      makeAgent("Normal", { chattiness: 0 }), // low chattiness = high leave chance
    ];
    randomSpy.mockReturnValue(0); // force leave
    const decision = evaluateChurn(
      active,
      [],
      { minAgents: 2, maxAgents: 5 },
      phrases,
    );
    if (decision.leave) {
      expect(decision.leave.agent.personality.name).toBe("Normal");
    }
  });

  it("leave + join can happen in same turn", () => {
    const active = [
      makeAgent("A", { chattiness: 0 }),
      makeAgent("B"),
      makeAgent("C"),
      makeAgent("D"),
    ];
    const benched = [makeAgent("E")];
    // First random: pick evictable index (0 => A)
    // Second random: leave probability check (0 => triggers, since 0 < 0.25*(1-0))
    // Third random: join probability check (0 => triggers, since 0 < 0.3)
    // Fourth random: pick benched index
    randomSpy.mockReturnValue(0);
    const decision = evaluateChurn(
      active,
      benched,
      { minAgents: 3, maxAgents: 5 },
      phrases,
    );
    expect(decision.leave).toBeDefined();
    expect(decision.join).toBeDefined();
  });

  it("agent who just left excluded from join pool", () => {
    // Only one benched agent, and it's the same one that just got evicted from active
    const leaver = makeAgent("Leaver", { chattiness: 0 });
    const active = [leaver, makeAgent("B"), makeAgent("C"), makeAgent("D")];
    const benched = [makeAgent("Leaver")]; // same name in bench
    randomSpy.mockReturnValue(0);
    const decision = evaluateChurn(
      active,
      benched,
      { minAgents: 3, maxAgents: 5 },
      phrases,
    );
    if (decision.leave && decision.join) {
      expect(decision.join.agent.personality.name).not.toBe(
        decision.leave.agent.personality.name,
      );
    }
    // If leave happened and benched only had Leaver, join should not happen
    if (decision.leave?.agent.personality.name === "Leaver") {
      expect(decision.join).toBeUndefined();
    }
  });

  it("empty benched pool means no join", () => {
    const active = [
      makeAgent("A"),
      makeAgent("B"),
      makeAgent("C"),
      makeAgent("D"),
    ];
    randomSpy.mockReturnValue(0);
    const decision = evaluateChurn(
      active,
      [],
      { minAgents: 3, maxAgents: 5 },
      phrases,
    );
    expect(decision.join).toBeUndefined();
  });

  it("all-priority active pool means no leave", () => {
    const active = [
      makeAgent("A", { priority: 1 }),
      makeAgent("B", { priority: 2 }),
      makeAgent("C", { priority: 3 }),
      makeAgent("D", { priority: 4 }),
    ];
    randomSpy.mockReturnValue(0);
    const decision = evaluateChurn(
      active,
      [makeAgent("E")],
      { minAgents: 3, maxAgents: 5 },
      phrases,
    );
    expect(decision.leave).toBeUndefined();
  });
});
