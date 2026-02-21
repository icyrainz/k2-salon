/**
 * Podcast generator — converts a simulation markdown report into audio.
 *
 * Reads a simulation report from stdin (or a file), synthesises each
 * agent turn via OpenAI TTS, then concatenates everything into a single
 * MP3 using ffmpeg.
 *
 * Usage:
 *   just simulate "topic" | just podcast             # pipe directly
 *   just podcast report.md                           # from file
 *   just podcast report.md --out my-podcast.mp3      # custom output path
 *   just podcast report.md --model tts-1-hd          # HD quality
 *
 * Requires:
 *   - OPENAI_API_KEY in .env or environment
 *   - ffmpeg on PATH (for concatenation)
 */

import { readFile, writeFile, mkdir, rm, stat } from "fs/promises";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";

// ── OpenAI TTS voices ───────────────────────────────────────────────
// Mapped to personalities by character feel.

type TtsVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

const VOICE_MAP: Record<string, TtsVoice> = {
  Sage:   "onyx",     // Stoic, measured — deep and calm
  Nova:   "nova",     // Activist, passionate — bright and warm
  Riko:   "echo",     // Startup founder — crisp
  DocK:   "alloy",    // Scientist, dry — matter-of-fact
  Wren:   "fable",    // Devil's advocate — distinctive
  Jules:  "shimmer",  // Diplomat, worldly — warm
  Chip:   "echo",     // GenZ tech worker — energetic
  Ora:    "nova",     // Mindfulness teacher — serene
  YOU:    "alloy",
};

// Stable fallback for any agent not in the map
const FALLBACK_VOICES: TtsVoice[] = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
const fallbackAssigned = new Map<string, TtsVoice>();

function voiceFor(agent: string): TtsVoice {
  if (VOICE_MAP[agent]) return VOICE_MAP[agent];
  if (!fallbackAssigned.has(agent)) {
    fallbackAssigned.set(agent, FALLBACK_VOICES[fallbackAssigned.size % FALLBACK_VOICES.length]);
  }
  return fallbackAssigned.get(agent)!;
}

// ── Parse CLI args ──────────────────────────────────────────────────

const args = process.argv.slice(2);

let inputFile: string | null = null;
let outputFile = "podcast.mp3";
let ttsModel: "tts-1" | "tts-1-hd" = "tts-1";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && args[i + 1]) {
    outputFile = args[++i];
  } else if (args[i] === "--model" && args[i + 1]) {
    const m = args[++i];
    if (m === "tts-1-hd") ttsModel = "tts-1-hd";
  } else if (!args[i].startsWith("--")) {
    inputFile = args[i];
  }
}

// ── Segment types ────────────────────────────────────────────────────

interface Segment {
  agent: string;
  voice: TtsVoice;
  text: string;
  /** silence in milliseconds to insert AFTER this segment */
  pauseMs: number;
}

// ── Parse the simulation markdown report ────────────────────────────

