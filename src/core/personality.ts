import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type {
  AgentConfig,
  ChatMessage,
  Personality,
  RoomMessage,
} from "./types.js";

// ── Load prompt templates at import time ──────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "../../prompts");

const SYSTEM_TEMPLATE = readFileSync(join(PROMPTS_DIR, "system.md"), "utf-8");
const VERBOSE_RULES = readFileSync(
  join(PROMPTS_DIR, "rules-verbose.md"),
  "utf-8",
);
const CONCISE_RULES = readFileSync(
  join(PROMPTS_DIR, "rules-concise.md"),
  "utf-8",
);

// ── Build the system prompt for an agent given their personality ────

export function buildSystemPrompt(
  p: Personality,
  topic: string,
  verbose: boolean,
  language: string = "English",
): string {
  return SYSTEM_TEMPLATE.replace(/\{\{name\}\}/g, p.name)
    .replace("{{tagline}}", p.tagline)
    .replace("{{traits}}", p.traits.join(", "))
    .replace("{{style}}", p.style.join(". "))
    .replace("{{bias}}", p.bias)
    .replace("{{topic}}", topic)
    .replace("{{language}}", language)
    .replace("{{lengthRules}}", verbose ? VERBOSE_RULES : CONCISE_RULES);
}

// ── Convert room history to ChatMessage format for an agent ─────────

export function buildMessages(
  agent: AgentConfig,
  topic: string,
  history: RoomMessage[],
  contextWindow: number,
  verbose: boolean = false,
  language: string = "English",
): ChatMessage[] {
  const system = buildSystemPrompt(agent.personality, topic, verbose, language);
  const messages: ChatMessage[] = [{ role: "system", content: system }];

  // Take the last N messages from history
  const recent = history.slice(-contextWindow);

  for (const msg of recent) {
    if (msg.kind === "user") {
      messages.push({ role: "user", content: `[HOST]: ${msg.content}` });
    } else if (msg.kind === "join") {
      messages.push({
        role: "user",
        content: `* ${msg.agent} has joined the room — ${msg.content}`,
      });
    } else if (msg.kind === "leave") {
      messages.push({
        role: "user",
        content: `* ${msg.agent} has left the room — ${msg.content}`,
      });
    } else if (msg.kind === "system") {
      messages.push({ role: "user", content: `[SYSTEM]: ${msg.content}` });
    } else if (msg.agent === agent.personality.name) {
      messages.push({ role: "assistant", content: msg.content });
    } else {
      messages.push({
        role: "user",
        content: `[${msg.agent}]: ${msg.content}`,
      });
    }
  }

  return messages;
}
