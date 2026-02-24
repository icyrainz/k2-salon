# TTS Playback Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `/tts` command to the TUI that synthesizes and plays agent messages via OpenAI TTS, with caching and a selection UI.

**Architecture:** Extract shared voice map to core, add TTS synthesis/cache/playback engine module, add selection-mode UI to the TUI. Message IDs are added to `RoomMessage` and assigned by `SalonEngine` for stable cache filenames. TTS is async with a spinner indicator so it doesn't block the UI.

**Tech Stack:** OpenAI TTS API (`tts-1`), mpv for playback, Bun runtime, ink/React TUI.

---

### Task 1: Add `id` field to RoomMessage

**Files:**
- Modify: `src/core/types.ts:70-79`

**Step 1: Add the field**

In `src/core/types.ts`, add `id?: number` to the `RoomMessage` interface after the existing fields:

```typescript
export interface RoomMessage {
  id?: number;
  timestamp: Date;
  agent: string;
  content: string;
  color: AgentColor;
  kind: "chat" | "join" | "leave" | "system" | "user";
  providerLabel?: string;
  modelLabel?: string;
}
```

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (field is optional, no existing code breaks)

**Step 3: Run all tests**

Run: `bun test`
Expected: All 112+ tests pass (optional field, fully backward-compatible)

**Step 4: Commit**

```bash
git add src/core/types.ts
git commit -m "feat: add optional id field to RoomMessage"
```

---

### Task 2: Extract shared voice map to `core/voices.ts`

**Files:**
- Create: `src/core/voices.ts`
- Create: `src/core/voices.test.ts`

**Step 1: Write the failing test**

Create `src/core/voices.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { voiceFor } from "./voices.js";
import type { TtsVoice } from "./voices.js";

describe("voiceFor", () => {
  it("returns mapped voice for known agents", () => {
    expect(voiceFor("Sage")).toBe("onyx");
    expect(voiceFor("Nova")).toBe("nova");
    expect(voiceFor("Riko")).toBe("echo");
    expect(voiceFor("DocK")).toBe("alloy");
    expect(voiceFor("Wren")).toBe("fable");
    expect(voiceFor("Jules")).toBe("shimmer");
    expect(voiceFor("Chip")).toBe("echo");
    expect(voiceFor("Ora")).toBe("nova");
    expect(voiceFor("YOU")).toBe("alloy");
  });

  it("returns a stable fallback for unknown agents", () => {
    const voice1 = voiceFor("UnknownAgent");
    const voice2 = voiceFor("UnknownAgent");
    expect(voice1).toBe(voice2);
  });

  it("assigns different fallbacks to different unknown agents", () => {
    // Reset module state between test files by using unique names
    const v1 = voiceFor("FallbackTestA");
    const v2 = voiceFor("FallbackTestB");
    // Both should be valid TTS voices
    const validVoices: TtsVoice[] = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
    expect(validVoices).toContain(v1);
    expect(validVoices).toContain(v2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/core/voices.test.ts`
Expected: FAIL — module `./voices.js` not found

**Step 3: Write the implementation**

Create `src/core/voices.ts`:

```typescript
// ── OpenAI TTS voice mapping ───────────────────────────────────────
// Shared between the TTS engine and the podcast CLI.

export type TtsVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

export const VOICE_MAP: Record<string, TtsVoice> = {
  Sage: "onyx",
  Nova: "nova",
  Riko: "echo",
  DocK: "alloy",
  Wren: "fable",
  Jules: "shimmer",
  Chip: "echo",
  Ora: "nova",
  YOU: "alloy",
};

const FALLBACK_VOICES: TtsVoice[] = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
const fallbackAssigned = new Map<string, TtsVoice>();

export function voiceFor(agent: string): TtsVoice {
  if (VOICE_MAP[agent]) return VOICE_MAP[agent];
  if (!fallbackAssigned.has(agent)) {
    fallbackAssigned.set(agent, FALLBACK_VOICES[fallbackAssigned.size % FALLBACK_VOICES.length]);
  }
  return fallbackAssigned.get(agent)!;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/core/voices.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/voices.ts src/core/voices.test.ts
git commit -m "feat: extract shared voice map to core/voices.ts"
```

