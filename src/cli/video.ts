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

import { writeFile, mkdir, rm } from "fs/promises";
import { existsSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { loadRoomMeta, loadPreviousSessions } from "../engine/persist.js";
import { generateAndCacheTts, synthesiseTts, ttsPath } from "../engine/tts.js";
import { voiceFor } from "../core/voices.js";
import { toHexColor } from "../tui/colors.js";
import { loadConfig, resolveRoster } from "../engine/config.js";
import { PERSONALITY_PRESETS } from "../core/roster.js";
import type { AgentColor, VideoManifest, VideoSegment } from "../core/types.js";
import { isContentId, parseId } from "../core/types.js";

const ROOMS_DIR = "rooms";
const WIDTH = 1080;
const HEIGHT = 1920;
const PAUSE_MS = 800;
function resolveFontPath(): string {
  const candidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  process.stderr.write(
    "Warning: no suitable font found, ffmpeg will use default bitmap font\n",
  );
  return "";
}

const FONT_PATH = resolveFontPath();
const OLLAMA_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:8b";

// ── Parse CLI args ──────────────────────────────────────────────────

const args = process.argv.slice(2);

let roomName = "";
let fromSeq: number | null = null;
let toSeq: number | null = null;
let outputFile: string | null = null;
let regenTts = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--from" && args[i + 1]) {
    fromSeq = parseInt(args[++i], 10);
  } else if (args[i] === "--to" && args[i + 1]) {
    toSeq = parseInt(args[++i], 10);
  } else if (args[i] === "--out" && args[i + 1]) {
    outputFile = args[++i];
  } else if (args[i] === "--regen") {
    regenTts = true;
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
  writeFileSync(
    listPath,
    inputPaths.map((p) => `file '${resolve(p)}'`).join("\n"),
  );
  ffmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    outputPath,
  ]);
}

// ── Escaping for ffmpeg drawtext ────────────────────────────────────

function escapeDrawtext(text: string): string {
  // Replace characters that break ffmpeg filter parsing with safe Unicode equivalents
  return text
    .replace(/\\/g, "\u2216") // ∖ set minus
    .replace(/'/g, "\u2019") // '  right single quote
    .replace(/"/g, "\u201C") // "  left double quote
    .replace(/;/g, "\uFF1B") // ；fullwidth semicolon
    .replace(/,/g, "\uFF0C") // ，fullwidth comma
    .replace(/:/g, "\uFF1A") // ：fullwidth colon
    .replace(/%/g, "\uFF05") // ％fullwidth percent
    .replace(/\[/g, "\uFF3B") // ［fullwidth left bracket
    .replace(/\]/g, "\uFF3D") // ］fullwidth right bracket
    .replace(/\n/g, " ");
}

/** Word-wrap text to fit within a character width, returning array of lines */
function wordWrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > maxChars && line.length > 0) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Split wrapped lines into subtitle chunks of N lines each, with word counts for timing */
function buildSubtitleChunks(
  lines: string[],
  linesPerChunk: number,
): { lines: string[]; wordCount: number }[] {
  const chunks: { lines: string[]; wordCount: number }[] = [];
  for (let i = 0; i < lines.length; i += linesPerChunk) {
    const chunkLines = lines.slice(i, i + linesPerChunk);
    const wordCount = chunkLines.join(" ").split(/\s+/).length;
    chunks.push({ lines: chunkLines, wordCount });
  }
  return chunks;
}

// ── Pexels stock video background ──────────────────────────────────

/** Use LLM to generate stock video search tags from a topic */
async function topicToQuery(topic: string): Promise<string> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          {
            role: "system",
            content: [
              "You are a stock footage search assistant.",
              "Given a discussion topic, produce 3-5 simple English search terms to find cinematic background videos on stock sites.",
              "",
              "Rules:",
              "- Output ONLY the keywords separated by spaces. No explanations, no numbering, no quotes.",
              "- Keywords must describe VISUAL things a camera can film: animals, objects, places, nature, actions.",
              "- Break compound topics into separate visual nouns. 'dog vs cat' → dog cat pet. 'AI and robotics' → robot technology.",
              "- Never output abstract words (philosophy, ethics, debate, discussion, comparison, versus).",
              "- Each keyword should work as a standalone search term on a stock footage site.",
              "- Prefer common single words over multi-word phrases. 'ocean' not 'vast blue ocean'.",
              "",
              "Examples:",
              'Topic: "dog vs cat" → dog cat pet animal',
              'Topic: "why is AI dangerous" → robot technology server neon',
              'Topic: "best Italian restaurants" → pasta cooking kitchen italian food',
              'Topic: "attack on titan" → city skyline dark clouds epic wall',
              'Topic: "climate change effects" → ocean glacier storm nature',
              'Topic: "coffee or tea" → coffee tea cafe drink',
              'Topic: "bàn luận về phim trấn thành" → cinema film theater vietnam',
            ].join("\n"),
          },
          { role: "user", content: `Topic: "${topic}"` },
        ],
        stream: false,
        think: false,
        options: { temperature: 0.5, num_predict: 40 },
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as any;
      const tags = data.message?.content?.trim();
      if (tags && tags.length > 0 && tags.length < 100) {
        process.stderr.write(`Search tags (LLM): "${tags}"\n`);
        return tags;
      }
    }
  } catch {
    // Fall through to basic extraction
  }

  // Fallback: basic keyword extraction
  process.stderr.write("LLM unavailable, using basic keyword extraction\n");
  const stopWords = new Set([
    "is",
    "the",
    "a",
    "an",
    "of",
    "to",
    "and",
    "in",
    "on",
    "for",
    "why",
    "how",
    "what",
    "are",
    "was",
    "so",
    "it",
    "its",
    "that",
    "this",
    "with",
    "do",
    "does",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "not",
    "but",
    "or",
    "as",
    "at",
    "by",
    "from",
  ]);
  const words = topic
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
  return words.slice(0, 4).join(" ") || topic.slice(0, 30);
}

