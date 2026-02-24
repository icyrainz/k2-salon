import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { writeFile, mkdir, rm, readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  formatMessageToMarkdown,
  parseSessionMarkdown,
  parseSeedToMessages,
  TranscriptWriter,
  nextSessionNumber,
  loadRoomMeta,
  saveRoomMeta,
} from "./persist.js";
import type { RoomMessage } from "../core/types.js";

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

describe("formatMessageToMarkdown", () => {
  it("formats chat messages", () => {
    const md = formatMessageToMarkdown(
      makeMsg({ kind: "chat", agent: "Sage" }),
    );
    expect(md).toContain("**Sage**");
    expect(md).toContain("Hello world");
    expect(md).not.toMatch(/^>/); // not a blockquote
  });

  it("formats system messages as blockquotes", () => {
    const md = formatMessageToMarkdown(
      makeMsg({ kind: "system", agent: "SYSTEM", content: "Topic: AI" }),
    );
    expect(md).toMatch(/^>/);
    expect(md).toContain("**SYSTEM**");
    expect(md).toContain("Topic: AI");
  });

  it("formats join messages with [join] tag", () => {
    const md = formatMessageToMarkdown(
      makeMsg({ kind: "join", agent: "Riko", content: "hey" }),
    );
    expect(md).toMatch(/^>/);
    expect(md).toContain("[join]");
    expect(md).toContain("**Riko**");
  });

  it("formats leave messages with [leave] tag", () => {
    const md = formatMessageToMarkdown(
      makeMsg({ kind: "leave", agent: "Nova", content: "bye" }),
    );
    expect(md).toMatch(/^>/);
    expect(md).toContain("[leave]");
    expect(md).toContain("**Nova**");
  });

  it("formats user messages", () => {
    const md = formatMessageToMarkdown(
      makeMsg({ kind: "user", agent: "YOU", content: "My thought" }),
    );
    expect(md).toContain("**YOU**");
    expect(md).toContain("My thought");
    expect(md).not.toMatch(/^>/); // not a blockquote
  });

  it("returns empty string for unknown kind", () => {
    const md = formatMessageToMarkdown(makeMsg({ kind: "unknown" as any }));
    expect(md).toBe("");
  });

  it("includes message ID when present", () => {
    const md = formatMessageToMarkdown(
      makeMsg({ kind: "chat", agent: "Sage", id: "0042-m" }),
    );
    expect(md).toContain("#0042-m");
    expect(md).toContain("**Sage**");
  });

  it("omits message ID when empty", () => {
    const md = formatMessageToMarkdown(
      makeMsg({ kind: "chat", agent: "Sage", id: "" }),
    );
    expect(md).not.toContain("#");
  });
});

