import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  normalizeColor,
  resolveEnvVars,
  isFullPersonality,
  resolveRoster,
  loadConfig,
  DEFAULT_CONFIG,
} from "./config.js";
import { PERSONALITY_PRESETS } from "../core/roster.js";
import type { AgentConfig, Personality, SalonConfig } from "../core/types.js";

describe("normalizeColor", () => {
  it("maps ANSI codes to semantic AgentColor", () => {
    expect(normalizeColor("\x1b[36m")).toBe("cyan");
    expect(normalizeColor("\x1b[31m")).toBe("red");
    expect(normalizeColor("\x1b[92m")).toBe("greenBright");
    expect(normalizeColor("\x1b[90m")).toBe("gray");
  });

  it("passes through already-semantic names", () => {
    expect(normalizeColor("cyan")).toBe("cyan");
    expect(normalizeColor("redBright")).toBe("redBright");
    expect(normalizeColor("magenta")).toBe("magenta");
  });
});

describe("resolveEnvVars", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TEST_VAR = "hello";
    process.env.ANOTHER_VAR = "world";
  });

  afterEach(() => {
    delete process.env.TEST_VAR;
    delete process.env.ANOTHER_VAR;
  });

  it("replaces ${VAR} with env values", () => {
    expect(resolveEnvVars("${TEST_VAR}")).toBe("hello");
    expect(resolveEnvVars("prefix-${TEST_VAR}-suffix")).toBe(
      "prefix-hello-suffix",
    );
  });

  it("keeps literal ${VAR} when env var missing", () => {
    expect(resolveEnvVars("${NONEXISTENT_VAR_12345}")).toBe(
      "${NONEXISTENT_VAR_12345}",
    );
  });

  it("handles nested objects and arrays", () => {
    const input = {
      key: "${TEST_VAR}",
      nested: { deep: "${ANOTHER_VAR}" },
      list: ["${TEST_VAR}", "literal"],
    };
    const result = resolveEnvVars(input);
    expect(result.key).toBe("hello");
    expect(result.nested.deep).toBe("world");
    expect(result.list).toEqual(["hello", "literal"]);
  });

  it("passes through non-string values unchanged", () => {
    expect(resolveEnvVars(42)).toBe(42);
    expect(resolveEnvVars(true)).toBe(true);
    expect(resolveEnvVars(null)).toBe(null);
  });
});

describe("isFullPersonality", () => {
  const full: Personality = {
    name: "Test",
    color: "cyan",
    tagline: "A test agent",
    traits: ["smart"],
    style: ["concise"],
    bias: "neutral",
    chattiness: 0.5,
    contrarianism: 0.3,
  };

  it("validates required fields", () => {
    expect(isFullPersonality(full)).toBe(true);
  });

  it("rejects partial personality (missing name)", () => {
    const { name, ...partial } = full;
    expect(isFullPersonality(partial)).toBe(false);
  });

  it("rejects partial personality (missing traits)", () => {
    const { traits, ...partial } = full;
    expect(isFullPersonality(partial)).toBe(false);
  });

  it("rejects empty traits array", () => {
    expect(isFullPersonality({ ...full, traits: [] })).toBe(false);
  });

  it("rejects missing chattiness", () => {
    const { chattiness, ...partial } = full;
    expect(isFullPersonality(partial)).toBe(false);
  });
});

