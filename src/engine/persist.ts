import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentColor, RoomMessage } from "../core/types.js";

// ── Room directory structure ────────────────────────────────────────
//
//   rooms/
//   ├── ai-thoughts/
//   │   ├── room.yaml          # topic, created date
//   │   ├── seed.md            # optional starting material
//   │   ├── 001-session.md     # session transcript
//   │   └── 002-session.md
//   └── climate-policy/
//       └── seed.md            # empty room with just seed material

const ROOMS_DIR = "rooms";

// ── Room metadata (room.yaml) ───────────────────────────────────────

export interface RoomMeta {
  topic: string;
  /** Language agents must use when responding (default: "English") */
  language?: string;
  created: string;
  lastSession: number;
  /** Names of agents that were active in the last session (for stable resume) */
  activeRoster?: string[];
}

export async function loadRoomMeta(roomName: string): Promise<RoomMeta | null> {
  const metaPath = join(ROOMS_DIR, roomName, "room.yaml");
  if (!existsSync(metaPath)) return null;
  const raw = await readFile(metaPath, "utf-8");
  return parseYaml(raw) as RoomMeta;
}

export async function saveRoomMeta(
  roomName: string,
  meta: RoomMeta,
): Promise<void> {
  const dir = join(ROOMS_DIR, roomName);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "room.yaml"), stringifyYaml(meta));
}

// ── Seed material ───────────────────────────────────────────────────
// Reads any .md file in the room dir that isn't a session transcript.
// This includes seed.md, discussions.md, or any freeform markdown.

export async function loadSeedMaterial(
  roomName: string,
): Promise<string | null> {
  const dir = join(ROOMS_DIR, roomName);
  if (!existsSync(dir)) return null;

  const files = await readdir(dir);
  const seedFiles = files.filter(
    (f) => f.endsWith(".md") && !f.match(/^\d{3}-session\.md$/),
  );

  if (seedFiles.length === 0) return null;

  const parts: string[] = [];
  for (const file of seedFiles) {
    const content = await readFile(join(dir, file), "utf-8");
    parts.push(`--- ${file} ---\n${content.trim()}`);
  }

  return parts.join("\n\n");
}

// ── Session transcripts ─────────────────────────────────────────────

function sessionPath(roomName: string, session: number): string {
  const num = session.toString().padStart(3, "0");
  return join(ROOMS_DIR, roomName, `${num}-session.md`);
}

/** Find the next session number for a room */
export async function nextSessionNumber(roomName: string): Promise<number> {
  const dir = join(ROOMS_DIR, roomName);
  if (!existsSync(dir)) return 1;

  const files = await readdir(dir);
  const sessions = files
    .map((f) => f.match(/^(\d{3})-session\.md$/))
    .filter(Boolean)
    .map((m) => parseInt(m![1], 10));

  return sessions.length > 0 ? Math.max(...sessions) + 1 : 1;
}

/** Load messages from previous sessions (for resume context) */
export async function loadPreviousSessions(
  roomName: string,
  maxMessages: number,
): Promise<RoomMessage[]> {
  const dir = join(ROOMS_DIR, roomName);
  if (!existsSync(dir)) return [];

  const files = await readdir(dir);
  const sessionFiles = files
    .filter((f) => f.match(/^\d{3}-session\.md$/))
    .sort(); // chronological order

  const allMessages: RoomMessage[] = [];

  for (const file of sessionFiles) {
    const content = await readFile(join(dir, file), "utf-8");
    const messages = parseSessionMarkdown(content);
    allMessages.push(...messages);
  }

  // Return only the last N messages for context
  return allMessages.slice(-maxMessages);
}

// ── Transcript writer (appends messages in real-time) ───────────────

export class TranscriptWriter {
  private filePath: string;
  private initialized = false;
  private participants: string[] = [];
  private pending: RoomMessage[] = [];
  private hasContent = false;

  constructor(roomName: string, session: number, topic: string) {
    this.filePath = sessionPath(roomName, session);
    this.topic = topic;
    this.session = session;
  }

  private topic: string;
  private session: number;

  async init(participants: string[]): Promise<void> {
    this.participants = participants;
    this.initialized = true;
  }

  private async ensureFile(): Promise<void> {
    if (existsSync(this.filePath)) return;

    const frontmatter = [
      "---",
      `topic: "${this.topic}"`,
      `session: ${this.session}`,
      `started: ${new Date().toISOString()}`,
      `participants: [${this.participants.join(", ")}]`,
      "---",
      "",
      "",
    ].join("\n");

    await writeFile(this.filePath, frontmatter);
  }

  async append(msg: RoomMessage): Promise<void> {
    if (!this.initialized) return;

    const line = formatMessageToMarkdown(msg);
    if (!line) return;

    // Buffer non-content messages until a chat or user message arrives
    if (!this.hasContent) {
      if (msg.kind !== "chat" && msg.kind !== "user") {
        this.pending.push(msg);
        return;
      }
      // First substantive message — flush buffered messages then write
      this.hasContent = true;
      await this.ensureFile();
      for (const buffered of this.pending) {
        const bufferedLine = formatMessageToMarkdown(buffered);
        if (bufferedLine)
          await writeFile(this.filePath, bufferedLine, { flag: "a" });
      }
      this.pending = [];
    }

    await this.ensureFile();
    await writeFile(this.filePath, line, { flag: "a" });
  }

