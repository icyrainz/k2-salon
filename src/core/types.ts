// ── Core types for k2-salon ─────────────────────────────────────────

export type AgentColor =
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
  | "gray" | "redBright" | "greenBright" | "yellowBright" | "blueBright"
  | "magentaBright" | "cyanBright" | "whiteBright";

export type ProviderKind = "openrouter" | "ollama" | "openai-compat";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface CompletionResponse {
  content: string;
  model: string;
}

// ── Personality / Agent ─────────────────────────────────────────────

export interface Personality {
  /** Display name in the chat room, e.g. "Marx" */
  name: string;
  /** Semantic color identifier for this agent */
  color: AgentColor;
  /** Short tagline shown on join, e.g. "Marxist philosopher" */
  tagline: string;
  /** Core traits that shape responses */
  traits: string[];
  /** Communication style directives */
  style: string[];
  /** Perspective / ideological lens */
  bias: string;
  /** How likely (0-1) this agent is to jump into a conversation turn */
  chattiness: number;
  /** How likely (0-1) this agent is to disagree with the previous speaker */
  contrarianism: number;
}

export interface AgentConfig {
  personality: Personality;
  provider: ProviderKind;
  model: string;
  /** The key from salon.yaml providers map, e.g. "zen", "moonshot", "fractal" */
  providerName?: string;
  /** Override the provider's default base URL for this specific agent */
  baseUrl?: string;
  /** Override the provider's API key for this specific agent */
  apiKey?: string;
  /** Override temperature (from provider config; some APIs only allow 1) */
  temperature?: number;
  /**
   * Join priority (lower = higher priority). Priority agents are always
   * placed in the initial active set and are immune to churn eviction.
   * Agents without a priority are treated as lowest priority.
   */
  priority?: number;
}

// ── Room ────────────────────────────────────────────────────────────

export interface RoomMessage {
  id?: number;
  timestamp: Date;
  agent: string; // personality name, or "SYSTEM" / "YOU"
  content: string;
  color: AgentColor;
  kind: "chat" | "join" | "leave" | "system" | "user";
  /** Provider key + model (set on join messages for display) */
  providerLabel?: string;
  modelLabel?: string;
}

export interface RoomConfig {
  /** The debate topic */
  topic: string;
  /** Language agents must use when responding (default: "English") */
  language: string;
  /** Max messages to keep in context window sent to LLMs */
  contextWindow: number;
  /** Max tokens per agent response */
  maxTokens: number;
  /** Base delay in ms between agent turns (adds natural pacing) */
  turnDelayMs: number;
  /** Min number of agents present at any time */
  minAgents: number;
  /** Max number of agents present at any time */
  maxAgents: number;
  /** How often (in turns) to evaluate drop-in/drop-out */
  churnIntervalTurns: number;
}

// ── Salon config (loaded from salon.yaml) ───────────────────────────

export interface ProviderEntry {
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  /** Override temperature for all agents using this provider (some APIs only allow 1) */
  temperature?: number;
}

export interface RosterEntry {
  /** Must match a Personality name from the built-in presets (or define inline) */
  name: string;
  /** Key into the providers map */
  provider: string;
  /** Model identifier to send to the API */
  model: string;
  /** Optional: full inline personality override */
  personality?: Partial<Personality>;
  /**
   * Join priority (lower = higher priority). Priority agents always join
   * first and are immune to churn eviction. Omit for normal behaviour.
   */
  priority?: number;
}

export interface SalonConfig {
  providers: Record<string, ProviderEntry>;
  room: Omit<RoomConfig, "topic">;
  roster: RosterEntry[];
}