interface PexelsVideoFile {
  link: string;
  quality: string;
  width: number;
  height: number;
}

interface PexelsVideo {
  id: number;
  video_files: PexelsVideoFile[];
}

/** Download a video URL to a local path */
async function downloadVideo(url: string, outPath: string): Promise<boolean> {
  const res = await fetch(url);
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(outPath, buf);
  return true;
}

/** Search Pexels for portrait videos, returns download URLs */
async function searchPexels(
  query: string,
  count: number,
): Promise<{ id: string; url: string; w: number; h: number }[]> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) return [];

  const url = new URL("https://api.pexels.com/videos/search");
  url.searchParams.set("query", query);
  url.searchParams.set("orientation", "portrait");
  url.searchParams.set("per_page", String(count));
  url.searchParams.set("size", "medium");

  const res = await fetch(url.toString(), {
    headers: { Authorization: apiKey },
  });
  if (!res.ok) return [];

  const data = (await res.json()) as { videos: PexelsVideo[] };
  if (!data.videos) return [];

  return data.videos
    .map((v) => {
      const file =
        v.video_files.find((f) => f.quality === "hd" && f.height > f.width) ??
        v.video_files.find((f) => f.quality === "hd") ??
        v.video_files[0];
      return file
        ? {
            id: `pexels-${v.id}`,
            url: file.link,
            w: file.width,
            h: file.height,
          }
        : null;
    })
    .filter(Boolean) as { id: string; url: string; w: number; h: number }[];
}

/** Search Pixabay for portrait videos, returns download URLs */
async function searchPixabay(
  query: string,
  count: number,
): Promise<{ id: string; url: string; w: number; h: number }[]> {
  const apiKey = process.env.PIXABAY_API_KEY;
  if (!apiKey) return [];

  const url = new URL("https://pixabay.com/api/videos/");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", String(count));
  url.searchParams.set("video_type", "all");

  const res = await fetch(url.toString());
  if (!res.ok) return [];

  const data = (await res.json()) as {
    hits: {
      id: number;
      videos: {
        large?: { url: string; width: number; height: number };
        medium?: { url: string; width: number; height: number };
        small?: { url: string; width: number; height: number };
      };
    }[];
  };
  if (!data.hits) return [];

  return data.hits
    .map((h) => {
      const file = h.videos.large ?? h.videos.medium ?? h.videos.small;
      return file
        ? {
            id: `pixabay-${h.id}`,
            url: file.url,
            w: file.width,
            h: file.height,
          }
        : null;
    })
    .filter(Boolean) as { id: string; url: string; w: number; h: number }[];
}