describe("parseSessionMarkdown", () => {
  it("strips frontmatter", () => {
    const content = `---
topic: "test"
session: 1
---

**Sage** *14:30*
Hello world`;
    const messages = parseSessionMarkdown(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].agent).toBe("Sage");
    expect(messages[0].content).toBe("Hello world");
  });

  it("parses chat messages", () => {
    const content = `**Sage** *14:30*
This is a chat message`;
    const messages = parseSessionMarkdown(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe("chat");
    expect(messages[0].agent).toBe("Sage");
  });

  it("parses user messages", () => {
    const content = `**YOU** *14:30*
My input here`;
    const messages = parseSessionMarkdown(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe("user");
    expect(messages[0].agent).toBe("YOU");
  });

  it("parses system messages", () => {
    const content = `> **SYSTEM** *14:30* — Topic: AI`;
    const messages = parseSessionMarkdown(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe("system");
  });

  it("parses join messages", () => {
    const content = `> **Sage** *14:30* [join] — Stoic philosopher`;
    const messages = parseSessionMarkdown(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe("join");
    expect(messages[0].agent).toBe("Sage");
  });

  it("parses leave messages", () => {
    const content = `> **Riko** *14:30* [leave] — gotta run`;
    const messages = parseSessionMarkdown(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe("leave");
    expect(messages[0].agent).toBe("Riko");
  });

  it("handles multiline chat content", () => {
    const content = `**Sage** *14:30*
First line
Second line
Third line`;
    const messages = parseSessionMarkdown(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("First line");
    expect(messages[0].content).toContain("Second line");
    expect(messages[0].content).toContain("Third line");
  });

  it("round-trips with formatMessageToMarkdown for chat", () => {
    const original = makeMsg({
      kind: "chat",
      agent: "Sage",
      content: "Round trip test",
    });
    const md = formatMessageToMarkdown(original);
    const parsed = parseSessionMarkdown(md);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].agent).toBe("Sage");
    expect(parsed[0].content).toBe("Round trip test");
    expect(parsed[0].kind).toBe("chat");
  });

  it("round-trips with formatMessageToMarkdown for system", () => {
    const original = makeMsg({
      kind: "system",
      agent: "SYSTEM",
      content: "Topic: Test",
    });
    const md = formatMessageToMarkdown(original);
    const parsed = parseSessionMarkdown(md);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].kind).toBe("system");
    expect(parsed[0].content).toBe("Topic: Test");
  });

  it("returns empty for empty content", () => {
    expect(parseSessionMarkdown("")).toHaveLength(0);
    expect(parseSessionMarkdown("---\ntopic: test\n---")).toHaveLength(0);
  });

  it("parses message ID from chat header", () => {
    const content = `**Sage** *14:30* #0042-m\nHello world`;
    const messages = parseSessionMarkdown(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("0042-m");
    expect(messages[0].content).toBe("Hello world");
  });

  it("parses message ID from event header", () => {
    const content = `> **Sage** *14:30* #0005-e [join] — Stoic philosopher`;
    const messages = parseSessionMarkdown(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("0005-e");
    expect(messages[0].kind).toBe("join");
  });

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
});

describe("parseSeedToMessages", () => {
  it("parses ## User sections", () => {
    const content = `## User
What do you think about AI?`;
    const messages = parseSeedToMessages(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe("user");
    expect(messages[0].agent).toBe("YOU");
    expect(messages[0].content).toContain("AI");
  });

  it("parses ## Assistant sections", () => {
    const content = `## Assistant (GPT-4)
I think AI is fascinating.`;
    const messages = parseSeedToMessages(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe("chat");
    expect(messages[0].agent).toBe("PRIOR");
  });

  it("parses # Title sections as system messages", () => {
    const content = `# Discussion on AI Ethics`;
    const messages = parseSeedToMessages(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe("system");
    expect(messages[0].content).toContain("Discussion on AI Ethics");
  });

  it("skips short content blocks (<20 chars)", () => {
    const content = `short text`;
    const messages = parseSeedToMessages(content);
    expect(messages).toHaveLength(0);
  });

  it("includes long generic content blocks", () => {
    const content = `This is a longer content block that exceeds twenty characters easily.`;
    const messages = parseSeedToMessages(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe("system");
  });

  it("handles multiple sections separated by ---", () => {
    const content = `## User
What about AI?

---

## Assistant
AI is complex and nuanced.`;
    const messages = parseSeedToMessages(content);
    expect(messages).toHaveLength(2);
    expect(messages[0].kind).toBe("user");
    expect(messages[1].kind).toBe("chat");
  });
});

// ── File-system tests (using temp directories) ─────────────────────

describe("TranscriptWriter", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmpDir = join(
      tmpdir(),
      `k2-persist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(join(tmpDir, "rooms", "test-room"), { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("init -> append -> finalize flow", async () => {
    const writer = new TranscriptWriter("test-room", 1, "Test topic");
    await writer.init(["Sage", "Riko"]);

    // Append a chat message (substantive — triggers file creation)
    await writer.append(
      makeMsg({ kind: "chat", agent: "Sage", content: "First message" }),
    );

    const filePath = join(tmpDir, "rooms", "test-room", "001-session.md");
    expect(existsSync(filePath)).toBe(true);

    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("Test topic");
    expect(content).toContain("Sage");
    expect(content).toContain("First message");

    // Finalize adds ended timestamp
    await writer.finalize();
    const final = await readFile(filePath, "utf-8");
    expect(final).toContain("ended:");
  });

  it("buffers system/join messages until first chat", async () => {
    const writer = new TranscriptWriter("test-room", 1, "Test topic");
    await writer.init(["Sage"]);

    // System and join messages should be buffered
    await writer.append(
      makeMsg({ kind: "system", agent: "SYSTEM", content: "Topic set" }),
    );
    await writer.append(
      makeMsg({ kind: "join", agent: "Sage", content: "joined" }),
    );

    const filePath = join(tmpDir, "rooms", "test-room", "001-session.md");
    expect(existsSync(filePath)).toBe(false); // not created yet

    // First chat message triggers flush
    await writer.append(
      makeMsg({ kind: "chat", agent: "Sage", content: "Hello!" }),
    );
    expect(existsSync(filePath)).toBe(true);

    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("Topic set");
    expect(content).toContain("joined");
    expect(content).toContain("Hello!");
  });
});

describe("nextSessionNumber", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmpDir = join(
      tmpdir(),
      `k2-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(join(tmpDir, "rooms"), { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 1 for empty room", async () => {
    const num = await nextSessionNumber("nonexistent-room");
    expect(num).toBe(1);
  });

  it("returns max+1 for existing sessions", async () => {
    const dir = join(tmpDir, "rooms", "existing-room");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "001-session.md"), "test");
    await writeFile(join(dir, "003-session.md"), "test");
    const num = await nextSessionNumber("existing-room");
    expect(num).toBe(4);
  });
});

describe("loadRoomMeta / saveRoomMeta", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmpDir = join(
      tmpdir(),
      `k2-meta-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(join(tmpDir, "rooms"), { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null for nonexistent room", async () => {
    const meta = await loadRoomMeta("nonexistent");
    expect(meta).toBeNull();
  });

  it("round-trips save and load", async () => {
    const meta = {
      topic: "AI Safety",
      language: "English",
      created: new Date().toISOString(),
      lastSession: 3,
      activeRoster: ["Sage", "Riko"],
    };
    await saveRoomMeta("roundtrip-room", meta);
    const loaded = await loadRoomMeta("roundtrip-room");
    expect(loaded).not.toBeNull();
    expect(loaded!.topic).toBe("AI Safety");
    expect(loaded!.lastSession).toBe(3);
    expect(loaded!.activeRoster).toEqual(["Sage", "Riko"]);
  });
});