describe("resolveRoster", () => {
  const minConfig = (roster: SalonConfig["roster"]): SalonConfig => ({
    providers: {
      testprov: {
        kind: "openrouter",
        baseUrl: "https://example.com",
      },
    },
    room: DEFAULT_CONFIG.room,
    roster,
  });

  it("returns presets when roster is empty", () => {
    const result = resolveRoster(minConfig([]), PERSONALITY_PRESETS);
    expect(result).toEqual(PERSONALITY_PRESETS);
  });

  it("matches preset names case-insensitively", () => {
    const config = minConfig([
      { name: "sage", provider: "testprov", model: "m1" },
    ]);
    const result = resolveRoster(config, PERSONALITY_PRESETS);
    expect(result).toHaveLength(1);
    expect(result[0].personality.name).toBe("Sage");
  });

  it("merges partial personality overrides", () => {
    const config = minConfig([
      {
        name: "Sage",
        provider: "testprov",
        model: "m1",
        personality: { tagline: "Overridden tagline" },
      },
    ]);
    const result = resolveRoster(config, PERSONALITY_PRESETS);
    expect(result[0].personality.tagline).toBe("Overridden tagline");
    // Original fields preserved
    expect(result[0].personality.name).toBe("Sage");
    expect(result[0].personality.traits.length).toBeGreaterThan(0);
  });

  it("accepts full inline personality", () => {
    const config = minConfig([
      {
        name: "Custom",
        provider: "testprov",
        model: "m1",
        personality: {
          name: "Custom",
          color: "red",
          tagline: "A custom agent",
          traits: ["bold"],
          style: ["direct"],
          bias: "none",
          chattiness: 0.6,
          contrarianism: 0.4,
        },
      },
    ]);
    const result = resolveRoster(config, PERSONALITY_PRESETS);
    expect(result).toHaveLength(1);
    expect(result[0].personality.name).toBe("Custom");
  });

  it("throws on unknown provider", () => {
    const config = minConfig([
      { name: "Sage", provider: "nonexistent", model: "m1" },
    ]);
    expect(() => resolveRoster(config, PERSONALITY_PRESETS)).toThrow(
      "not found",
    );
  });

  it("throws on unknown name without full personality", () => {
    const config = minConfig([
      { name: "Unknown", provider: "testprov", model: "m1" },
    ]);
    expect(() => resolveRoster(config, PERSONALITY_PRESETS)).toThrow(
      "no matching preset",
    );
  });

  it("normalizes ANSI colors in resolved roster", () => {
    const config = minConfig([
      {
        name: "Ansi",
        provider: "testprov",
        model: "m1",
        personality: {
          name: "Ansi",
          color: "\x1b[36m" as any,
          tagline: "ANSI colored",
          traits: ["test"],
          style: ["test"],
          bias: "test",
          chattiness: 0.5,
          contrarianism: 0.3,
        },
      },
    ]);
    const result = resolveRoster(config, PERSONALITY_PRESETS);
    expect(result[0].personality.color).toBe("cyan");
  });

  it("passes through priority from roster entry", () => {
    const config = minConfig([
      { name: "Sage", provider: "testprov", model: "m1", priority: 1 },
    ]);
    const result = resolveRoster(config, PERSONALITY_PRESETS);
    expect(result[0].priority).toBe(1);
  });
});

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(
      tmpdir(),
      `k2-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns DEFAULT_CONFIG when file missing", async () => {
    const config = await loadConfig(join(tmpDir, "nonexistent.yaml"));
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("loads and merges valid salon.yaml", async () => {
    const yamlContent = `
providers:
  local:
    kind: ollama
    baseUrl: http://localhost:11434
room:
  contextWindow: 50
  maxTokens: 2048
roster: []
`;
    const path = join(tmpDir, "salon.yaml");
    await writeFile(path, yamlContent);
    const config = await loadConfig(path);
    expect(config.providers.local.kind).toBe("ollama");
    expect(config.room.contextWindow).toBe(50);
    expect(config.room.maxTokens).toBe(2048);
    // Defaults preserved for unspecified fields
    expect(config.room.turnDelayMs).toBe(DEFAULT_CONFIG.room.turnDelayMs);
  });

  it("throws on invalid provider reference in roster", async () => {
    const yamlContent = `
providers:
  local:
    kind: ollama
    baseUrl: http://localhost:11434
roster:
  - name: Sage
    provider: nonexistent
    model: test
`;
    const path = join(tmpDir, "salon.yaml");
    await writeFile(path, yamlContent);
    await expect(loadConfig(path)).rejects.toThrow("unknown provider");
  });
});
