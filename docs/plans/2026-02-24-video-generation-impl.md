# Video Generation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign message IDs from `number | undefined` to string `NNNN-m`/`NNNN-e` format, then build a CLI that generates YouTube Shorts from room transcripts using ffmpeg.

**Architecture:** Two-phase change. Phase 1 converts the ID system across all layers (types → engine → persist → TTS → TUI). Phase 2 adds `src/cli/video.ts` with a hybrid pipeline: load transcripts → generate TTS → concat audio → build VideoManifest → render via ffmpeg. The manifest is renderer-agnostic so ffmpeg can be swapped later.

**Tech Stack:** TypeScript/Bun, ffmpeg/ffprobe (external binaries), OpenAI TTS API.

---

## Phase 1: Message ID Redesign

### Task 1: Update core type and add ID helpers

**Files:**
- Modify: `src/core/types.ts:83-94`

**Step 1: Write the failing test**

Create `src/core/types.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { makeId, parseId } from "./types.js";

describe("makeId", () => {
  it("creates content IDs with -m suffix", () => {
    expect(makeId(0, "chat")).toBe("0000-m");
    expect(makeId(3, "user")).toBe("0003-m");
  });

  it("creates event IDs with -e suffix", () => {
    expect(makeId(1, "join")).toBe("0001-e");
    expect(makeId(2, "leave")).toBe("0002-e");
    expect(makeId(0, "system")).toBe("0000-e");
  });

  it("pads to 4 digits", () => {
    expect(makeId(42, "chat")).toBe("0042-m");
    expect(makeId(9999, "chat")).toBe("9999-m");
  });
});

describe("parseId", () => {
  it("extracts sequence number from content ID", () => {
    expect(parseId("0042-m")).toBe(42);
  });

  it("extracts sequence number from event ID", () => {
    expect(parseId("0001-e")).toBe(1);
  });

  it("returns -1 for invalid IDs", () => {
    expect(parseId("invalid")).toBe(-1);
    expect(parseId("")).toBe(-1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/core/types.test.ts`
Expected: FAIL — `makeId` and `parseId` not found.

**Step 3: Write implementation**

In `src/core/types.ts`, change the `RoomMessage` interface and add helpers:

```typescript
export interface RoomMessage {
  /** Message ID: "NNNN-m" (chat/user) or "NNNN-e" (join/leave/system) */
  id: string;
  timestamp: Date;
  agent: string;
  content: string;
  color: AgentColor;
  kind: "chat" | "join" | "leave" | "system" | "user";
  providerLabel?: string;
  modelLabel?: string;
}

/** Build a message ID string from a sequence number and kind. */
export function makeId(seq: number, kind: RoomMessage["kind"]): string {
  const suffix = kind === "chat" || kind === "user" ? "m" : "e";
  return `${String(seq).padStart(4, "0")}-${suffix}`;
}

/** Extract the numeric sequence from an ID string. Returns -1 if invalid. */
export function parseId(id: string): number {
  const match = id.match(/^(\d+)-[me]$/);
  return match ? parseInt(match[1], 10) : -1;
}

/** Check if an ID is a content message (chat/user). */
export function isContentId(id: string): boolean {
  return id.endsWith("-m");
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/core/types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/types.ts src/core/types.test.ts
git commit -m "feat: redesign message ID to string format NNNN-m/NNNN-e"
```

---

### Task 2: Update SalonEngine to use new ID format

**Files:**
- Modify: `src/engine/salon-engine.ts:14-78,257-264,344-390`
- Modify: `src/engine/salon-engine.test.ts`

**Step 1: Update the engine**

In `src/engine/salon-engine.ts`:

1. Add import at top:
```typescript
import { makeId, parseId } from "../core/types.js";
```

2. Change `SalonEvents` interface (line 16):
```typescript
thinking: (agent: string, msgId: string) => void;
```

3. Replace `nextMsgId` (line 42):
```typescript
private nextId = 0;
```

