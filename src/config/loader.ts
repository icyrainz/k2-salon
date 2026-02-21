import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import type {
  AgentConfig,
  Personality,
  ProviderEntry,
  RosterEntry,
  SalonConfig,
} from "../types.js";

// ── Default config (used when salon.yaml is absent) ─────────────────

export const DEFAULT_CONFIG: SalonConfig = {
  providers: {
    openrouter: {
      kind: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    },
  },
  room: {
    contextWindow: 30,
    maxTokens: 512,
    turnDelayMs: 800,
    minAgents: 3,
    maxAgents: 5,
    churnIntervalTurns: 4,
  },
  roster: [],
};

// ── Load config from salon.yaml ─────────────────────────────────────

export async function loadConfig(configPath?: string): Promise<SalonConfig> {
  const path = configPath ?? join(process.cwd(), "salon.yaml");

  if (!existsSync(path)) {
    return DEFAULT_CONFIG;
  }

  const raw = await readFile(path, "utf-8");
  const parsed = parse(raw);

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid salon.yaml: expected an object, got ${typeof parsed}`);
  }

  // Resolve ${ENV_VAR} patterns in all string values
  const resolved = resolveEnvVars(parsed);

  const config: SalonConfig = {
    providers: resolved.providers ?? DEFAULT_CONFIG.providers,
    room: { ...DEFAULT_CONFIG.room, ...resolved.room },
    roster: resolved.roster ?? [],
  };

  // Validate: every roster entry must reference a known provider
  for (const entry of config.roster) {
    if (!config.providers[entry.provider]) {
      const known = Object.keys(config.providers).join(", ");
      throw new Error(
        `Roster entry "${entry.name}" references unknown provider "${entry.provider}". ` +
        `Known providers: ${known}`,
      );
    }
  }

  return config;
}

// ── Resolve roster entries against personality presets ───────────────

export function resolveRoster(
  config: SalonConfig,
  presets: AgentConfig[],
): AgentConfig[] {
  // If roster is empty, return all presets as-is (fallback mode)
  if (config.roster.length === 0) {
    return presets;
  }

  const presetMap = new Map<string, AgentConfig>();
  for (const p of presets) {
    presetMap.set(p.personality.name.toLowerCase(), p);
  }

  const agents: AgentConfig[] = [];

  for (const entry of config.roster) {
    const preset = presetMap.get(entry.name.toLowerCase());
    const providerEntry = config.providers[entry.provider];

    if (!providerEntry) {
      throw new Error(
        `Roster "${entry.name}": provider "${entry.provider}" not found in config.`,
      );
    }

    let personality: Personality;

    if (preset) {
      // Merge preset personality with any inline overrides
      personality = entry.personality
        ? { ...preset.personality, ...entry.personality }
        : preset.personality;
    } else if (entry.personality && isFullPersonality(entry.personality)) {
      // Fully inline personality (no matching preset)
      personality = entry.personality as Personality;
    } else {
      throw new Error(
        `Roster entry "${entry.name}" has no matching preset and no complete inline personality. ` +
        `Available presets: ${presets.map(p => p.personality.name).join(", ")}`,
      );
    }

    agents.push({
      personality,
      provider: providerEntry.kind,
      model: entry.model,
      providerName: entry.provider,
      baseUrl: providerEntry.baseUrl,
      apiKey: providerEntry.apiKey,
      temperature: providerEntry.temperature,
    });
  }

  return agents;
}

// ── Check if an inline personality has all required fields ──────────

function isFullPersonality(p: Partial<Personality>): p is Personality {
  return !!(
    p.name &&
    p.color &&
    p.tagline &&
    p.traits?.length &&
    p.style?.length &&
    p.bias &&
    typeof p.chattiness === "number" &&
    typeof p.contrarianism === "number"
  );
}

// ── Recursively resolve ${ENV_VAR} in all string values ─────────────

function resolveEnvVars(obj: any): any {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      return process.env[varName] ?? `\${${varName}}`;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value);
    }
    return result;
  }

  return obj;
}
