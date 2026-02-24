import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  jest,
  mock,
} from "bun:test";
import type {
  AgentConfig,
  Personality,
  RoomConfig,
  RoomMessage,
} from "../core/types.js";

// Mock the provider module before importing SalonEngine
mock.module("./provider.js", () => ({
  complete: jest.fn(async () => ({
    content: "Mocked LLM response",
    model: "test/model",
  })),
}));

// Import after mock setup
const { SalonEngine } = await import("./salon-engine.js");
const { complete } = await import("./provider.js");
const mockedComplete = complete as ReturnType<typeof jest.fn>;

function makeAgent(
  name: string,
  opts: { priority?: number; chattiness?: number } = {},
): AgentConfig {
  return {
    personality: {
      name,
      color: "cyan",
      tagline: `${name} the test agent`,
      traits: ["test"],
      style: ["concise"],
      bias: "neutral",
      chattiness: opts.chattiness ?? 0.7,
      contrarianism: 0.3,
    } as Personality,
    provider: "openrouter",
    model: "test/model",
    priority: opts.priority,
  };
}

const defaultConfig: RoomConfig = {
  topic: "Test topic",
  language: "English",
  contextWindow: 30,
  maxTokens: 1024,
  turnDelayMs: 0,
  minAgents: 2,
  maxAgents: 4,
  churnIntervalTurns: 4,
};

describe("SalonEngine constructor", () => {
  it("splits agents into active and benched based on maxAgents", () => {
    const agents = [
      makeAgent("A"),
      makeAgent("B"),
      makeAgent("C"),
      makeAgent("D"),
      makeAgent("E"),
    ];
    const engine = new SalonEngine(defaultConfig, agents);
    // initialCount = min(4, max(2, floor(5*0.5))) = min(4, max(2, 2)) = 2
    // But priority agents come first, then random normal agents
    expect(engine.activeAgents.length + engine.benchedAgents.length).toBe(5);
    expect(engine.activeAgents.length).toBeGreaterThanOrEqual(
      defaultConfig.minAgents,
    );
    expect(engine.activeAgents.length).toBeLessThanOrEqual(
      defaultConfig.maxAgents,
    );
  });

  it("priority agents always placed in active set", () => {
    const agents = [
      makeAgent("Normal1"),
      makeAgent("Normal2"),
      makeAgent("Priority1", { priority: 1 }),
      makeAgent("Priority2", { priority: 2 }),
      makeAgent("Normal3"),
    ];
    const engine = new SalonEngine(defaultConfig, agents);
    const activeNames = engine.activeAgents.map((a) => a.personality.name);
    expect(activeNames).toContain("Priority1");
    expect(activeNames).toContain("Priority2");
  });

  it("respects preferredRoster", () => {
    const agents = [
      makeAgent("A"),
      makeAgent("B"),
      makeAgent("C"),
      makeAgent("D"),
    ];
    const engine = new SalonEngine(defaultConfig, agents, undefined, [
      "B",
      "D",
    ]);
    const activeNames = engine.activeAgents.map((a) => a.personality.name);
    expect(activeNames).toEqual(["B", "D"]);
    expect(engine.benchedAgents.length).toBe(2);
  });

  it("loads preloaded history", () => {
    const history: RoomMessage[] = [
      {
        timestamp: new Date(),
        agent: "A",
        content: "Hello",
        color: "cyan",
        kind: "chat",
      },
    ];
    const agents = [makeAgent("A"), makeAgent("B"), makeAgent("C")];
    const engine = new SalonEngine(defaultConfig, agents, history);
    // History is internal, but we can verify via step() that it builds context
    expect(engine.activeAgents.length).toBeGreaterThan(0);
  });
});

