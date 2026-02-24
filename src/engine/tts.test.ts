import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
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
    tmpDir = join(
      tmpdir(),
      `k2-tts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
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
    await writeFile(
      join(tmpDir, "rooms", "test-room", "tts", "msg-1.mp3"),
      "fake audio",
    );
    expect(ttsExists("test-room", 1)).toBe(true);
  });
});