/** Fetch background clips from Pexels + Pixabay, cached in room dir */
async function fetchBackgroundClips(
  roomName: string,
  query: string,
): Promise<string[]> {
  const bgDir = join(ROOMS_DIR, roomName, "video", "bg");

  // Check cache
  if (existsSync(bgDir)) {
    const { readdir } = await import("fs/promises");
    const cached = (await readdir(bgDir))
      .filter((f) => f.endsWith(".mp4"))
      .sort();
    if (cached.length > 0) {
      process.stderr.write(
        `Background clips cached (${cached.length} clips), reusing\n`,
      );
      return cached.map((f) => join(bgDir, f));
    }
  }

  // Search both sources in parallel
  process.stderr.write(`Searching stock videos for "${query}"...\n`);
  const [pexelsResults, pixabayResults] = await Promise.all([
    searchPexels(query, 2),
    searchPixabay(query, 2),
  ]);

  const allResults = [...pexelsResults, ...pixabayResults];
  if (allResults.length === 0) {
    process.stderr.write("No stock video results — using solid background\n");
    return [];
  }

  process.stderr.write(
    `  Found ${pexelsResults.length} from Pexels, ${pixabayResults.length} from Pixabay\n`,
  );

  await mkdir(bgDir, { recursive: true });
  const paths: string[] = [];

  for (let i = 0; i < allResults.length; i++) {
    const clip = allResults[i];
    const outPath = join(bgDir, `${String(i).padStart(2, "0")}-${clip.id}.mp4`);
    process.stderr.write(`  Downloading ${clip.id} (${clip.w}x${clip.h})...\n`);
    if (await downloadVideo(clip.url, outPath)) {
      paths.push(outPath);
    }
  }

  process.stderr.write(`  ${paths.length} clips downloaded\n`);
  return paths;
}

/** Concat + loop background clips to fill a target duration, scale to 1080x1920 */
function buildLoopingBackground(
  clips: string[],
  totalDuration: number,
  tmpDir: string,
): string {
  // Normalize all clips to same resolution, framerate, and pixel format
  const normalizedPaths: string[] = [];
  for (let i = 0; i < clips.length; i++) {
    const outPath = join(tmpDir, `bg-norm-${i}.mp4`);
    ffmpeg([
      "-i",
      clips[i],
      "-vf",
      `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30`,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      outPath,
    ]);
    normalizedPaths.push(outPath);
  }

  // Build a concat list that repeats clips enough to fill total duration
  let totalClipDuration = 0;
  const clipDurations = normalizedPaths.map((p) => ffprobe(p));
  for (const d of clipDurations) totalClipDuration += d;

  const repeats = Math.ceil(totalDuration / totalClipDuration);
  const listPath = join(tmpDir, "bg-list.txt");
  const lines: string[] = [];
  for (let r = 0; r < repeats; r++) {
    for (const p of normalizedPaths) {
      lines.push(`file '${resolve(p)}'`);
    }
  }
  writeFileSync(listPath, lines.join("\n"));

  // Concat with re-encode to fix timestamps, trim to exact duration
  const loopedPath = join(tmpDir, "bg-looped.mp4");
  ffmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-t",
    totalDuration.toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    loopedPath,
  ]);

  return loopedPath;
}

// ── Intro narration script ──────────────────────────────────────────