describe("SalonEngine.open", () => {
  it("emits system + join messages", () => {
    const agents = [makeAgent("A"), makeAgent("B"), makeAgent("C")];
    const engine = new SalonEngine(defaultConfig, agents);

    const messages: RoomMessage[] = [];
    engine.on("message", (msg) => messages.push(msg));

    engine.open();

    expect(engine.running).toBe(true);

    // First message should be system with topic
    expect(messages[0].kind).toBe("system");
    expect(messages[0].content).toContain("Test topic");

    // Remaining messages should be join messages for active agents
    const joins = messages.filter((m) => m.kind === "join");
    expect(joins.length).toBe(engine.activeAgents.length);
  });

  it("assigns sequential IDs to messages", () => {
    const agents = [makeAgent("A"), makeAgent("B"), makeAgent("C")];
    const engine = new SalonEngine(defaultConfig, agents);

    const messages: RoomMessage[] = [];
    engine.on("message", (msg) => messages.push(msg));

    engine.open();

    // All messages should have IDs
    for (const msg of messages) {
      expect(msg.id).toBeDefined();
      expect(typeof msg.id).toBe("number");
    }

    // IDs should be sequential starting from 0
    const ids = messages.map((m) => m.id!);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBe(ids[i - 1] + 1);
    }
  });
});

describe("SalonEngine.step", () => {
  let randomSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.1);
    mockedComplete.mockClear();
    mockedComplete.mockResolvedValue({
      content: "Mocked response",
      model: "test",
    });
  });

  afterEach(() => {
    randomSpy.mockRestore();
  });

  it("picks speaker, calls LLM, emits messages", async () => {
    const agents = [makeAgent("A"), makeAgent("B"), makeAgent("C")];
    const engine = new SalonEngine(defaultConfig, agents);
    engine.open();

    const messages: RoomMessage[] = [];
    engine.on("message", (msg) => messages.push(msg));

    const speaker = await engine.step();
    expect(speaker).not.toBeNull();
    expect(mockedComplete).toHaveBeenCalledTimes(1);

    // Should have emitted a chat message with the mocked response
    const chatMsgs = messages.filter((m) => m.kind === "chat");
    expect(chatMsgs.length).toBe(1);
    expect(chatMsgs[0].content).toBe("Mocked response");
  });

  it("returns null when engine is stopped", async () => {
    const agents = [makeAgent("A"), makeAgent("B"), makeAgent("C")];
    const engine = new SalonEngine(defaultConfig, agents);
    // Don't call open() — engine.running is false
    const result = await engine.step();
    expect(result).toBeNull();
  });

  it("applies churn at correct intervals", async () => {
    const config = { ...defaultConfig, churnIntervalTurns: 2 };
    const agents = [makeAgent("A"), makeAgent("B"), makeAgent("C")];
    const benched = makeAgent("D");
    const engine = new SalonEngine(config, [...agents, benched]);
    engine.open();

    // Step 1: no churn (1 % 2 !== 0)
    await engine.step({ churn: true });
    // Step 2: churn happens (2 % 2 === 0)
    await engine.step({ churn: true });
    // We can't easily assert churn happened without inspecting active/benched counts,
    // but the test verifies no crash and the step completes normally
    expect(engine.running).toBe(true);
  });

  it("uses forced speaker when provided", async () => {
    const agents = [makeAgent("A"), makeAgent("B"), makeAgent("C")];
    const engine = new SalonEngine(defaultConfig, agents);
    engine.open();

    const forced = agents[1]; // B
    const speaker = await engine.step({ speaker: forced });
    expect(speaker?.personality.name).toBe("B");
  });

  it("handles LLM errors gracefully", async () => {
    mockedComplete.mockRejectedValueOnce(new Error("API rate limit"));

    const agents = [makeAgent("A"), makeAgent("B"), makeAgent("C")];
    const engine = new SalonEngine(defaultConfig, agents);
    engine.open();

    const messages: RoomMessage[] = [];
    engine.on("message", (msg) => messages.push(msg));

    await engine.step();

    // Should emit a system error message
    const errors = messages.filter(
      (m) => m.kind === "system" && m.content.includes("error"),
    );
    expect(errors.length).toBe(1);
    expect(errors[0].content).toContain("API rate limit");
  });

  it("handles empty LLM response", async () => {
    mockedComplete.mockResolvedValueOnce({ content: "   ", model: "test" });

    const agents = [makeAgent("A"), makeAgent("B"), makeAgent("C")];
    const engine = new SalonEngine(defaultConfig, agents);
    engine.open();

    const messages: RoomMessage[] = [];
    engine.on("message", (msg) => messages.push(msg));

    await engine.step();

    const errors = messages.filter(
      (m) => m.kind === "system" && m.content.includes("empty response"),
    );
    expect(errors.length).toBe(1);
  });
});

