import type { AgentConfig, ChatMessage, Personality, RoomMessage } from "../types.js";

// ── Build the system prompt for an agent given their personality ────

export function buildSystemPrompt(p: Personality, topic: string, governed: boolean): string {
  const lengthRules = governed
    ? [
        `- LENGTH: Write 2-4 thorough paragraphs. Each turn is your chance to develop a real argument.`,
        `- Go deep — explain your reasoning, give examples, anticipate counterarguments.`,
        `- You may use paragraph breaks to structure your thinking, but NO bullet points or headers.`,
        `- Write like you're making a considered point in a seminar, not firing off a tweet.`,
      ]
    : [
        `- LENGTH: 2-4 sentences MAX. This is a fast-moving chat room, not a blog post.`,
        `- Write like you're texting in a group chat — short, punchy, conversational.`,
        `- NEVER write bullet points, numbered lists, or markdown headers.`,
        `- NEVER write more than one short paragraph. If the topic needs depth, you'll get another turn.`,
        `- If you catch yourself writing a wall of text, stop and pick your single best point.`,
      ];

  return [
    `You are "${p.name}" — ${p.tagline}.`,
    ``,
    `PERSONALITY TRAITS: ${p.traits.join(", ")}`,
    `COMMUNICATION STYLE: ${p.style.join(". ")}`,
    `PERSPECTIVE: ${p.bias}`,
    ``,
    `RULES FOR THIS DISCUSSION:`,
    `- You are discussing: "${topic}"`,
    `- Multiple people are participating. You see their names before their messages.`,
    ...lengthRules,
    `- Stay in character. Your personality should come through naturally.`,
    `- You can agree, disagree, build on points, ask questions, or challenge others.`,
    `- Reference other speakers by name when responding to their points.`,
    `- Be opinionated. Don't be wishy-washy or try to please everyone.`,
    `- If someone new joins, you can briefly acknowledge them.`,
    `- Do NOT use quotation marks around your own message.`,
    `- NEVER start your message with your own name. Not "${p.name}:" or "${p.name} —" or anything like that. Just start talking.`,
    `- Write naturally, in your own voice.`,
  ].join("\n");
}

// ── Convert room history to ChatMessage format for an agent ─────────

export function buildMessages(
  agent: AgentConfig,
  topic: string,
  history: RoomMessage[],
  contextWindow: number,
  governed: boolean = false,
): ChatMessage[] {
  const system = buildSystemPrompt(agent.personality, topic, governed);
  const messages: ChatMessage[] = [{ role: "system", content: system }];

  // Take the last N messages from history
  const recent = history.slice(-contextWindow);

  for (const msg of recent) {
    if (msg.kind === "user") {
      messages.push({ role: "user", content: `[HOST]: ${msg.content}` });
    } else if (msg.kind === "join") {
      messages.push({ role: "user", content: `* ${msg.agent} has joined the room — ${msg.content}` });
    } else if (msg.kind === "leave") {
      messages.push({ role: "user", content: `* ${msg.agent} has left the room — ${msg.content}` });
    } else if (msg.kind === "system") {
      messages.push({ role: "user", content: `[SYSTEM]: ${msg.content}` });
    } else if (msg.agent === agent.personality.name) {
      messages.push({ role: "assistant", content: msg.content });
    } else {
      messages.push({ role: "user", content: `[${msg.agent}]: ${msg.content}` });
    }
  }

  return messages;
}

// ── Should this agent speak this turn? ──────────────────────────────

export function shouldSpeak(
  agent: AgentConfig,
  lastSpeaker: string | null,
  turnsSinceLast: number,
): boolean {
  const p = agent.personality;

  // Never speak twice in a row
  if (lastSpeaker === p.name) return false;

  // Higher chance if haven't spoken in a while
  const recencyBoost = Math.min(turnsSinceLast * 0.15, 0.4);

  // Base probability from chattiness
  const prob = p.chattiness + recencyBoost;

  return Math.random() < prob;
}