4. Replace the preloaded history block (lines 66-78):
```typescript
if (preloadedHistory) {
  this.history = [...preloadedHistory];
  const maxSeq = this.history.reduce(
    (max, m) => Math.max(max, parseId(m.id)),
    -1,
  );
  this.nextId = maxSeq + 1;
}
```

5. Replace `pushMessage` (lines 257-264):
```typescript
private pushMessage(msg: RoomMessage): void {
  if (!msg.id || msg.id === "") {
    msg.id = makeId(this.nextId++, msg.kind);
  }
  this.history.push(msg);
  this.emit("message", msg);
}
```

6. Replace preallocId in `agentSpeak` (lines 344-347):
```typescript
const preallocId = makeId(this.nextId++, "chat");
this.emit("thinking", name, preallocId);
```

7. Update line 390 where preallocId is set on the chat message:
```typescript
id: preallocId,
```
(This is already correct — it's just a string now.)

**Step 2: Update engine tests**

In `src/engine/salon-engine.test.ts`:

1. Update the "assigns sequential IDs" test (lines 151-171):
```typescript
it("assigns sequential string IDs to messages", () => {
  const agents = [makeAgent("A"), makeAgent("B"), makeAgent("C")];
  const engine = new SalonEngine(defaultConfig, agents);

  const messages: RoomMessage[] = [];
  engine.on("message", (msg) => messages.push(msg));

  engine.open();

  for (const msg of messages) {
    expect(msg.id).toBeDefined();
    expect(typeof msg.id).toBe("string");
    expect(msg.id).toMatch(/^\d{4}-[me]$/);
  }

  // System message should end with -e, join messages with -e
  expect(messages[0].id).toMatch(/-e$/);
  const joins = messages.filter((m) => m.kind === "join");
  for (const j of joins) expect(j.id).toMatch(/-e$/);
});
```

2. Update the preloaded history test (lines 359-388):
```typescript
describe("SalonEngine message IDs with preloaded history", () => {
  it("continues sequence from preloaded history", () => {
    const history: RoomMessage[] = [
      {
        id: "0000-m",
        timestamp: new Date(),
        agent: "A",
        content: "Old msg 1",
        color: "cyan",
        kind: "chat",
      },
      {
        id: "0001-m",
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

    // Preloaded max seq = 1, so new IDs start at seq 2
    expect(parseId(messages[0].id)).toBe(2);
  });
});
```

Add `parseId` import at top of test file:
```typescript
import { parseId } from "../core/types.js";
```

**Step 3: Run tests**

Run: `bun test src/engine/salon-engine.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/engine/salon-engine.ts src/engine/salon-engine.test.ts
git commit -m "refactor: SalonEngine uses string message IDs"
```

---

### Task 3: Update persist layer (format + parse)

**Files:**
- Modify: `src/engine/persist.ts:202-292`
- Modify: `src/engine/persist.test.ts`

**Step 1: Update tests first**

In `src/engine/persist.test.ts`:

1. Update `makeMsg` helper — `id` is now required string:
```typescript
function makeMsg(overrides: Partial<RoomMessage> & { id?: string }): RoomMessage {
  return {
    id: "",
    timestamp: new Date("2025-01-15T14:30:00Z"),
    agent: "TestBot",
    content: "Hello world",
    color: "cyan",
    kind: "chat",
    ...overrides,
  };
}
```

2. Update "includes message ID" test (line 79-85):
```typescript
it("includes message ID when present", () => {
  const md = formatMessageToMarkdown(
    makeMsg({ kind: "chat", agent: "Sage", id: "0042-m" }),
  );
  expect(md).toContain("#0042-m");
  expect(md).toContain("**Sage**");
});
```

3. Update "omits message ID" test (line 87-92):
```typescript
it("omits message ID when empty", () => {
  const md = formatMessageToMarkdown(
    makeMsg({ kind: "chat", agent: "Sage", id: "" }),
  );
  expect(md).not.toContain("#");
});
```

4. Update "parses message ID from chat header" (line 195-201):
```typescript
it("parses message ID from chat header", () => {
  const content = `**Sage** *14:30* #0042-m\nHello world`;
  const messages = parseSessionMarkdown(content);
  expect(messages).toHaveLength(1);
  expect(messages[0].id).toBe("0042-m");
  expect(messages[0].content).toBe("Hello world");
});
```

5. Update "parses message ID from event header" (line 203-209):
```typescript
it("parses message ID from event header", () => {
  const content = `> **Sage** *14:30* #0005-e [join] — Stoic philosopher`;
  const messages = parseSessionMarkdown(content);
  expect(messages).toHaveLength(1);
  expect(messages[0].id).toBe("0005-e");
  expect(messages[0].kind).toBe("join");
});
```

6. Update round-trip test (line 211-223):
```typescript
it("round-trips with message IDs", () => {
  const original = makeMsg({
    kind: "chat",
    agent: "Sage",
    content: "ID test",
    id: "0007-m",
  });
  const md = formatMessageToMarkdown(original);
  const parsed = parseSessionMarkdown(md);
  expect(parsed).toHaveLength(1);
  expect(parsed[0].id).toBe("0007-m");
  expect(parsed[0].content).toBe("ID test");
});
```

**Step 2: Run tests to see them fail**

Run: `bun test src/engine/persist.test.ts`
Expected: FAIL

**Step 3: Update persist.ts**

1. Update `formatMessageToMarkdown` (line 204):
```typescript
const idTag = msg.id ? ` #${msg.id}` : "";
```

2. Update event regex (line 252-253) to match new ID format:
```typescript
const eventMatch = trimmed.match(
  /^>\s*\*\*(\w+)\*\*\s*\*(\d{2}:\d{2})\*\s*(?:#(\d{4}-[me])\s*)?(?:\[(\w+)\]\s*)?—\s*(.+)$/s,
);
```

3. Update event ID assignment (line 268):
```typescript
...(idStr ? { id: idStr } : { id: "" }),
```

4. Update chat regex (line 274-275):
```typescript
const chatMatch = trimmed.match(
  /^\*\*(\w+)\*\*\s*\*(\d{2}:\d{2})\*(?:\s*#(\d{4}-[me]))?\n([\s\S]+)$/,
);
```

5. Update chat ID assignment (line 285):
```typescript
...(idStr ? { id: idStr } : { id: "" }),
```

6. Update `parseSeedToMessages` — seed messages don't have IDs, give them empty string:
All seed message objects already lack `id`, which is fine because we changed the type to be required. Add `id: ""` to every `messages.push({...})` call in `parseSeedToMessages`:
- Line 318: add `id: "",`
- Line 338: add `id: "",`
- Line 351: add `id: "",`
- Line 363: add `id: "",`

**Step 4: Run tests**

Run: `bun test src/engine/persist.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/engine/persist.ts src/engine/persist.test.ts
git commit -m "refactor: persist layer uses string message IDs"
```

---

### Task 4: Update TTS module

**Files:**
- Modify: `src/engine/tts.ts:12-17,49-56`

**Step 1: Update function signatures**

1. `ttsPath` (line 12-14):
```typescript
export function ttsPath(roomName: string, messageId: string): string {
  return join(ROOMS_DIR, roomName, "tts", `${messageId}.mp3`);
}
```

2. `ttsExists` (line 16-18):
```typescript
export function ttsExists(roomName: string, messageId: string): boolean {
  return existsSync(ttsPath(roomName, messageId));
}
```

3. `generateAndCacheTts` parameter (line 51):
```typescript
messageId: string,
```

**Step 2: Run type-check**

Run: `npx tsc --noEmit`
Expected: Errors in tui/app.tsx and tui/main.ts (handled in next tasks).

**Step 3: Commit**

```bash
git add src/engine/tts.ts
git commit -m "refactor: TTS module uses string message IDs"
```

---

### Task 5: Update TUI app.tsx

**Files:**
- Modify: `src/tui/app.tsx`

**Step 1: Update types and event signatures**

1. Line 37 — `DisplayMessage.id` is a React key (internal), keep as number. No change needed.

2. Line 477 — `TuiEvent` streamStart:
```typescript
| { type: "streamStart"; agent: string; color: AgentColor; msgId: string }
```

3. Line 533 — `onThinking` listener:
```typescript
const onThinking = (agent: string, msgId: string) => {
```

4. Line 558 — fallback msgId for late stream start:
```typescript
emitTuiEvent({ type: "streamStart", agent, color, msgId: "" });
```

5. Line 619 — placeholder message ID:
```typescript
id: event.msgId || "",
```

6. Line 393 (TtsSelectBar) — `ttsExists` check:
```typescript
const cached = dm.msg.id !== "" && ttsExists(roomName, dm.msg.id);
```

7. Line 813-814 — TTS command:
```typescript
if (!dm.msg.id) return;
onUserInput(`\x00TTS:${dm.msg.id}:${dm.msg.agent}`);
```

**Step 2: Run type-check**

Run: `npx tsc --noEmit`
Expected: Remaining errors in tui/main.ts only.

**Step 3: Commit**

```bash
git add src/tui/app.tsx
git commit -m "refactor: TUI uses string message IDs"
```

---

### Task 6: Update TUI main.ts

**Files:**
- Modify: `src/tui/main.ts`

**Step 1: Update all ID usages**

1. Lines 156-160 — Remove legacy ID assignment block entirely. With the new format, messages from old transcripts that lack IDs will have `id: ""`. The engine handles assigning new IDs. Remove:
```typescript
// DELETE these lines — engine now handles all ID assignment
for (let i = 0; i < preloadedHistory.length; i++) {
  if (preloadedHistory[i].id === undefined) {
    preloadedHistory[i].id = i;
  }
}
```

2. Line 173 — Change Map key type:
```typescript
const ttsMessageMap = new Map<string, string>();
```

3. Lines 204-208 — Parse TTS command (no parseInt, just string):
```typescript
} else if (line.startsWith("\x00TTS:")) {
  const parts = line.slice(5).split(":");
  const msgId = parts[0];
  const agentName = parts.slice(1).join(":");
  handleTts(msgId, agentName);
```

4. Line 214 — handleTts signature:
```typescript
const handleTts = async (msgId: string, agentName: string) => {
```

5. Lines 296-298 — Store message content by ID:
```typescript
if ((msg.kind === "chat" || msg.kind === "user") && msg.id) {
  ttsMessageMap.set(msg.id, msg.content);
}
```

6. Lines 349-351 — Same pattern for preloaded messages:
```typescript
if ((msg.kind === "chat" || msg.kind === "user") && msg.id) {
  ttsMessageMap.set(msg.id, msg.content);
}
```

**Step 2: Run full type-check and tests**

Run: `npx tsc --noEmit && bun test`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add src/tui/main.ts
git commit -m "refactor: TUI main uses string message IDs"
```

---

### Task 7: Update simulate.ts (if it references msg.id)

**Files:**
- Check: `src/cli/simulate.ts`

**Step 1: Check for ID references**

Simulate.ts creates RoomMessages via the engine, which now handles IDs. Verify no direct ID manipulation exists. If `simulate.ts` constructs `RoomMessage` objects without `id`, they need `id: ""` added.

Run: `npx tsc --noEmit`
Expected: PASS (or fix any remaining issues)

**Step 2: Commit if changed**

```bash
git add src/cli/simulate.ts
git commit -m "fix: simulate.ts compatible with string message IDs"
```

---

### Task 8: Run full test suite and type-check

**Step 1: Run everything**

Run: `bun test && npx tsc --noEmit`
Expected: ALL PASS

**Step 2: Format**

Run: `npx prettier --write src/`

**Step 3: Commit**

```bash
git add -A
git commit -m "chore: format after message ID redesign"
```

---

## Phase 2: Video Generation CLI

### Task 9: Add video manifest types

**Files:**
- Modify: `src/core/types.ts` (add VideoManifest and VideoSegment interfaces)

**Step 1: Add types to `src/core/types.ts`**

```typescript
// ── Video generation ──────────────────────────────────────────────

export interface VideoManifest {
  meta: {
    room: string;
    topic: string;
    language: string;
    fromId: string;
    toId: string;
    totalDuration: number;
    resolution: { w: number; h: number };
  };
  participants: {
    name: string;
    color: string;
    voice: string;
    tagline: string;
  }[];
  segments: VideoSegment[];
}

export interface VideoSegment {
  id: string;
  kind: "chat" | "user" | "join" | "leave" | "system";
  agent: string;
  text: string;
  audioFile?: string;
  startTime: number;
  endTime: number;
  duration: number;
  pauseAfter: number;
}
```

**Step 2: Run type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/core/types.ts
git commit -m "feat: add VideoManifest and VideoSegment types"
```

---

### Task 10: Add AgentColor → hex mapping

**Files:**
- Modify: `src/tui/colors.ts` (add `toHexColor` function)

**Step 1: Write test**

Create `src/tui/colors.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { toHexColor } from "./colors.js";

describe("toHexColor", () => {
  it("maps known AgentColors to hex", () => {
    expect(toHexColor("cyan")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(toHexColor("redBright")).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("returns white hex for unknown colors", () => {
    expect(toHexColor("unknown" as any)).toBe("#ffffff");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/tui/colors.test.ts`
Expected: FAIL

**Step 3: Implement**

In `src/tui/colors.ts`, add:

```typescript
const HEX_MAP: Record<string, string> = {
  black: "#000000",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  blue: "#3b82f6",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#e5e7eb",
  gray: "#9ca3af",
  redBright: "#f87171",
  greenBright: "#4ade80",
  yellowBright: "#facc15",
  blueBright: "#60a5fa",
  magentaBright: "#c084fc",
  cyanBright: "#22d3ee",
  whiteBright: "#ffffff",
};

export function toHexColor(color: AgentColor): string {
  return HEX_MAP[color] ?? "#ffffff";
}
```

Add `AgentColor` import if not already there.

**Step 4: Run test**

Run: `bun test src/tui/colors.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/tui/colors.ts src/tui/colors.test.ts
git commit -m "feat: add AgentColor to hex color mapping for video"
```

---

### Task 11: Build video.ts CLI — pipeline skeleton

**Files:**
- Create: `src/cli/video.ts`
- Modify: `Justfile`

**Step 1: Create the CLI entry point with arg parsing and pipeline stages**

Create `src/cli/video.ts`:

```typescript
/**
 * Video generator — creates a YouTube Short from a room's conversation.
 *
 * Walks through all messages in a room, generates TTS for content messages
 * (reusing cached audio), builds a renderer-agnostic timeline manifest,
 * and produces a 1080x1920 vertical video with ffmpeg.
 *
 * Usage:
 *   just video <room-name>
 *   just video <room-name> --from 10 --to 45
 *   just video <room-name> --out custom.mp4
 */

import { readFile, writeFile, mkdir, rm } from "fs/promises";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import {
  loadRoomMeta,
  loadPreviousSessions,
} from "../engine/persist.js";
import { generateAndCacheTts, ttsPath } from "../engine/tts.js";
import { voiceFor } from "../core/voices.js";
import { toHexColor } from "../tui/colors.js";
import { loadConfig, resolveRoster } from "../engine/config.js";
import { PERSONALITY_PRESETS } from "../core/roster.js";
import type {
  AgentColor,
  VideoManifest,
  VideoSegment,
} from "../core/types.js";
import { isContentId } from "../core/types.js";

const ROOMS_DIR = "rooms";
const WIDTH = 1080;
const HEIGHT = 1920;
const PAUSE_MS = 800;

// ── Parse CLI args ──────────────────────────────────────────────────

const args = process.argv.slice(2);

let roomName = "";
let fromSeq: number | null = null;
let toSeq: number | null = null;
let outputFile: string | null = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--from" && args[i + 1]) {
    fromSeq = parseInt(args[++i], 10);
  } else if (args[i] === "--to" && args[i + 1]) {
    toSeq = parseInt(args[++i], 10);
  } else if (args[i] === "--out" && args[i + 1]) {
    outputFile = args[++i];
  } else if (!args[i].startsWith("--")) {
    roomName = args[i];
  }
}

// ── ffmpeg helpers ──────────────────────────────────────────────────

function ffmpeg(ffmpegArgs: string[]): void {
  const result = Bun.spawnSync(["ffmpeg", "-y", ...ffmpegArgs], {
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const msg = result.stderr
      ? new TextDecoder().decode(result.stderr)
      : "(no output)";
    throw new Error(`ffmpeg failed:\n${msg}`);
  }
}

function ffprobe(filePath: string): number {
  const result = Bun.spawnSync(
    [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      filePath,
    ],
    { stdout: "pipe" },
  );
  const out = new TextDecoder().decode(result.stdout).trim();
  return parseFloat(out) || 0;
}

function generateSilence(ms: number, outPath: string): void {
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=24000:cl=mono",
    "-t",
    (ms / 1000).toFixed(3),
    "-q:a",
    "9",
    "-acodec",
    "libmp3lame",
    outPath,
  ]);
}

function concatenateMp3s(
  inputPaths: string[],
  outputPath: string,
  tmpDir: string,
): void {
  const listPath = join(tmpDir, "concat.txt");
  writeFileSync(listPath, inputPaths.map((p) => `file '${p}'`).join("\n"));
  ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath]);
}

// ── Escaping for ffmpeg drawtext ────────────────────────────────────

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\\\\\")
    .replace(/'/g, "'\\\\\\''")
    .replace(/:/g, "\\\\:")
    .replace(/%/g, "\\\\%")
    .replace(/\n/g, "\\n");
}

// ── Main pipeline ───────────────────────────────────────────────────

async function main() {
  if (!roomName) {
    process.stderr.write("Usage: just video <room-name> [--from N] [--to N] [--out file.mp4]\n");
    process.exit(1);
  }

  // 1. Load room metadata
  const meta = await loadRoomMeta(roomName);
  if (!meta) {
    process.stderr.write(`Error: room "${roomName}" not found or has no room.yaml\n`);
    process.exit(1);
  }

  // 2. Load all messages from all sessions
  const allMessages = await loadPreviousSessions(roomName, Infinity);
  if (allMessages.length === 0) {
    process.stderr.write(`Error: no messages found in room "${roomName}"\n`);
    process.exit(1);
  }

  // 3. Filter by --from/--to (content message sequence numbers)
  const { parseId } = await import("../core/types.js");
  let filtered = allMessages;
  if (fromSeq !== null || toSeq !== null) {
    filtered = allMessages.filter((m) => {
      const seq = parseId(m.id);
      if (seq < 0) return false;
      if (isContentId(m.id)) {
        if (fromSeq !== null && seq < fromSeq) return false;
        if (toSeq !== null && seq > toSeq) return false;
        return true;
      }
      // Include events that fall within the range of surrounding content
      if (fromSeq !== null && seq < fromSeq) return false;
      if (toSeq !== null && seq > toSeq) return false;
      return true;
    });
  }

  const contentMessages = filtered.filter((m) => isContentId(m.id));
  if (contentMessages.length === 0) {
    process.stderr.write("Error: no content messages in the specified range\n");
    process.exit(1);
  }

  process.stderr.write(
    `\nRoom: ${roomName} — "${meta.topic}"\n` +
      `Messages: ${filtered.length} total, ${contentMessages.length} content\n\n`,
  );

  // 4. TTS phase — generate audio for all content messages
  process.stderr.write("Generating TTS...\n");
  let done = 0;
  await Promise.all(
    contentMessages.map(async (msg) => {
      await generateAndCacheTts(roomName, msg.id, msg.content, msg.agent);
      done++;
      process.stderr.write(`  [${done}/${contentMessages.length}] ${msg.agent} (${msg.id})\n`);
    }),
  );

  // 5. Probe durations and build segments
  const segments: VideoSegment[] = [];
  let currentTime = 0;

  for (const msg of filtered) {
    if (isContentId(msg.id)) {
      const audioFile = ttsPath(roomName, msg.id);
      const duration = ffprobe(audioFile);
      const pause = PAUSE_MS / 1000;

      segments.push({
        id: msg.id,
        kind: msg.kind as VideoSegment["kind"],
        agent: msg.agent,
        text: msg.content,
        audioFile,
        startTime: currentTime,
        endTime: currentTime + duration,
        duration,
        pauseAfter: pause,
      });
      currentTime += duration + pause;
    } else {
      // Event messages — place at current time with 0 duration
      segments.push({
        id: msg.id,
        kind: msg.kind as VideoSegment["kind"],
        agent: msg.agent,
        text: msg.content,
        startTime: currentTime,
        endTime: currentTime,
        duration: 0,
        pauseAfter: 0,
      });
    }
  }

  const totalDuration = currentTime;

  // 6. Resolve participant metadata
  const salonConfig = await loadConfig();
  const roster = resolveRoster(salonConfig, PERSONALITY_PRESETS);
  const seenAgents = new Set(contentMessages.map((m) => m.agent));
  const participants = [...seenAgents].map((name) => {
    const agent = roster.find((a) => a.personality.name === name);
    return {
      name,
      color: toHexColor((agent?.personality.color ?? "white") as AgentColor),
      voice: voiceFor(name),
      tagline: agent?.personality.tagline ?? "",
    };
  });

  // 7. Build manifest
  const manifest: VideoManifest = {
    meta: {
      room: roomName,
      topic: meta.topic,
      language: meta.language ?? "English",
      fromId: contentMessages[0].id,
      toId: contentMessages[contentMessages.length - 1].id,
      totalDuration,
      resolution: { w: WIDTH, h: HEIGHT },
    },
    participants,
    segments,
  };

  // 8. Write manifest
  const videoDir = join(ROOMS_DIR, roomName, "video");
  if (!existsSync(videoDir)) await mkdir(videoDir, { recursive: true });
  await writeFile(join(videoDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  process.stderr.write(`\nManifest written to ${join(videoDir, "manifest.json")}\n`);

  // 9. Concatenate audio
  const tmpDir = join("/tmp", `k2-video-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  const chunkPaths: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.audioFile) continue;
    chunkPaths.push(seg.audioFile);
    if (seg.pauseAfter > 0) {
      const silPath = join(tmpDir, `${String(i).padStart(4, "0")}-silence.mp3`);
      generateSilence(seg.pauseAfter * 1000, silPath);
      chunkPaths.push(silPath);
    }
  }

  const audioPath = join(videoDir, "audio.mp3");
  concatenateMp3s(chunkPaths, audioPath, tmpDir);
  process.stderr.write(`Audio concatenated → ${audioPath}\n`);

  // 10. Build ffmpeg filter graph
  const contentSegs = segments.filter((s) => s.audioFile);
  const colorMap = new Map(participants.map((p) => [p.name, p.color]));

  // Build drawtext filters for each content segment
  const drawtextFilters: string[] = [];

  // Static title
  const escapedTopic =
    meta.topic.length > 40
      ? escapeDrawtext(meta.topic.slice(0, 40) + "...")
      : escapeDrawtext(meta.topic);

  drawtextFilters.push(
    `drawtext=text='K2 Salon':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=120`,
  );
  drawtextFilters.push(
    `drawtext=text='${escapedTopic}':fontsize=28:fontcolor=0x9ca3af:x=(w-text_w)/2:y=180`,
  );

  // Per-segment speaker name + subtitle
  for (const seg of contentSegs) {
    const color = colorMap.get(seg.agent) ?? "#ffffff";
    const hexColor = color.replace("#", "0x");
    const name = escapeDrawtext(seg.agent);
    const subtitle =
      seg.text.length > 120
        ? escapeDrawtext(seg.text.slice(0, 120) + "...")
        : escapeDrawtext(seg.text);

    const fadeIn = Math.max(0, seg.startTime - 0.15);
    const fadeOut = seg.endTime + 0.15;

    drawtextFilters.push(
      `drawtext=text='● ${name}':fontsize=36:fontcolor=${hexColor}:x=(w-text_w)/2:y=1100:` +
        `enable='between(t,${fadeIn.toFixed(3)},${fadeOut.toFixed(3)})'`,
    );

    drawtextFilters.push(
      `drawtext=text='${subtitle}':fontsize=24:fontcolor=white:x=80:y=1200:` +
        `enable='between(t,${seg.startTime.toFixed(3)},${seg.endTime.toFixed(3)})':` +
        `line_spacing=8`,
    );
  }

  // Progress bar via drawbox
  drawtextFilters.push(
    `drawbox=x=80:y=1750:w='(${WIDTH - 160})*t/${totalDuration.toFixed(3)}':h=4:color=0x06b6d4:t=fill`,
  );
  // Progress bar background
  drawtextFilters.unshift(
    `drawbox=x=80:y=1750:w=${WIDTH - 160}:h=4:color=0x333333:t=fill`,
  );

  const filterGraph = [
    `color=c=0x1a1a2e:s=${WIDTH}x${HEIGHT}:d=${totalDuration.toFixed(3)}[bg]`,
    `[0:a]showwaves=s=800x200:mode=cline:rate=30:colors=0x6366f1[waves]`,
    `[bg][waves]overlay=(W-w)/2:700[v]`,
    `[v]${drawtextFilters.join(",")}[out]`,
  ].join(";");

  // 11. Render video
  const outPath = outputFile ?? join(videoDir, "shorts.mp4");
  process.stderr.write(`Rendering video → ${outPath}\n`);

  ffmpeg([
    "-i",
    audioPath,
    "-filter_complex",
    filterGraph,
    "-map",
    "[out]",
    "-map",
    "0:a",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-r",
    "30",
    "-pix_fmt",
    "yuv420p",
    "-shortest",
    outPath,
  ]);

  await rm(tmpDir, { recursive: true, force: true });
  process.stderr.write(`\nDone! ${outPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
```

**Step 2: Add Justfile entry**

Append to `Justfile` after the podcast section:

```
# Generate a YouTube Short video from a room's conversation
# Usage: just video <room-name>
#        just video <room-name> --from 10 --to 45
video *ARGS:
    bun run src/cli/video.ts {{ARGS}}
```

**Step 3: Run type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/cli/video.ts Justfile
git commit -m "feat: add video generation CLI for YouTube Shorts"
```

---

### Task 12: Update loadPreviousSessions for Infinity support

**Files:**
- Modify: `src/engine/persist.ts` (check that `maxMessages: Infinity` works with `.slice(-Infinity)`)

**Step 1: Verify behavior**

`[].slice(-Infinity)` returns the full array in JavaScript, so `loadPreviousSessions(roomName, Infinity)` already works. No code change needed. Verify with a quick test:

Run: `bun -e "console.log([1,2,3].slice(-Infinity))"`
Expected: `[1, 2, 3]`

If it works, skip to next task.

---

### Task 13: Update README.md

**Files:**
- Modify: `README.md`

**Step 1: Add video generation section**

Add after the Podcast section in README:

- Document `just video <room-name>` command
- Document `--from`/`--to` flags
- Document output files (manifest.json, audio.mp3, shorts.mp4)
- Note: requires ffmpeg + ffprobe

**Step 2: Update message ID documentation**

Note the new ID format `NNNN-m` / `NNNN-e` if transcript format is documented.

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add video generation to README"
```

---

### Task 14: End-to-end test

**Step 1: Create a fresh room and run a short session**

```bash
just room test-video
# Set topic, let 2-3 messages go, /quit
```

**Step 2: Verify transcript has new ID format**

```bash
cat rooms/test-video/001-session.md
# Should see #0000-e, #0001-e, #0002-m etc.
```

**Step 3: Generate video**

```bash
just video test-video
```

**Step 4: Verify outputs**

```bash
ls rooms/test-video/video/
# Should see: manifest.json, audio.mp3, shorts.mp4
```

**Step 5: Play the video**

```bash
mpv rooms/test-video/video/shorts.mp4
```

Verify: dark background, waveform, speaker names in color, subtitles, progress bar.

**Step 6: Final commit**

```bash
npx prettier --write .
git add -A
git commit -m "chore: format after video generation feature"
```