function parseReport(markdown: string): Segment[] {
  const segments: Segment[] = [];
  const lines = markdown.split("\n");

  // Extract topic from the metadata block
  let topic = "";
  for (const line of lines) {
    const m = line.match(/^\*\*Topic:\*\*\s+(.+)/);
    if (m) { topic = m[1].trim(); break; }
  }

  // Intro narration
  if (topic) {
    segments.push({
      agent: "HOST",
      voice: "shimmer",
      text: `Welcome to the k2 salon. Today's topic: ${topic}.`,
      pauseMs: 1200,
    });
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ### AgentName — chat turn header
    const chatHeader = line.match(/^### (.+)$/);
    if (chatHeader) {
      const agent = chatHeader[1].trim();
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("### ") && lines[i] !== "---") {
        bodyLines.push(lines[i]);
        i++;
      }
      const text = bodyLines.join("\n").trim();
      if (text) {
        segments.push({
          agent,
          voice: voiceFor(agent),
          text: `${agent}: ${text}`,
          pauseMs: 800,
        });
      }
      continue;
    }

    // *→ Name joined* — brief host narration
    const joinMatch = line.match(/^\*→ \*\*(.+?)\*\* joined/);
    if (joinMatch) {
      segments.push({
        agent: "HOST",
        voice: "shimmer",
        text: `${joinMatch[1]} has joined the conversation.`,
        pauseMs: 400,
      });
      i++;
      continue;
    }

    // *← Name left*
    const leaveMatch = line.match(/^\*← \*\*(.+?)\*\* left/);
    if (leaveMatch) {
      segments.push({
        agent: "HOST",
        voice: "shimmer",
        text: `${leaveMatch[1]} has stepped out.`,
        pauseMs: 400,
      });
      i++;
      continue;
    }

    // **[YOU]** — user interjection
    if (line.startsWith("**[YOU]**")) {
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== "" && !lines[i].startsWith("###")) {
        bodyLines.push(lines[i]);
        i++;
      }
      const text = bodyLines.join("\n").trim();
      if (text) {
        segments.push({
          agent: "YOU",
          voice: voiceFor("YOU"),
          text: `Host: ${text}`,
          pauseMs: 800,
        });
      }
      continue;
    }

    i++;
  }

  // Outro
  segments.push({
    agent: "HOST",
    voice: "shimmer",
    text: "That's all for today's salon. Thanks for listening.",
    pauseMs: 0,
  });

  return segments;
}

// ── Call OpenAI TTS API ──────────────────────────────────────────────

async function synthesise(text: string, voice: TtsVoice, model: string): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set in environment");

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
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

// ── ffmpeg helpers ───────────────────────────────────────────────────

function ffmpeg(args: string[]): void {
  const result = Bun.spawnSync(["ffmpeg", "-y", ...args], { stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg failed:\n${result.stderr ? new TextDecoder().decode(result.stderr) : "(no output)"}`);
  }
}

function generateSilence(ms: number, outPath: string): void {
  ffmpeg([
    "-f", "lavfi",
    "-i", "anullsrc=r=24000:cl=mono",
    "-t", (ms / 1000).toFixed(3),
    "-q:a", "9",
    "-acodec", "libmp3lame",
    outPath,
  ]);
}

function concatenateMp3s(inputPaths: string[], outputPath: string, tmpDir: string): void {
  const listPath = join(tmpDir, "concat.txt");
  writeFileSync(listPath, inputPaths.map(p => `file '${p}'`).join("\n"));
  ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath]);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  // Read input markdown
  let markdown: string;
  if (inputFile) {
    if (!existsSync(inputFile)) {
      process.stderr.write(`Error: file not found: ${inputFile}\n`);
      process.exit(1);
    }
    markdown = await readFile(inputFile, "utf-8");
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    markdown = Buffer.concat(chunks).toString("utf-8");
  }

  if (!markdown.trim()) {
    process.stderr.write("Error: no input — pipe a simulation report or pass a file path.\n");
    process.exit(1);
  }

  const segments = parseReport(markdown);
  if (segments.length === 0) {
    process.stderr.write("Error: no speakable segments found in the report.\n");
    process.exit(1);
  }

  const tmpDir = join("/tmp", `k2-podcast-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  process.stderr.write(`\nGenerating podcast — ${segments.length} segments, model: ${ttsModel}\n\n`);

  const chunkPaths: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const pad = String(i).padStart(4, "0");
    const segPath = join(tmpDir, `${pad}-speech.mp3`);
    const silPath = join(tmpDir, `${pad}-silence.mp3`);

    process.stderr.write(`  [${i + 1}/${segments.length}] ${seg.agent} (${seg.voice})\n`);

    const audio = await synthesise(seg.text, seg.voice, ttsModel);
    await writeFile(segPath, audio);
    chunkPaths.push(segPath);

    if (seg.pauseMs > 0) {
      generateSilence(seg.pauseMs, silPath);
      chunkPaths.push(silPath);
    }
  }

  process.stderr.write(`\nConcatenating → ${outputFile}\n`);
  concatenateMp3s(chunkPaths, outputFile, tmpDir);

  await rm(tmpDir, { recursive: true, force: true });

  const { size } = await stat(outputFile);
  process.stderr.write(`Done!  ${outputFile}  (${(size / 1024 / 1024).toFixed(1)} MB)\n`);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
