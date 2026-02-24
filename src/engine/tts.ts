import { writeFile, mkdir } from "fs/promises";
import { existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { voiceFor } from "../core/voices.js";
import type { TtsVoice } from "../core/voices.js";
import { tmpdir } from "os";

const ROOMS_DIR = "rooms";

// ── Path helpers ───────────────────────────────────────────────────

export function ttsPath(roomName: string, messageId: string): string {
  return join(ROOMS_DIR, roomName, "tts", `${messageId}.mp3`);
}

export function ttsExists(roomName: string, messageId: string): boolean {
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
  messageId: string,
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

export interface TtsProgress {
  position: number;
  duration: number;
  speed: number;
  paused: boolean;
}

export function playTts(
  filePath: string,
  onProgress?: (progress: TtsProgress) => void,
): {
  proc: ReturnType<typeof Bun.spawn>;
  done: Promise<void>;
  /** Send an mpv input command via IPC (e.g. "seek 5", "cycle pause"). */
  sendCommand: (cmd: string) => void;
  cleanup: () => void;
} {
  const socketPath = join(tmpdir(), `k2-mpv-${Date.now()}.sock`);

  const proc = Bun.spawn(
    [
      "mpv",
      "--no-video",
      "--no-terminal",
      `--input-ipc-server=${socketPath}`,
      filePath,
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  // IPC socket connection (lazy — connects on first command)
  let socket: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  let socketReady: Promise<void> | null = null;
  let progressInterval: ReturnType<typeof setInterval> | null = null;
  let ipcBuffer = "";

  // Current known state from mpv
  const state: TtsProgress = {
    position: 0,
    duration: 0,
    speed: 1,
    paused: false,
  };

  const handleIpcData = (data: string) => {
    ipcBuffer += data;
    const lines = ipcBuffer.split("\n");
    ipcBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.event === "property-change" && msg.name && msg.data != null) {
          if (msg.name === "time-pos") state.position = msg.data;
          else if (msg.name === "duration") state.duration = msg.data;
          else if (msg.name === "speed") state.speed = msg.data;
          else if (msg.name === "pause") state.paused = msg.data;
        }
      } catch {}
    }
  };

  const ensureSocket = () => {
    if (socketReady) return socketReady;
    socketReady = new Promise<void>((resolve) => {
      let attempts = 0;
      const tryConnect = () => {
        Bun.connect({
          unix: socketPath,
          socket: {
            data(_s, data) {
              handleIpcData(new TextDecoder().decode(data));
            },
            open(s) {
              socket = s;
              // Observe properties for progress reporting
              s.write(
                JSON.stringify({
                  command: ["observe_property", 1, "time-pos"],
                }) + "\n",
              );
              s.write(
                JSON.stringify({
                  command: ["observe_property", 2, "duration"],
                }) + "\n",
              );
              s.write(
                JSON.stringify({ command: ["observe_property", 3, "speed"] }) +
                  "\n",
              );
              s.write(
                JSON.stringify({ command: ["observe_property", 4, "pause"] }) +
                  "\n",
              );
              // Poll progress to TUI at ~4Hz
              if (onProgress) {
                progressInterval = setInterval(
                  () => onProgress({ ...state }),
                  250,
                );
              }
              resolve();
            },
            error() {
              if (attempts++ < 20) setTimeout(tryConnect, 50);
              else resolve();
            },
            close() {
              socket = null;
            },
          },
        }).catch(() => {
          if (attempts++ < 20) setTimeout(tryConnect, 50);
          else resolve();
        });
      };
      tryConnect();
    });
    return socketReady;
  };

  // Start connecting immediately so progress is available from the start
  ensureSocket();

  const done = new Promise<void>((resolve) => {
    proc.exited.then(() => resolve());
  });

  const sendCommand = (cmd: string) => {
    const parts = cmd.split(/\s+/);
    const json = JSON.stringify({ command: parts }) + "\n";
    ensureSocket().then(() => {
      try {
        socket?.write(json);
      } catch {}
    });
  };

  const cleanup = () => {
    if (progressInterval) clearInterval(progressInterval);
    progressInterval = null;
    try {
      socket?.end();
    } catch {}
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath);
    } catch {}
  };

  return { proc, done, sendCommand, cleanup };
}
