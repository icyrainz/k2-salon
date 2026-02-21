import type { RoomMessage } from "../types.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";

// ── Format timestamp like IRC ───────────────────────────────────────

function fmtTime(d: Date): string {
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${DIM}${h}:${m}${RESET}`;
}

// ── Render a completed message ──────────────────────────────────────

export function renderMessage(msg: RoomMessage): void {
  const time = fmtTime(msg.timestamp);

  switch (msg.kind) {
    case "join":
      process.stdout.write(
        `${time} ${DIM}-->>${RESET} ${msg.color}${BOLD}${msg.agent}${RESET} ${DIM}has joined${RESET} ${ITALIC}(${msg.content})${RESET}\n`,
      );
      break;

    case "leave":
      process.stdout.write(
        `${time} ${DIM}<<--${RESET} ${msg.color}${BOLD}${msg.agent}${RESET} ${DIM}has left${RESET} ${ITALIC}(${msg.content})${RESET}\n`,
      );
      break;

    case "system":
      process.stdout.write(
        `${time} ${DIM}  * ${msg.content}${RESET}\n`,
      );
      break;

    case "user":
      // Don't re-render — user messages were already shown during streaming input
      break;

    case "chat":
      // Already rendered via streaming, just print newline if needed
      break;
  }
}

// ── Render streaming tokens (called per-token) ─────────────────────

let currentStreamAgent: string | null = null;
let currentStreamColor: string | null = null;

export function renderStreamStart(agentName: string, agentColor: string): void {
  currentStreamAgent = agentName;
  currentStreamColor = agentColor;
  const time = fmtTime(new Date());
  // Print the prefix: timestamp and agent name
  process.stdout.write(
    `${time} ${agentColor}${BOLD}<${agentName}>${RESET} `,
  );
}

export function renderStreamToken(token: string): void {
  process.stdout.write(token);
}

export function renderStreamEnd(): void {
  process.stdout.write("\n");
  currentStreamAgent = null;
  currentStreamColor = null;
}

// ── Render user input prompt ────────────────────────────────────────

export function renderUserPrompt(): void {
  const time = fmtTime(new Date());
  process.stdout.write(`${time} \x1b[97m${BOLD}<YOU>${RESET} `);
}

// ── Render the room header ──────────────────────────────────────────

export function renderHeader(
  topic: string,
  opts?: { roomName?: string; session?: number; resumed?: boolean },
): void {
  const border = "═".repeat(60);
  process.stdout.write(`\n${DIM}╔${border}╗${RESET}\n`);
  process.stdout.write(`${DIM}║${RESET}  ${BOLD}k2-salon${RESET} ${DIM}— Multi-AI Debate Room${RESET}\n`);
  process.stdout.write(`${DIM}║${RESET}\n`);
  if (opts?.roomName) {
    const sessionInfo = opts.session ? ` ${DIM}session ${opts.session}${RESET}` : "";
    const resumeTag = opts.resumed ? ` ${DIM}(resumed)${RESET}` : "";
    process.stdout.write(`${DIM}║${RESET}  Room: ${BOLD}${opts.roomName}${RESET}${sessionInfo}${resumeTag}\n`);
  }
  process.stdout.write(`${DIM}║${RESET}  Topic: ${BOLD}${topic}${RESET}\n`);
  process.stdout.write(`${DIM}║${RESET}\n`);
  process.stdout.write(`${DIM}║${RESET}  ${DIM}Commands: type to chime in, empty to skip, /quit to leave${RESET}\n`);
  process.stdout.write(`${DIM}╚${border}╝${RESET}\n\n`);
}

// ── Render who's currently in the room ──────────────────────────────

export function renderPresence(agents: { name: string; color: string }[]): void {
  const names = agents
    .map(a => `${a.color}${a.name}${RESET}`)
    .join(`${DIM}, ${RESET}`);
  process.stdout.write(`${DIM}  In room: ${RESET}${names}\n\n`);
}
