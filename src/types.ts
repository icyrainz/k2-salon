// ── Core types for k2-salon ─────────────────────────────────────────

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
  /** ANSI color code index (0-7 for standard, 8-15 for bright) */
  color: string;
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
  /** Override the provider's default base URL for this specific agent */
  baseUrl?: string;
  /** Override the provider's API key for this specific agent */
  apiKey?: string;
}

// ── Room ────────────────────────────────────────────────────────────

export interface RoomMessage {
  timestamp: Date;
  agent: string; // personality name, or "SYSTEM" / "YOU"
  content: string;
  color: string;
  kind: "chat" | "join" | "leave" | "system" | "user";
  /** Provider key + model (set on join messages for display) */
  providerLabel?: string;
  modelLabel?: string;
}

export interface RoomConfig {
  /** The debate topic */
  topic: string;
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
}

export interface SalonConfig {
  providers: Record<string, ProviderEntry>;
  room: Omit<RoomConfig, "topic">;
  roster: RosterEntry[];
}