  async finalize(): Promise<void> {
    if (!this.initialized || !existsSync(this.filePath)) return;

    // Read the file, update the frontmatter with ended timestamp
    const content = await readFile(this.filePath, "utf-8");
    const updated = content.replace(
      /^---\n([\s\S]*?)---/,
      (_, fm) => `---\n${fm}ended: ${new Date().toISOString()}\n---`,
    );
    await writeFile(this.filePath, updated);
  }
}

// ── Format a RoomMessage to markdown ────────────────────────────────

export function formatMessageToMarkdown(msg: RoomMessage): string {
  const time = fmtTimeISO(msg.timestamp);
  const idTag = msg.id ? ` #${msg.id}` : "";

  switch (msg.kind) {
    case "system":
      return `> **SYSTEM** *${time}*${idTag} — ${msg.content}\n\n`;

    case "join":
      return `> **${msg.agent}** *${time}*${idTag} [join] — ${msg.content}\n\n`;

    case "leave":
      return `> **${msg.agent}** *${time}*${idTag} [leave] — ${msg.content}\n\n`;

    case "user":
      return `**YOU** *${time}*${idTag}\n${msg.content}\n\n`;

    case "chat":
      return `**${msg.agent}** *${time}*${idTag}\n${msg.content}\n\n`;

    default:
      return "";
  }
}

function fmtTimeISO(d: Date): string {
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

// ── Parse session markdown back into RoomMessage[] ──────────────────

export function parseSessionMarkdown(content: string): RoomMessage[] {
  const messages: RoomMessage[] = [];

  // Strip frontmatter
  const body = content.replace(/^---\n[\s\S]*?---\n*/, "").trim();
  if (!body) return messages;

  // Split into blocks separated by blank lines
  const blocks = body.split(/\n\n+/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // System/join/leave: > **NAME** *HH:MM* [kind] — content
    // or: > **SYSTEM** *HH:MM* — content
    // Optional #N message ID between timestamp and kind tag
    const eventMatch = trimmed.match(
      /^>\s*\*\*(\w+)\*\*\s*\*(\d{2}:\d{2})\*\s*(?:#(\d{4}-[me])\s*)?(?:\[(\w+)\]\s*)?—\s*(.+)$/s,
    );
    if (eventMatch) {
      const [, agent, _time, idStr, kindTag, content] = eventMatch;
      let kind: RoomMessage["kind"] = "system";
      if (kindTag === "join") kind = "join";
      else if (kindTag === "leave") kind = "leave";
      else if (agent === "SYSTEM") kind = "system";

      messages.push({
        id: idStr ?? "",
        timestamp: new Date(),
        agent,
        content: content.trim(),
        color: "white",
        kind,
      });
      continue;
    }

    // Chat/user: **NAME** *HH:MM* [#N]\ncontent (possibly multi-line)
    const chatMatch = trimmed.match(
      /^\*\*(\w+)\*\*\s*\*(\d{2}:\d{2})\*(?:\s*#(\d{4}-[me]))?\n([\s\S]+)$/,
    );
    if (chatMatch) {
      const [, agent, _time, idStr, content] = chatMatch;
      messages.push({
        id: idStr ?? "",
        timestamp: new Date(),
        agent,
        content: content.trim(),
        color: "white",
        kind: agent === "YOU" ? "user" : "chat",
      });
      continue;
    }
  }

  return messages;
}

// ── Parse seed/discussion markdown into RoomMessages ────────────────
// Handles the existing discussions.md format:
//   ## User / ## Assistant (...)
//   content blocks separated by ---

export function parseSeedToMessages(seedContent: string): RoomMessage[] {
  const messages: RoomMessage[] = [];

  // Strip file header (--- filename ---) if present
  const content = seedContent.replace(/^---\s+\S+\s+---\n/, "").trim();

  // Split by horizontal rules (---)
  const sections = content.split(/\n---+\n/);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // Match ## User header
    if (trimmed.startsWith("## User")) {
      const body = trimmed.replace(/^## User\s*\n*/, "").trim();
      if (body) {
        messages.push({
          id: "",
          timestamp: new Date(),
          agent: "YOU",
          content: body,
          color: "whiteBright",
          kind: "user",
        });
      }
      continue;
    }

    // Match ## Assistant header
    const assistantMatch = trimmed.match(
      /^## Assistant\s*(?:\(([^)]*)\))?\s*\n*([\s\S]*)$/,
    );
    if (assistantMatch) {
      const body = assistantMatch[2].trim();
      if (body) {
        messages.push({
          id: "",
          timestamp: new Date(),
          agent: "PRIOR",
          content: body,
          color: "gray",
          kind: "chat",
        });
      }
      continue;
    }

    // Top-level content (e.g., the # title and metadata)
    // Check if it starts with a markdown heading
    const headingMatch = trimmed.match(/^#\s+(.+)/);
    if (headingMatch) {
      messages.push({
        id: "",
        timestamp: new Date(),
        agent: "SYSTEM",
        content: `Prior discussion: ${headingMatch[1]}`,
        color: "gray",
        kind: "system",
      });
      continue;
    }

    // Generic content block — treat as context
    if (trimmed.length > 20) {
      messages.push({
        id: "",
        timestamp: new Date(),
        agent: "SYSTEM",
        content: trimmed,
        color: "gray",
        kind: "system",
      });
    }
  }

  return messages;
}

// ── Check if a room directory exists ────────────────────────────────

export function roomExists(roomName: string): boolean {
  return existsSync(join(ROOMS_DIR, roomName));
}

export async function createRoomDir(roomName: string): Promise<void> {
  const dir = join(ROOMS_DIR, roomName);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}