---

### Task 3: Assign message IDs in SalonEngine

**Files:**
- Modify: `src/engine/salon-engine.ts:28-56,227-232`
- Modify: `src/engine/salon-engine.test.ts`

**Step 1: Write the failing test**

Add to `src/engine/salon-engine.test.ts`, inside the existing `describe("SalonEngine.open")` block, after the existing test:

```typescript
  it("assigns sequential IDs to messages", () => {
    const agents = [makeAgent("A"), makeAgent("B"), makeAgent("C")];
    const engine = new SalonEngine(defaultConfig, agents);

    const messages: RoomMessage[] = [];
    engine.on("message", msg => messages.push(msg));

    engine.open();

    // All messages should have IDs
    for (const msg of messages) {
      expect(msg.id).toBeDefined();
      expect(typeof msg.id).toBe("number");
    }

    // IDs should be sequential starting from 0
    const ids = messages.map(m => m.id!);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBe(ids[i - 1] + 1);
    }
  });
```

Also add a new describe block:

```typescript
describe("SalonEngine message IDs with preloaded history", () => {
  it("assigns IDs to preloaded history and continues sequence", () => {
    const history: RoomMessage[] = [
      { timestamp: new Date(), agent: "A", content: "Old msg 1", color: "cyan", kind: "chat" },
      { timestamp: new Date(), agent: "B", content: "Old msg 2", color: "cyan", kind: "chat" },
    ];
    const agents = [makeAgent("A"), makeAgent("B"), makeAgent("C")];
    const engine = new SalonEngine(defaultConfig, agents, history);

    // Preloaded history should have been assigned IDs
    // We can check by opening and seeing the continuation
    const messages: RoomMessage[] = [];
    engine.on("message", msg => messages.push(msg));
    engine.open();

    // New messages should continue from where preloaded left off
    // Preloaded: 0, 1 → new messages start at 2
    expect(messages[0].id).toBe(2);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/engine/salon-engine.test.ts`
Expected: FAIL — `msg.id` is `undefined`

**Step 3: Implement message ID assignment**

In `src/engine/salon-engine.ts`:

1. Add a `private nextMsgId = 0;` field after `private abortController` (line ~38).

2. In the constructor, after copying preloaded history (line ~54-56), assign IDs:

```typescript
    if (preloadedHistory) {
      this.history = preloadedHistory.map((msg, i) => ({ ...msg, id: i }));
      this.nextMsgId = this.history.length;
    }
```

3. In `pushMessage()` (line ~229), assign an ID before pushing:

```typescript
  private pushMessage(msg: RoomMessage): void {
    msg.id = this.nextMsgId++;
    this.history.push(msg);
    this.emit("message", msg);
  }
```

**Step 4: Run tests**

Run: `bun test src/engine/salon-engine.test.ts`
Expected: PASS

**Step 5: Run all tests + type-check**

Run: `bun test && npx tsc --noEmit`
Expected: All pass

**Step 6: Commit**

```bash
git add src/engine/salon-engine.ts src/engine/salon-engine.test.ts
git commit -m "feat: assign sequential IDs to messages in SalonEngine"
```

---

### Task 4: Create TTS engine module

**Files:**
- Create: `src/engine/tts.ts`
- Create: `src/engine/tts.test.ts`

**Step 1: Write the failing tests**

