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

export function playTts(
  filePath: string,
): { proc: ReturnType<typeof Bun.spawn>; done: Promise<void> } {
  const proc = Bun.spawn(["mpv", "--no-video", filePath], {
    stdout: "ignore",
    stderr: "ignore",
  });

  const done = new Promise<void>((resolve) => {
    proc.exited.then(() => resolve());
  });

  return { proc, done };
}