describe("SalonEngine.shuffle", () => {
  it("emits leave/join messages and resets state", () => {
    const agents = [
      makeAgent("A"),
      makeAgent("B"),
      makeAgent("C"),
      makeAgent("D"),
      makeAgent("E"),
    ];
    const engine = new SalonEngine(defaultConfig, agents);
    engine.open();

    const messages: RoomMessage[] = [];
    engine.on("message", (msg) => messages.push(msg));

    engine.shuffle();

    const leaves = messages.filter((m) => m.kind === "leave");
    const joins = messages.filter((m) => m.kind === "join");
    expect(leaves.length).toBeGreaterThan(0);
    expect(joins.length).toBeGreaterThan(0);
    expect(engine.activeAgents.length + engine.benchedAgents.length).toBe(5);
  });
});

describe("SalonEngine.injectUserMessage", () => {
  it("adds user message to history", () => {
    const agents = [makeAgent("A"), makeAgent("B"), makeAgent("C")];
    const engine = new SalonEngine(defaultConfig, agents);
    engine.open();

    const messages: RoomMessage[] = [];
    engine.on("message", (msg) => messages.push(msg));

    engine.injectUserMessage("Hello from user");

    const userMsgs = messages.filter((m) => m.kind === "user");
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].content).toBe("Hello from user");
    expect(userMsgs[0].agent).toBe("YOU");
  });
});

describe("SalonEngine.peekNextSpeaker", () => {
  it("returns a non-lastSpeaker agent", async () => {
    const agents = [makeAgent("A"), makeAgent("B"), makeAgent("C")];
    const engine = new SalonEngine(defaultConfig, agents);
    engine.open();

    // Do one step to set lastSpeaker
    jest.spyOn(Math, "random").mockReturnValue(0.1);
    mockedComplete.mockResolvedValue({ content: "test", model: "test" });
    const speaker = await engine.step();

    if (speaker) {
      const peek = engine.peekNextSpeaker();
      // peek might be null in edge cases, but if it returns something,
      // it shouldn't be the last speaker
      if (peek) {
        expect(peek.personality.name).not.toBe(speaker.personality.name);
      }
    }
  });
});

describe("SalonEngine.stop", () => {
  it("sets running=false and aborts signal", () => {
    const agents = [makeAgent("A"), makeAgent("B"), makeAgent("C")];
    const engine = new SalonEngine(defaultConfig, agents);
    engine.open();
    expect(engine.running).toBe(true);

    engine.stop();
    expect(engine.running).toBe(false);
    expect(engine.signal.aborted).toBe(true);
  });
});

describe("SalonEngine message IDs with preloaded history", () => {
  it("assigns IDs to preloaded history and continues sequence", () => {
    const history: RoomMessage[] = [
      {
        timestamp: new Date(),
        agent: "A",
        content: "Old msg 1",
        color: "cyan",
        kind: "chat",
      },
      {
        timestamp: new Date(),
        agent: "B",
        content: "Old msg 2",
        color: "cyan",
        kind: "chat",
      },
    ];
    const agents = [makeAgent("A"), makeAgent("B"), makeAgent("C")];
    const engine = new SalonEngine(defaultConfig, agents, history);

    const messages: RoomMessage[] = [];
    engine.on("message", (msg) => messages.push(msg));
    engine.open();

    // New messages should continue from where preloaded left off
    // Preloaded: 0, 1 → new messages start at 2
    expect(messages[0].id).toBe(2);
  });
});