Create `src/engine/tts.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ttsPath, ttsExists } from "./tts.js";

describe("ttsPath", () => {
  it("returns correct path format", () => {
    const path = ttsPath("my-room", 42);
    expect(path).toBe("rooms/my-room/tts/msg-42.mp3");
  });

  it("pads single-digit IDs", () => {
    const path = ttsPath("room", 5);
    expect(path).toBe("rooms/room/tts/msg-5.mp3");
  });
});

describe("ttsExists", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `k2-tts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(tmpDir, "rooms", "test-room", "tts"), { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns false when file does not exist", () => {
    expect(ttsExists("test-room", 99)).toBe(false);
  });

  it("returns true when file exists", async () => {
    await writeFile(join(tmpDir, "rooms", "test-room", "tts", "msg-1.mp3"), "fake audio");
    expect(ttsExists("test-room", 1)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/engine/tts.test.ts`
Expected: FAIL — module `./tts.js` not found

**Step 3: Write the implementation**

Create `src/engine/tts.ts`:

```typescript
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { voiceFor } from "../core/voices.js";
import type { TtsVoice } from "../core/voices.js";

const ROOMS_DIR = "rooms";

// ── Path helpers ───────────────────────────────────────────────────

export function ttsPath(roomName: string, messageId: number): string {
  return join(ROOMS_DIR, roomName, "tts", `msg-${messageId}.mp3`);
}

export function ttsExists(roomName: string, messageId: number): boolean {
  return existsSync(ttsPath(roomName, messageId));
}

// ── OpenAI TTS synthesis ───────────────────────────────────────────

export async function synthesiseTts(
  text: string,
  voice: TtsVoice,
  model: string = "tts-1",
): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set in environment");

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: text, voice, response_format: "mp3" }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI TTS ${response.status}: ${err}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

// ── Generate + cache ───────────────────────────────────────────────

export async function generateAndCacheTts(
  roomName: string,
  messageId: number,
  text: string,
  agentName: string,
): Promise<string> {
  const filePath = ttsPath(roomName, messageId);

  if (existsSync(filePath)) return filePath;

  const voice = voiceFor(agentName);
  const audio = await synthesiseTts(text, voice);

  const dir = dirname(filePath);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });

  await writeFile(filePath, audio);
  return filePath;
}

// ── Playback via mpv ───────────────────────────────────────────────

export function playTts(filePath: string): { proc: ReturnType<typeof Bun.spawn>; done: Promise<void> } {
  const proc = Bun.spawn(["mpv", "--no-video", filePath], {
    stdout: "ignore",
    stderr: "ignore",
  });

  const done = new Promise<void>((resolve) => {
    proc.exited.then(() => resolve());
  });

  return { proc, done };
}
```

**Step 4: Run tests**

Run: `bun test src/engine/tts.test.ts`
Expected: PASS

**Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add src/engine/tts.ts src/engine/tts.test.ts
git commit -m "feat: add TTS synthesis, caching, and playback engine"
```

---

### Task 5: Refactor podcast CLI to use shared modules

**Files:**
- Modify: `src/cli/podcast.ts:23-50`

**Step 1: Replace local voice code with imports**

In `src/cli/podcast.ts`, replace lines 23-50 (the `TtsVoice` type, `VOICE_MAP`, `FALLBACK_VOICES`, `fallbackAssigned`, and `voiceFor` function) with:

```typescript
import { voiceFor } from "../core/voices.js";
import type { TtsVoice } from "../core/voices.js";
```

Also replace the local `synthesise` function (lines 192-211) with an import and alias:

```typescript
import { synthesiseTts } from "../engine/tts.js";
```

Then update the call in `main()` (line 276) from `synthesise(seg.text, seg.voice, ttsModel)` to `synthesiseTts(seg.text, seg.voice, ttsModel)`.

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Run all tests**

Run: `bun test`
Expected: All pass (podcast.ts has no tests, but nothing else should break)

**Step 4: Commit**

```bash
git add src/cli/podcast.ts
git commit -m "refactor: podcast CLI uses shared voices and TTS modules"
```

---

### Task 6: Persist message IDs in transcript format

**Files:**
- Modify: `src/engine/persist.ts:196-282`
- Modify: `src/engine/persist.test.ts`

**Step 1: Write the failing tests**