async function buildIntroScript(
  topic: string,
  participants: { name: string; tagline: string }[],
  language: string,
): Promise<string> {
  const names = participants.map((p) => {
    return p.tagline ? `${p.name}, ${p.tagline}` : p.name;
  });

  // English default — no LLM needed
  if (language.toLowerCase() === "english") {
    let script = `Welcome to K2 Salon. Today's discussion: ${topic}. `;
    if (names.length === 1) {
      script += `Featuring ${names[0]}.`;
    } else if (names.length === 2) {
      script += `Featuring ${names[0]} and ${names[1]}.`;
    } else {
      const last = names.pop()!;
      script += `Featuring ${names.join(", ")}, and ${last}.`;
    }
    return script;
  }

  // Use LLM to generate intro in the target language
  const participantList = names.join("; ");

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          {
            role: "system",
            content:
              `You write podcast intro scripts in ${language}. ` +
              `Write a short, natural intro (2-3 sentences) for a discussion show called "K2 Salon". ` +
              `Include the topic and introduce the participants. ` +
              `Output ONLY the intro script text, nothing else. Keep participant names as-is (don't translate names).`,
          },
          {
            role: "user",
            content: `Topic: ${topic}\nParticipants: ${participantList}`,
          },
        ],
        stream: false,
        think: false,
        options: { temperature: 0.7, num_predict: 200 },
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as any;
      const script = data.message?.content?.trim();
      if (script && script.length > 10) {
        process.stderr.write(
          `Intro script (${language}, LLM): "${script.slice(0, 80)}..."\n`,
        );
        return script;
      }
    }
  } catch {
    // Fall through to English default
  }

  // Fallback to English
  process.stderr.write(
    `LLM unavailable for ${language} intro, using English\n`,
  );
  let script = `Welcome to K2 Salon. Today's discussion: ${topic}. `;
  const namesCopy = [...names];
  if (namesCopy.length === 1) {
    script += `Featuring ${namesCopy[0]}.`;
  } else if (namesCopy.length === 2) {
    script += `Featuring ${namesCopy[0]} and ${namesCopy[1]}.`;
  } else {
    const last = namesCopy.pop()!;
    script += `Featuring ${namesCopy.join(", ")}, and ${last}.`;
  }
  return script;
}

// ── Main pipeline ───────────────────────────────────────────────────

