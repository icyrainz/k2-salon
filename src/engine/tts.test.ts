import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ttsPath, ttsExists } from "./tts.js";

describe("ttsPath", () => {
  it("returns correct path format", () => {
    const path = ttsPath("my-room", "0042-m");
    expect(path).toBe("rooms/my-room/tts/0042-m.mp3");
  });

  it("handles event IDs", () => {
    const path = ttsPath("room", "0005-e");
    expect(path).toBe("rooms/room/tts/0005-e.mp3");
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
    expect(ttsExists("test-room", "0099-m")).toBe(false);
  });

  it("returns true when file exists", async () => {
    await writeFile(
      join(tmpDir, "rooms", "test-room", "tts", "0001-m.mp3"),
      "fake audio",
    );
    expect(ttsExists("test-room", "0001-m")).toBe(true);
  });
});