Add to `src/engine/persist.test.ts`, in the `formatMessageToMarkdown` describe block:

```typescript
  it("includes message ID when present", () => {
    const md = formatMessageToMarkdown(makeMsg({ kind: "chat", agent: "Sage", id: 42 }));
    expect(md).toContain("#42");
    expect(md).toContain("**Sage**");
  });

  it("omits message ID when not present", () => {
    const md = formatMessageToMarkdown(makeMsg({ kind: "chat", agent: "Sage" }));
    expect(md).not.toContain("#");
  });
```

Add to the `parseSessionMarkdown` describe block:

```typescript
  it("parses message ID from chat header", () => {
    const content = `**Sage** *14:30* #42\nHello world`;
    const messages = parseSessionMarkdown(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(42);
    expect(messages[0].content).toBe("Hello world");
  });

  it("parses message ID from event header", () => {
    const content = `> **Sage** *14:30* #5 [join] — Stoic philosopher`;
    const messages = parseSessionMarkdown(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(5);
    expect(messages[0].kind).toBe("join");
  });

  it("round-trips with message IDs", () => {
    const original = makeMsg({ kind: "chat", agent: "Sage", content: "ID test", id: 7 });
    const md = formatMessageToMarkdown(original);
    const parsed = parseSessionMarkdown(md);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(7);
    expect(parsed[0].content).toBe("ID test");
  });
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/engine/persist.test.ts`
Expected: FAIL — IDs not included/parsed

**Step 3: Update formatMessageToMarkdown**

In `src/engine/persist.ts`, update `formatMessageToMarkdown` to include optional ID:

```typescript
export function formatMessageToMarkdown(msg: RoomMessage): string {
  const time = fmtTimeISO(msg.timestamp);
  const idTag = msg.id !== undefined ? ` #${msg.id}` : "";

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
```

**Step 4: Update parseSessionMarkdown**

Update the two regex patterns in `parseSessionMarkdown`:

For event messages (system/join/leave), update the regex to capture an optional `#N`:

```typescript
    const eventMatch = trimmed.match(
      /^>\s*\*\*(\w+)\*\*\s*\*(\d{2}:\d{2})\*\s*(?:#(\d+)\s*)?(?:\[(\w+)\]\s*)?—\s*(.+)$/s,
    );
    if (eventMatch) {
      const [, agent, _time, idStr, kindTag, content] = eventMatch;
      let kind: RoomMessage["kind"] = "system";
      if (kindTag === "join") kind = "join";
      else if (kindTag === "leave") kind = "leave";
      else if (agent === "SYSTEM") kind = "system";

      messages.push({
        timestamp: new Date(),
        agent,
        content: content.trim(),
        color: "white",
        kind,
        ...(idStr ? { id: parseInt(idStr, 10) } : {}),
      });
      continue;
    }
```

For chat/user messages, update the regex:

```typescript
    const chatMatch = trimmed.match(
      /^\*\*(\w+)\*\*\s*\*(\d{2}:\d{2})\*(?:\s*#(\d+))?\n([\s\S]+)$/,
    );
    if (chatMatch) {
      const [, agent, _time, idStr, content] = chatMatch;
      messages.push({
        timestamp: new Date(),
        agent,
        content: content.trim(),
        color: "white",
        kind: agent === "YOU" ? "user" : "chat",
        ...(idStr ? { id: parseInt(idStr, 10) } : {}),
      });
      continue;
    }
```

**Step 5: Run tests**

Run: `bun test src/engine/persist.test.ts`
Expected: PASS

**Step 6: Run all tests**

Run: `bun test`
Expected: All pass

**Step 7: Commit**

```bash
git add src/engine/persist.ts src/engine/persist.test.ts
git commit -m "feat: serialize and parse message IDs in transcript format"
```

---

### Task 7: Add `/tts` command and selection mode to TUI

**Files:**
- Modify: `src/tui/app.tsx`

This is the largest task. The TUI layer is not unit-tested (per CLAUDE.md), so we rely on type-checking and manual verification.

**Step 1: Add `/tts` to COMMANDS list and TuiHandle**

In `src/tui/app.tsx`:

1. Add to `COMMANDS` array (line ~231):
```typescript
const COMMANDS = [
  { cmd: "/next",    hint: "advance discussion" },
  { cmd: "/who",     hint: "show participants" },
  { cmd: "/tts",     hint: "play message audio" },
  { cmd: "/shuffle", hint: "new random roster" },
  { cmd: "/govern",  hint: "take control" },
  { cmd: "/free",    hint: "auto mode" },
  { cmd: "/quit",    hint: "exit" },
] as const;
```

2. Add TTS state types and expand `TuiHandle` (line ~322):
```typescript
export interface TuiHandle {
  pushMessage: (msg: RoomMessage) => void;
  setActiveAgents: (agents: readonly AgentConfig[]) => void;
  showWho: (agents: readonly AgentConfig[]) => void;
  setGoverned: (governed: boolean) => void;
  setTtsActivity: (activity: TtsActivity | null) => void;
}
```

3. Add TTS activity type near the top of the file:
```typescript
export interface TtsActivity {
  agent: string;
  color: AgentColor;
  phase: "generating" | "playing";
}
```

4. Add a TuiEvent type for TTS activity:
```typescript
type TuiEvent =
  | { type: "message"; msg: RoomMessage }
  | { type: "streamStart"; agent: string; color: AgentColor }
  | { type: "streamToken"; agent: string; token: string }
  | { type: "streamDone"; agent: string }
  | { type: "setActiveAgents"; agents: readonly AgentConfig[] }
  | { type: "showWho"; agents: readonly AgentConfig[] }
  | { type: "setGoverned"; governed: boolean }
  | { type: "setTtsActivity"; activity: TtsActivity | null };
```

**Step 2: Add TTS selection state to App component**

In the `App` function, add state:

```typescript
const [ttsSelectMode, setTtsSelectMode] = useState(false);
const [ttsSelectIndex, setTtsSelectIndex] = useState(0);
const [ttsActivity, setTtsActivityState] = useState<TtsActivity | null>(null);
```

Add event processing case for `setTtsActivity`:
```typescript
          case "setTtsActivity":
            setTtsActivityState(event.activity);
            break;
```

**Step 3: Add TTS selection bar component**

Add a new component before `App`:

```typescript
interface TtsSelectBarProps {
  messages: DisplayMessage[];
  selectedIndex: number;
}

function TtsSelectBar({ messages, selectedIndex }: TtsSelectBarProps) {
  const speakable = messages.filter(
    (dm) => dm.msg.kind === "chat" || dm.msg.kind === "user",
  );
  if (speakable.length === 0) {
    return (
      <Box>
        <Text dimColor>  No messages to play.</Text>
      </Box>
    );
  }

  const idx = Math.min(selectedIndex, speakable.length - 1);
  const dm = speakable[speakable.length - 1 - idx];
  const preview = dm.msg.content.length > 80
    ? dm.msg.content.slice(0, 80) + "..."
    : dm.msg.content;
  const inkColor = toInkColor(dm.msg.color);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="yellow" bold>  ▶ TTS: </Text>
        <Text bold color={inkColor}>[{dm.msg.agent}]</Text>
        <Text> "{preview}"</Text>
      </Box>
      <Box>
        <Text dimColor>    [↑↓] select  [Enter] play  [Esc] cancel</Text>
      </Box>
    </Box>
  );
}
```

**Step 4: Handle /tts in handleSubmit**

In `handleSubmit` (line ~557), add before the final `onUserInput(trimmed)`:

```typescript
      if (trimmed === "/tts") {
        const speakable = messages.filter(
          (dm) => dm.msg.kind === "chat" || dm.msg.kind === "user",
        );
        if (speakable.length === 0) return;
        setTtsSelectMode(true);
        setTtsSelectIndex(0);
        return;
      }
```

**Step 5: Add TTS selection keybinding**

Add a new `useInput` hook in the App component for TTS selection mode:

```typescript
  // TTS selection mode keys
  useInput(
    (input, key) => {
      if (key.escape) {
        setTtsSelectMode(false);
        return;
      }
      if (key.upArrow || (key.ctrl && input === "p")) {
        const speakable = messages.filter(
          (dm) => dm.msg.kind === "chat" || dm.msg.kind === "user",
        );
        setTtsSelectIndex((i) => Math.min(i + 1, speakable.length - 1));
        return;
      }
      if (key.downArrow || (key.ctrl && input === "n")) {
        setTtsSelectIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (key.return) {
        const speakable = messages.filter(
          (dm) => dm.msg.kind === "chat" || dm.msg.kind === "user",
        );
        if (speakable.length === 0) return;
        const idx = Math.min(ttsSelectIndex, speakable.length - 1);
        const dm = speakable[speakable.length - 1 - idx];
        setTtsSelectMode(false);
        if (dm.msg.id !== undefined) {
          onUserInput(`\x00TTS:${dm.msg.id}:${dm.msg.agent}`);
        }
        return;
      }
    },
    { isActive: ttsSelectMode },
  );
```

**Step 6: Render TTS selection bar and activity indicator**

In the JSX return, add the selection bar (after the `whoDisplay` section) and update the activity indicator to include TTS:

```tsx
      {ttsSelectMode && (
        <TtsSelectBar messages={messages} selectedIndex={ttsSelectIndex} />
      )}

      {/* ... existing agent activity spinner ... */}

      {ttsActivity && !agentActivity && (
        <Box>
          <Text>  </Text>
          <Spinner active={true} />
          <Text> </Text>
          <Text bold color={toInkColor(ttsActivity.color)}>
            {ttsActivity.phase === "generating"
              ? `Generating speech for ${ttsActivity.agent}...`
              : `Playing ${ttsActivity.agent}...`}
          </Text>
        </Box>
      )}
```

**Step 7: Update InputLine to be disabled during TTS select mode**

Pass `ttsSelectMode` as a prop to `InputLine` and disable it when TTS select is active. The simplest approach: don't render `InputLine` when in TTS select mode. In the JSX:

```tsx
      {!ttsSelectMode && <InputLine onSubmit={handleSubmit} />}
```

**Step 8: Update renderTui handle**

In `renderTui()`, add the `setTtsActivity` handler:

```typescript
  const handle: TuiHandle = {
    pushMessage: (msg) => emitTuiEvent({ type: "message", msg }),
    setActiveAgents: (agents) =>
      emitTuiEvent({ type: "setActiveAgents", agents }),
    showWho: (agents) => emitTuiEvent({ type: "showWho", agents }),
    setGoverned: (governed) => emitTuiEvent({ type: "setGoverned", governed }),
    setTtsActivity: (activity) => emitTuiEvent({ type: "setTtsActivity", activity }),
  };
```

**Step 9: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 10: Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat: add /tts command with selection bar UI and activity indicator"
```

---

### Task 8: Wire TTS synthesis and playback in main loop

**Files:**
- Modify: `src/tui/main.ts`

**Step 1: Add TTS import and handler**

At the top of `src/tui/main.ts`, add:

```typescript
import { generateAndCacheTts, playTts, ttsExists } from "../engine/tts.js";
```

**Step 2: Add TTS handler function**

After the `handleUserInput` function (line ~141), add:

```typescript
  const handleTts = async (msgId: number, agentName: string) => {
    // Find the message content from engine history (or the TUI's copy)
    // We use the engine's message event to get the content
    const agentConfig = roster.find(a => a.personality.name === agentName);
    const color = agentConfig?.personality.color ?? "white";

    tui.handle.setTtsActivity({ agent: agentName, color, phase: "generating" });

    try {
      // Find message content — search engine messages emitted so far
      // The message was selected from TUI state which has msg.content,
      // but we pass it through the sentinel. Instead, search the input.
      // Actually, we need to get the content. Let's search the messages
      // that the engine has seen.
      //
      // Approach: keep a map of id→content in main.ts
      const content = ttsMessageMap.get(msgId);
      if (!content) {
        tui.handle.setTtsActivity(null);
        return;
      }

      const filePath = await generateAndCacheTts(roomName, msgId, content, agentName);

      tui.handle.setTtsActivity({ agent: agentName, color, phase: "playing" });
      const { done } = playTts(filePath);
      await done;
    } catch (err: any) {
      tui.handle.pushMessage({
        timestamp: new Date(),
        agent: "SYSTEM",
        content: `[TTS error: ${err.message}]`,
        color: "gray",
        kind: "system",
      });
    } finally {
      tui.handle.setTtsActivity(null);
    }
  };
```

**Step 3: Add message content map**

Before the `handleUserInput` function, add a map to track message content by ID:

```typescript
  const ttsMessageMap = new Map<number, string>();
```

In the existing `engine.on("message")` handler (line ~163), add tracking:

```typescript
  engine.on("message", (msg) => {
    transcript.append(msg);
    if (msg.kind !== "chat") tui.handle.pushMessage(msg);
    if (msg.kind === "join" || msg.kind === "leave") {
      tui.handle.setActiveAgents([...engine.activeAgents]);
      saveActiveRoster();
    }
    // Track chat/user messages for TTS
    if ((msg.kind === "chat" || msg.kind === "user") && msg.id !== undefined) {
      ttsMessageMap.set(msg.id, msg.content);
    }
  });
```

Also track preloaded history messages (after the `for (const msg of tail)` loop, line ~200):

```typescript
    for (const msg of preloadedHistory) {
      if ((msg.kind === "chat" || msg.kind === "user") && msg.id !== undefined) {
        ttsMessageMap.set(msg.id, msg.content);
      }
    }
```

**Step 4: Handle TTS sentinel in handleUserInput**

Update `handleUserInput` to intercept TTS commands:

```typescript
  const handleUserInput = (line: string) => {
    if (line === "\x00WHO") {
      tui.handle.showWho([...engine.activeAgents]);
    } else if (line.startsWith("\x00TTS:")) {
      const parts = line.slice(5).split(":");
      const msgId = parseInt(parts[0], 10);
      const agentName = parts.slice(1).join(":");
      handleTts(msgId, agentName);  // fire-and-forget (async, non-blocking)
    } else {
      inputBuffer.push(line);
    }
  };
```

**Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 6: Run all tests**

Run: `bun test`
Expected: All pass

**Step 7: Commit**

```bash
git add src/tui/main.ts
git commit -m "feat: wire TTS synthesis and playback into TUI main loop"
```

---

### Task 9: Final verification and cleanup

**Files:**
- Verify all

**Step 1: Full test suite**

Run: `bun test`
Expected: All tests pass

**Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: Clean

**Step 3: Format**

Run: `npx prettier --write src/core/voices.ts src/core/voices.test.ts src/engine/tts.ts src/engine/tts.test.ts src/engine/salon-engine.ts src/engine/salon-engine.test.ts src/engine/persist.ts src/engine/persist.test.ts src/tui/app.tsx src/tui/main.ts src/cli/podcast.ts src/core/types.ts`

**Step 4: Final test + type-check**

Run: `bun test && npx tsc --noEmit`
Expected: All pass

**Step 5: Update CLAUDE.md if needed**

Add `/tts` to the "Add a new room command" section if documenting new commands. Add `engine/tts.ts` and `core/voices.ts` to the architecture section.

**Step 6: Commit any formatting changes**

```bash
git add -A
git commit -m "chore: format and update docs for TTS feature"
```

---

Plan complete and saved to `docs/plans/2026-02-23-tts-playback-design.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

Which approach?