async function main() {
  if (!roomName) {
    process.stderr.write(
      "Usage: just video <room-name> [--from N] [--to N] [--out file.mp4] [--regen]\n",
    );
    process.exit(1);
  }

  // 1. Load room metadata
  const meta = await loadRoomMeta(roomName);
  if (!meta) {
    process.stderr.write(
      `Error: room "${roomName}" not found or has no room.yaml\n`,
    );
    process.exit(1);
  }

  // 2. Load all messages from all sessions
  const allMessages = await loadPreviousSessions(roomName, Infinity);
  if (allMessages.length === 0) {
    process.stderr.write(`Error: no messages found in room "${roomName}"\n`);
    process.exit(1);
  }

  // 3. Filter by --from/--to (content message sequence numbers)
  let filtered = allMessages;
  if (fromSeq !== null || toSeq !== null) {
    filtered = allMessages.filter((m) => {
      if (!m.id) return false;
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

  const contentMessages = filtered.filter((m) => m.id && isContentId(m.id));
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
      await generateAndCacheTts(roomName, msg.id!, msg.content, msg.agent);
      done++;
      process.stderr.write(
        `  [${done}/${contentMessages.length}] ${msg.agent} (${msg.id})\n`,
      );
    }),
  );

  // 5. Resolve participant metadata (needed for intro duration calc)
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

  // 6. Generate intro narration TTS
  const language = meta.language ?? "English";
  const introScript = await buildIntroScript(
    meta.topic,
    participants,
    language,
  );
  const introAudioPath = join(ROOMS_DIR, roomName, "tts", "intro.mp3");
  if (regenTts || !existsSync(introAudioPath)) {
    process.stderr.write("Generating intro narration...\n");
    const introAudio = await synthesiseTts(introScript, "onyx");
    const introDir = join(ROOMS_DIR, roomName, "tts");
    if (!existsSync(introDir)) await mkdir(introDir, { recursive: true });
    await writeFile(introAudioPath, introAudio);
  } else {
    process.stderr.write("Intro narration cached, reusing\n");
  }
  const INTRO_DURATION = ffprobe(introAudioPath) + 1; // +1s buffer after narration
  process.stderr.write(
    `Intro: ${INTRO_DURATION.toFixed(1)}s — "${introScript.slice(0, 60)}..."\n`,
  );

  const segments: VideoSegment[] = [];
  let currentTime = INTRO_DURATION;

  for (const msg of filtered) {
    if (msg.id && isContentId(msg.id)) {
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
        id: msg.id ?? "",
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

  // 7. Build manifest
  const manifest: VideoManifest = {
    meta: {
      room: roomName,
      topic: meta.topic,
      language: meta.language ?? "English",
      fromId: contentMessages[0].id!,
      toId: contentMessages[contentMessages.length - 1].id!,
      totalDuration,
      resolution: { w: WIDTH, h: HEIGHT },
    },
    participants,
    segments,
  };

  // 8. Write manifest
  const videoDir = join(ROOMS_DIR, roomName, "video");
  if (!existsSync(videoDir)) await mkdir(videoDir, { recursive: true });
  await writeFile(
    join(videoDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  process.stderr.write(
    `\nManifest written to ${join(videoDir, "manifest.json")}\n`,
  );

  // 9. Concatenate audio
  const tmpDir = join("/tmp", `k2-video-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  const chunkPaths: string[] = [];

  // Lead with intro narration + silence buffer to align with video timeline
  chunkPaths.push(introAudioPath);
  const introBufferMs = 1000; // 1s silence after narration, before conversation
  const introSilPath = join(tmpDir, "intro-buffer.mp3");
  generateSilence(introBufferMs, introSilPath);
  chunkPaths.push(introSilPath);

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

  // 10. Fetch Pexels background clips
  const query = await topicToQuery(meta.topic);
  const bgClips = await fetchBackgroundClips(roomName, query);
  let bgVideoPath: string | null = null;
  if (bgClips.length > 0) {
    process.stderr.write("Building looping background video...\n");
    bgVideoPath = buildLoopingBackground(bgClips, totalDuration, tmpDir);
  }

  // 11. Build ffmpeg filter graph
  const contentSegs = segments.filter((s) => s.audioFile);
  const colorMap = new Map(participants.map((p) => [p.name, p.color]));

  // Build drawtext filters for each content segment
  const drawtextFilters: string[] = [];

  const SUBTITLE_FONT_SIZE = 30;
  const SUBTITLE_LINE_HEIGHT = 46; // px per line with box padding
  const SUBTITLE_Y_START = 1450; // bottom third, above progress bar
  const FONT = FONT_PATH ? `:fontfile='${FONT_PATH}'` : "";
  const SUBTITLE_BOX = `:box=1:boxcolor=black@0.55:boxborderw=14`;
  const HEADER_BOX = `:box=1:boxcolor=black@0.6:boxborderw=10`;

  // Static title — always visible
  drawtextFilters.push(
    `drawtext=${FONT}:text='K2 Salon':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=40${HEADER_BOX}`,
  );

  // Topic — word-wrapped across multiple lines, always visible
  const topicLines = wordWrap(meta.topic, 38);
  for (let i = 0; i < topicLines.length; i++) {
    drawtextFilters.push(
      `drawtext=${FONT}:text='${escapeDrawtext(topicLines[i])}':fontsize=28:fontcolor=0xd1d5db:x=(w-text_w)/2:y=${108 + i * 36}${HEADER_BOX}`,
    );
  }

  // ── Intro sequence: staggered participant cards ──
  // Spread participant appearances evenly across the narration duration
  const introCardY = 900;
  const introCardSpacing = 100;
  const narrationDuration = INTRO_DURATION - 1; // exclude the 1s buffer
  const speakerInterval = narrationDuration / (participants.length + 1);

  for (let pi = 0; pi < participants.length; pi++) {
    const p = participants[pi];
    const hexColor = p.color.replace("#", "0x");
    const cardY = introCardY + pi * introCardSpacing;
    const appearAt = speakerInterval * (pi + 1);
    const introEnable = `enable='between(t,${appearAt.toFixed(3)},${INTRO_DURATION.toFixed(3)})'`;

    // Colored name with background
    drawtextFilters.push(
      `drawtext=${FONT}:text='${escapeDrawtext(p.name)}':fontsize=36:fontcolor=${hexColor}:x=(w-text_w)/2:y=${cardY}${SUBTITLE_BOX}:${introEnable}`,
    );

    // Tagline underneath with background
    if (p.tagline) {
      drawtextFilters.push(
        `drawtext=${FONT}:text='${escapeDrawtext(p.tagline)}':fontsize=22:fontcolor=0xd1d5db:x=(w-text_w)/2:y=${cardY + 48}${HEADER_BOX}:${introEnable}`,
      );
    }
  }

  // Per-segment speaker name + rolling subtitles (one drawtext per line)
  const maxSubtitleChars = 38;
  const linesPerChunk = 3;
  for (const seg of contentSegs) {
    const color = colorMap.get(seg.agent) ?? "#ffffff";
    const hexColor = color.replace("#", "0x");
    const name = escapeDrawtext(seg.agent);

    const fadeIn = Math.max(0, seg.startTime - 0.15);
    const fadeOut = seg.endTime + 0.15;

    // Speaker name — visible for entire segment, just above subtitle zone
    drawtextFilters.push(
      `drawtext=${FONT}:text='● ${name}':fontsize=36:fontcolor=${hexColor}:x=(w-text_w)/2:y=${SUBTITLE_Y_START - 60}${SUBTITLE_BOX}:` +
        `enable='between(t,${fadeIn.toFixed(3)},${fadeOut.toFixed(3)})'`,
    );

    // Split text into timed subtitle chunks proportional to word count
    const allLines = wordWrap(seg.text, maxSubtitleChars);
    const chunks = buildSubtitleChunks(allLines, linesPerChunk);
    const totalWords = chunks.reduce((s, c) => s + c.wordCount, 0);

    let chunkStart = seg.startTime;
    for (const chunk of chunks) {
      const chunkDuration =
        totalWords > 0
          ? (chunk.wordCount / totalWords) * seg.duration
          : seg.duration / chunks.length;
      const chunkEnd = chunkStart + chunkDuration;
      const enable = `enable='between(t,${chunkStart.toFixed(3)},${chunkEnd.toFixed(3)})'`;

      // Render each line as its own drawtext with subtitle box
      for (let li = 0; li < chunk.lines.length; li++) {
        const y = SUBTITLE_Y_START + li * SUBTITLE_LINE_HEIGHT;
        drawtextFilters.push(
          `drawtext=${FONT}:text='${escapeDrawtext(chunk.lines[li])}':fontsize=${SUBTITLE_FONT_SIZE}:fontcolor=white:x=(w-text_w)/2:y=${y}${SUBTITLE_BOX}:${enable}`,
        );
      }

      chunkStart = chunkEnd;
    }
  }

  // Progress bar background + fill
  drawtextFilters.unshift(
    `drawbox=x=80:y=1750:w=${WIDTH - 160}:h=4:color=0x333333:t=fill`,
  );
  drawtextFilters.push(
    `drawbox=x=80:y=1750:w='(${WIDTH - 160})*t/${totalDuration.toFixed(3)}':h=4:color=0x06b6d4:t=fill`,
  );

  // Build filter graph — with video background or solid color fallback
  const useVideoBg = bgVideoPath !== null;

  // Audio input index depends on whether we have a video background
  // With video bg: input 0 = bg video, input 1 = audio → audio is [1:a]
  // Without:       input 0 = audio → audio is [0:a]
  const audioIdx = useVideoBg ? 1 : 0;

  const bgFilter = useVideoBg
    ? // Darken the video background for text readability
      `[0:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},` +
      `colorbalance=bs=-0.3:bm=-0.3:bh=-0.3,eq=brightness=-0.4:saturation=0.6[bg]`
    : `color=c=0x1a1a2e:s=${WIDTH}x${HEIGHT}:d=${totalDuration.toFixed(3)}[bg]`;

  const filterGraph = [
    bgFilter,
    `[${audioIdx}:a]showfreqs=s=16x350:mode=bar:fscale=log:ascale=log:colors=white|white|white|white:win_size=2048[eq_raw]`,
    `[eq_raw]tmix=frames=4:weights=1 3 3 1[eq_smooth]`,
    `[eq_smooth]scale=920:350:flags=neighbor[eq]`,
    `[bg][eq]overlay=(W-w)/2:500[v]`,
    `[v]${drawtextFilters.join(",")}[out]`,
  ].join(";");

  // 12. Render video
  const outPath = outputFile ?? join(videoDir, "shorts.mp4");
  process.stderr.write(`Rendering video → ${outPath}\n`);

  const ffmpegInputs: string[] = [];
  if (useVideoBg) ffmpegInputs.push("-i", bgVideoPath!);
  ffmpegInputs.push("-i", audioPath);

  ffmpeg([
    ...ffmpegInputs,
    "-filter_complex",
    filterGraph,
    "-map",
    "[out]",
    "-map",
    `${audioIdx}:a`,
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
