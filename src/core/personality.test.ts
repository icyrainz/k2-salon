import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildSystemPrompt, buildMessages } from "./personality.js";
import type { AgentConfig, Personality, RoomMessage } from "./types.js";

const testPersonality: Personality = {
  name: "TestBot",
  color: "cyan",
  tagline: "A test personality",
  traits: ["logical", "precise"],
  style: ["Speaks concisely", "Uses examples"],
  bias: "Believes in testing everything.",
  chattiness: 0.7,
  contrarianism: 0.3,
};

const testAgent: AgentConfig = {
  personality: testPersonality,
  provider: "openrouter",
  model: "test/model",
};

function makeMsg(
  overrides: Partial<RoomMessage> &
    Pick<RoomMessage, "kind" | "agent" | "content">,
): RoomMessage {
  return {
    timestamp: new Date(),
    color: "white",
    ...overrides,
  };
}

describe("prompt templates", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const promptsDir = join(__dirname, "../../prompts");

  it("system.md exists and is non-empty", () => {
    const content = readFileSync(join(promptsDir, "system.md"), "utf-8");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("{{name}}");
  });

  it("rules-verbose.md exists and is non-empty", () => {
    const content = readFileSync(join(promptsDir, "rules-verbose.md"), "utf-8");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("2-4 paragraphs");
  });

  it("rules-concise.md exists and is non-empty", () => {
    const content = readFileSync(join(promptsDir, "rules-concise.md"), "utf-8");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("2-4 sentences MAX");
  });
});

describe("buildSystemPrompt", () => {
  it("includes agent name and tagline", () => {
    const prompt = buildSystemPrompt(testPersonality, "test topic", false);
    expect(prompt).toContain('"TestBot"');
    expect(prompt).toContain("A test personality");
  });

  it("includes traits", () => {
    const prompt = buildSystemPrompt(testPersonality, "test topic", false);
    expect(prompt).toContain("logical");
    expect(prompt).toContain("precise");
  });

  it("includes bias", () => {
    const prompt = buildSystemPrompt(testPersonality, "test topic", false);
    expect(prompt).toContain("Believes in testing everything.");
  });

  it("includes topic", () => {
    const prompt = buildSystemPrompt(testPersonality, "AI safety", false);
    expect(prompt).toContain("AI safety");
  });

  it("verbose=false includes short length rules", () => {
    const prompt = buildSystemPrompt(testPersonality, "topic", false);
    expect(prompt).toContain("2-4 sentences MAX");
    expect(prompt).not.toContain("2-4 paragraphs");
  });

  it("verbose=true includes long length rules", () => {
    const prompt = buildSystemPrompt(testPersonality, "topic", true);
    expect(prompt).toContain("2-4 paragraphs");
    expect(prompt).not.toContain("2-4 sentences MAX");
  });

  it("respects language parameter", () => {
    const prompt = buildSystemPrompt(
      testPersonality,
      "topic",
      false,
      "Japanese",
    );
    expect(prompt).toContain("Japanese");
  });

  it("defaults to English when no language specified", () => {
    const prompt = buildSystemPrompt(testPersonality, "topic", false);
    expect(prompt).toContain("English");
  });

  it("includes anti-academic guardrails", () => {
    const prompt = buildSystemPrompt(testPersonality, "topic", false);
    expect(prompt).toContain("AVOID academic jargon");
    expect(prompt).toContain("GROUND your points");
  });

  it("includes conversational tone rules", () => {
    const prompt = buildSystemPrompt(testPersonality, "topic", false);
    expect(prompt).toContain("like a real person talking");
    expect(prompt).toContain("TONE");
  });
});

describe("buildMessages", () => {
  it("returns system prompt as first message", () => {
    const msgs = buildMessages(testAgent, "topic", [], 30);
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("TestBot");
  });

  it("converts agent's own messages to role=assistant", () => {
    const history: RoomMessage[] = [
      makeMsg({ kind: "chat", agent: "TestBot", content: "Hello world" }),
    ];
    const msgs = buildMessages(testAgent, "topic", history, 30);
    const chat = msgs.find((m) => m.role === "assistant");
    expect(chat).toBeDefined();
    expect(chat!.content).toBe("Hello world");
  });

  it("converts other agents' messages to role=user with [NAME] prefix", () => {
    const history: RoomMessage[] = [
      makeMsg({
        kind: "chat",
        agent: "OtherBot",
        content: "Interesting point",
      }),
    ];
    const msgs = buildMessages(testAgent, "topic", history, 30);
    const chat = msgs.find((m) => m.content.includes("[OtherBot]"));
    expect(chat).toBeDefined();
    expect(chat!.role).toBe("user");
    expect(chat!.content).toBe("[OtherBot]: Interesting point");
  });

  it("converts user messages with [HOST] prefix", () => {
    const history: RoomMessage[] = [
      makeMsg({ kind: "user", agent: "YOU", content: "What do you think?" }),
    ];
    const msgs = buildMessages(testAgent, "topic", history, 30);
    const user = msgs.find((m) => m.content.includes("[HOST]"));
    expect(user).toBeDefined();
    expect(user!.role).toBe("user");
  });

  it("converts join messages correctly", () => {
    const history: RoomMessage[] = [
      makeMsg({ kind: "join", agent: "NewBot", content: "A new bot" }),
    ];
    const msgs = buildMessages(testAgent, "topic", history, 30);
    const join = msgs.find((m) => m.content.includes("has joined"));
    expect(join).toBeDefined();
    expect(join!.role).toBe("user");
    expect(join!.content).toContain("NewBot");
  });

  it("converts leave messages correctly", () => {
    const history: RoomMessage[] = [
      makeMsg({ kind: "leave", agent: "LeavingBot", content: "gotta go" }),
    ];
    const msgs = buildMessages(testAgent, "topic", history, 30);
    const leave = msgs.find((m) => m.content.includes("has left"));
    expect(leave).toBeDefined();
    expect(leave!.role).toBe("user");
    expect(leave!.content).toContain("LeavingBot");
  });

  it("converts system messages correctly", () => {
    const history: RoomMessage[] = [
      makeMsg({ kind: "system", agent: "SYSTEM", content: "Topic: AI" }),
    ];
    const msgs = buildMessages(testAgent, "topic", history, 30);
    const sys = msgs.find((m) => m.content.includes("[SYSTEM]"));
    expect(sys).toBeDefined();
    expect(sys!.role).toBe("user");
  });

  it("respects contextWindow (slices last N messages)", () => {
    const history: RoomMessage[] = Array.from({ length: 10 }, (_, i) =>
      makeMsg({ kind: "chat", agent: "OtherBot", content: `Message ${i}` }),
    );
    const msgs = buildMessages(testAgent, "topic", history, 3);
    // 1 system + 3 history messages
    expect(msgs).toHaveLength(4);
    expect(msgs[1].content).toContain("Message 7");
    expect(msgs[3].content).toContain("Message 9");
  });
});
