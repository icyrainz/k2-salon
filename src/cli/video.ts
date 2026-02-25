/**
 * Video generator — creates a YouTube Short from a room's conversation.
 *
 * Walks through all messages in a room, generates TTS for content messages
 * (reusing cached audio), builds a timeline manifest, and produces a
 * 1080x1920 portrait video (YouTube Shorts format) with ffmpeg.
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
  // ffmpeg drawtext option parsing splits on ':' BEFORE respecting quotes,
  // so colons must be backslash-escaped even inside text='...'.
  // Backslashes must be escaped first to avoid double-escaping.
  return text
    .replace(/\\/g, "\\\\") // \ → \\
    .replace(/'/g, "\u2019") // ' → ' (curly quote, avoids delimiter break)
    .replace(/:/g, "\\:") // : → \: (drawtext option separator escape)
    .replace(/;/g, "\\;") // ; → \; (filter chain separator escape)
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

// ── Animation expression helpers for ffmpeg drawtext ────────────────

/** Generate an alpha expression for fade-in/fade-out transitions.
 *  Returns an ffmpeg expression using `t` (current time in seconds). */
function fadeExpr(
  startTime: number,
  endTime: number,
  fadeIn: number,
  fadeOut: number,
): string {
  const s = startTime.toFixed(3);
  const fi = (startTime + fadeIn).toFixed(3);
  const fo = (endTime - fadeOut).toFixed(3);
  const e = endTime.toFixed(3);
  // Expression is single-quoted at the call site, so commas are literal
  return (
    `if(lt(t,${s}),0,` +
    `if(lt(t,${fi}),(t-${s})/${fadeIn.toFixed(3)},` +
    `if(lt(t,${fo}),1,` +
    `if(lt(t,${e}),(${e}-t)/${fadeOut.toFixed(3)},` +
    `0))))`
  );
}

/** Generate a y expression for slide-up animation with sine ease-out.
 *  Text starts `offset` px below `finalY` and slides up over `duration` seconds. */
function slideUpExpr(
  startTime: number,
  duration: number,
  finalY: number,
  offset: number,
): string {
  const s = startTime.toFixed(3);
  const d = duration.toFixed(3);
  const sd = (startTime + duration).toFixed(3);
  const base = finalY.toFixed(0);
  const off = offset.toFixed(0);
  // Expression is single-quoted at the call site, so commas are literal
  return (
    `if(lt(t,${s}),${finalY + offset},` +
    `if(lt(t,${sd}),${base}+${off}*(1-sin(PI/2*(t-${s})/${d})),` +
    `${base}))`
  );
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
  // Normalize all clips: scale, crop, desaturate, darken, blur
  const normalizedPaths: string[] = [];
  for (let i = 0; i < clips.length; i++) {
    const outPath = join(tmpDir, `bg-norm-${i}.mp4`);
    ffmpeg([
      "-i",
      clips[i],
      "-vf",
      `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},fps=30,hue=s=0.08:h=210,eq=brightness=-0.5,gblur=sigma=4`,
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

/** Extract a short provocative hook sentence from conversation text.
 *  Picks the first sentence that contains a strong opinion or question. */
function extractHookTeaser(
  segments: { text: string; agent: string }[],
): { text: string; agent: string } | null {
  for (const seg of segments) {
    // Split into sentences, find one that's punchy (< 80 chars, ends with ! or ? or has strong language)
    const sentences = seg.text.match(/[^.!?]+[.!?]+/g);
    if (!sentences) continue;
    for (const s of sentences) {
      const trimmed = s.trim();
      if (trimmed.length < 20 || trimmed.length > 80) continue;
      // Prefer sentences with questions, exclamations, or strong declarative tone
      if (
        /[!?]$/.test(trimmed) ||
        /\b(only|never|always|best|worst|zero|impossible)\b/i.test(trimmed)
      ) {
        return { text: `"${trimmed}"`, agent: seg.agent };
      }
    }
  }
  // Fallback: first 70 chars of first segment
  if (segments.length > 0) {
    const first = segments[0].text.slice(0, 70).trim();
    return { text: `"${first}..."`, agent: segments[0].agent };
  }
  return null;
}

// ── Main pipeline ───────────────────────────────────────────────────

// ── Layout constants (portrait 9:16 for YouTube Shorts) ────────────
const WIDTH = 1080;
const HEIGHT = 1920;

const LAYOUT = {
  titleY: 40,
  titleSize: 48,
  topicY: 108,
  topicSize: 28,
  topicWrap: 38,
  accentLineY: 155,
  waveY: 620,
  waveW: 920,
  waveH: 200,
  introCardY: 900,
  introCardSpacing: 100,
  speakerNameY: 1370,
  subtitleY: 1430,
  subtitleSize: 34,
  subtitleLineH: 50,
  subtitleWrap: 36,
  progressY: 1750,
  progressH: 6,
  outroThanksY: 768,
  outroBrandY: 922,
  outroTopicY: 1056,
  outroCtaY: 1160,
  hookY: 800,
  hookSize: 30,
};

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
  const HOOK_DURATION = 2.5; // seconds of hook teaser before intro narration starts
  const introNarrationDuration = ffprobe(introAudioPath);
  const INTRO_DURATION = HOOK_DURATION + introNarrationDuration + 1; // hook + narration + 1s buffer
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

  // 6b. Generate outro narration TTS
  const outroScript =
    "That's all for today's discussion on K2 Salon. Thanks for watching.";
  const outroAudioPath = join(ROOMS_DIR, roomName, "tts", "outro.mp3");
  if (regenTts || !existsSync(outroAudioPath)) {
    process.stderr.write("Generating outro narration...\n");
    const outroAudio = await synthesiseTts(outroScript, "onyx");
    const outroDir = join(ROOMS_DIR, roomName, "tts");
    if (!existsSync(outroDir)) await mkdir(outroDir, { recursive: true });
    await writeFile(outroAudioPath, outroAudio);
  }
  const outroDuration = ffprobe(outroAudioPath);
  const OUTRO_BUFFER = 1.5; // silence before outro narration
  const OUTRO_TAIL = 1.0; // silence after narration to end
  const outroStart = currentTime + OUTRO_BUFFER;
  const totalDuration = outroStart + outroDuration + OUTRO_TAIL;
  process.stderr.write(
    `Outro: ${(outroDuration + OUTRO_BUFFER + OUTRO_TAIL).toFixed(1)}s\n`,
  );

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

  // Hook silence (teaser text only, no audio) + intro narration + buffer
  const hookSilPath = join(tmpDir, "hook-silence.mp3");
  generateSilence(HOOK_DURATION * 1000, hookSilPath);
  chunkPaths.push(hookSilPath);
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

  // Outro: silence buffer + narration + tail silence
  const outroBufferSilPath = join(tmpDir, "outro-buffer.mp3");
  generateSilence(OUTRO_BUFFER * 1000, outroBufferSilPath);
  chunkPaths.push(outroBufferSilPath);
  chunkPaths.push(outroAudioPath);
  const outroTailSilPath = join(tmpDir, "outro-tail.mp3");
  generateSilence(OUTRO_TAIL * 1000, outroTailSilPath);
  chunkPaths.push(outroTailSilPath);

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

  const SUBTITLE_FONT_SIZE = LAYOUT.subtitleSize;
  const SUBTITLE_LINE_HEIGHT = LAYOUT.subtitleLineH;
  const SUBTITLE_Y_START = LAYOUT.subtitleY;
  const FONT = FONT_PATH ? `:fontfile='${FONT_PATH}'` : "";
  const SHADOW = `:shadowcolor=black@0.7:shadowx=2:shadowy=2`;
  const SUBTITLE_BOX = `:box=1:boxcolor=black@0.35:boxborderw=16${SHADOW}`;
  const HEADER_BOX = `:box=1:boxcolor=black@0.6:boxborderw=10${SHADOW}`;

  // Static title — always visible
  drawtextFilters.push(
    `drawtext=${FONT}:text='K2 Salon':fontsize=${LAYOUT.titleSize}:fontcolor=white:x=(w-text_w)/2:y=${LAYOUT.titleY}${HEADER_BOX}`,
  );

  // Topic — word-wrapped across multiple lines, always visible
  const topicLines = wordWrap(meta.topic, LAYOUT.topicWrap);
  for (let i = 0; i < topicLines.length; i++) {
    drawtextFilters.push(
      `drawtext=${FONT}:text='${escapeDrawtext(topicLines[i])}':fontsize=${LAYOUT.topicSize}:fontcolor=0xd1d5db:x=(w-text_w)/2:y=${LAYOUT.topicY + i * (LAYOUT.topicSize + 8)}${HEADER_BOX}`,
    );
  }

  // Accent line under topic for visual structure
  drawtextFilters.push(
    `drawbox=x=${Math.round(WIDTH * 0.3)}:y=${LAYOUT.accentLineY}:w=${Math.round(WIDTH * 0.4)}:h=2:color=0x06b6d4@0.5:t=fill`,
  );

  // ── Hook teaser: provocative quote in first 2.5 seconds ──
  const hook = extractHookTeaser(contentSegs);
  if (hook) {
    const hookColor = colorMap.get(hook.agent) ?? "#ffffff";
    const hookHex = hookColor.replace("#", "0x");
    const hookLines = wordWrap(hook.text, 32);
    const hookFadeIn = 0.3;
    const hookFadeOut = 0.4;
    const hookAlpha = fadeExpr(0.2, HOOK_DURATION, hookFadeIn, hookFadeOut);
    for (let i = 0; i < hookLines.length; i++) {
      const y = LAYOUT.hookY + i * (LAYOUT.hookSize + 14);
      drawtextFilters.push(
        `drawtext=${FONT}:text='${escapeDrawtext(hookLines[i])}':fontsize=${LAYOUT.hookSize}:fontcolor=${hookHex}:x=(w-text_w)/2:y='${slideUpExpr(0.2, hookFadeIn, y, 25)}':alpha='${hookAlpha}'${SUBTITLE_BOX}`,
      );
    }
    // Small "coming up..." label above the hook
    drawtextFilters.push(
      `drawtext=${FONT}:text='coming up...':fontsize=18:fontcolor=0x9ca3af:x=(w-text_w)/2:y='${slideUpExpr(0.2, hookFadeIn, LAYOUT.hookY - 40, 15)}':alpha='${hookAlpha}'`,
    );
  }

  // ── Intro sequence: staggered participant cards ──
  // Spread participant appearances evenly across the narration duration
  const introCardY = LAYOUT.introCardY;
  const introCardSpacing = LAYOUT.introCardSpacing;
  const narrationDuration = introNarrationDuration; // just the narration period
  const speakerInterval = narrationDuration / (participants.length + 1);

  for (let pi = 0; pi < participants.length; pi++) {
    const p = participants[pi];
    const hexColor = p.color.replace("#", "0x");
    const cardY = introCardY + pi * introCardSpacing;
    const appearAt = HOOK_DURATION + speakerInterval * (pi + 1);
    const disappearAt = INTRO_DURATION;
    const introFadeIn = 0.4;
    const introFadeOut = 0.5;

    const nameAlpha = fadeExpr(
      appearAt,
      disappearAt,
      introFadeIn,
      introFadeOut,
    );
    const nameY = slideUpExpr(appearAt, introFadeIn, cardY, 20);

    // Colored name with fade-in + slide-up
    drawtextFilters.push(
      `drawtext=${FONT}:text='${escapeDrawtext(p.name)}':fontsize=36:fontcolor=${hexColor}:x=(w-text_w)/2:y='${nameY}':alpha='${nameAlpha}'${SUBTITLE_BOX}`,
    );

    // Tagline underneath with same animation
    if (p.tagline) {
      const tagY = slideUpExpr(appearAt, introFadeIn, cardY + 48, 20);
      drawtextFilters.push(
        `drawtext=${FONT}:text='${escapeDrawtext(p.tagline)}':fontsize=22:fontcolor=0xd1d5db:x=(w-text_w)/2:y='${tagY}':alpha='${nameAlpha}'${HEADER_BOX}`,
      );
    }
  }

  // Per-segment speaker name + rolling subtitles (one drawtext per line)
  const maxSubtitleChars = LAYOUT.subtitleWrap;
  const linesPerChunk = 3;
  let prevAgent = "";
  for (const seg of contentSegs) {
    // Speaker transition flash — brief white pulse when speaker changes
    if (prevAgent && seg.agent !== prevAgent) {
      const flashStart = Math.max(0, seg.startTime - 0.15);
      const flashDuration = 0.25;
      const flashEnd = flashStart + flashDuration;
      const flashAlpha = fadeExpr(flashStart, flashEnd, 0.08, 0.17);
      drawtextFilters.push(
        `drawbox=x=0:y=0:w=${WIDTH}:h=${HEIGHT}:color=white@0.12:t=fill:enable='between(t,${flashStart.toFixed(3)},${flashEnd.toFixed(3)})'`,
      );
      // Also flash a thin colored line at the top in new speaker's color
      const newColor = (colorMap.get(seg.agent) ?? "#ffffff").replace(
        "#",
        "0x",
      );
      drawtextFilters.push(
        `drawbox=x=0:y=0:w=${WIDTH}:h=3:color=${newColor}:t=fill:enable='between(t,${flashStart.toFixed(3)},${(flashEnd + 0.1).toFixed(3)})'`,
      );
    }
    prevAgent = seg.agent;
    const color = colorMap.get(seg.agent) ?? "#ffffff";
    const hexColor = color.replace("#", "0x");
    const name = escapeDrawtext(seg.agent);

    const speakerFadeIn = 0.3;
    const speakerFadeOut = 0.3;
    const speakerStart = Math.max(0, seg.startTime - 0.15);
    const speakerEnd = seg.endTime + seg.pauseAfter;
    const speakerY = LAYOUT.speakerNameY;

    const speakerAlpha = fadeExpr(
      speakerStart,
      speakerEnd,
      speakerFadeIn,
      speakerFadeOut,
    );
    const speakerYExpr = slideUpExpr(speakerStart, speakerFadeIn, speakerY, 15);

    // Decorative quote mark in center zone — visual hint this is conversation
    const quoteY =
      Math.round((LAYOUT.waveY + LAYOUT.waveH + LAYOUT.speakerNameY) / 2) - 40;
    drawtextFilters.push(
      `drawtext=${FONT}:text='\u201C':fontsize=120:fontcolor=${hexColor}@0.12:x=(w-text_w)/2:y=${quoteY}:alpha='${speakerAlpha}'`,
    );

    // Speaker color accent bar above name
    const barW = 60;
    const barY = speakerY - 20;
    drawtextFilters.push(
      `drawbox=x=${Math.round((WIDTH - barW) / 2)}:y='${slideUpExpr(speakerStart, speakerFadeIn, barY, 15)}':w=${barW}:h=3:color=${hexColor}@0.8:t=fill:enable='between(t,${speakerStart.toFixed(3)},${speakerEnd.toFixed(3)})'`,
    );

    // Speaker name — fade + slide-up, crossfades with adjacent segments
    drawtextFilters.push(
      `drawtext=${FONT}:text='● ${name}':fontsize=36:fontcolor=${hexColor}:x=(w-text_w)/2:y='${speakerYExpr}':alpha='${speakerAlpha}'${SUBTITLE_BOX}`,
    );

    // Split text into timed subtitle chunks proportional to word count
    const allLines = wordWrap(seg.text, maxSubtitleChars);
    const chunks = buildSubtitleChunks(allLines, linesPerChunk);
    const totalWords = chunks.reduce((s, c) => s + c.wordCount, 0);

    const subFadeIn = 0.2;
    const subFadeOut = 0.2;

    let chunkStart = seg.startTime;
    for (const chunk of chunks) {
      const chunkDuration =
        totalWords > 0
          ? (chunk.wordCount / totalWords) * seg.duration
          : seg.duration / chunks.length;
      const chunkEnd = chunkStart + chunkDuration;
      const chunkAlpha = fadeExpr(chunkStart, chunkEnd, subFadeIn, subFadeOut);

      // Render each line with fade transition
      for (let li = 0; li < chunk.lines.length; li++) {
        const y = SUBTITLE_Y_START + li * SUBTITLE_LINE_HEIGHT;
        drawtextFilters.push(
          `drawtext=${FONT}:text='${escapeDrawtext(chunk.lines[li])}':fontsize=${SUBTITLE_FONT_SIZE}:fontcolor=${hexColor}@0.95:x=(w-text_w)/2:y=${y}:alpha='${chunkAlpha}'${SUBTITLE_BOX}`,
        );
      }

      chunkStart = chunkEnd;
    }
  }

  // ── Outro end card ──
  const outroFadeIn = 0.5;
  const outroFadeOut = 0.3;
  const outroAlpha = fadeExpr(
    outroStart - 0.5,
    totalDuration,
    outroFadeIn,
    outroFadeOut,
  );
  // "Thanks for watching" text
  drawtextFilters.push(
    `drawtext=${FONT}:text='Thanks for watching':fontsize=40:fontcolor=white:x=(w-text_w)/2:y=${LAYOUT.outroThanksY}:alpha='${outroAlpha}'${HEADER_BOX}`,
  );
  // K2 Salon branding
  drawtextFilters.push(
    `drawtext=${FONT}:text='K2 Salon':fontsize=56:fontcolor=0x06b6d4:x=(w-text_w)/2:y=${LAYOUT.outroBrandY}:alpha='${outroAlpha}'${HEADER_BOX}`,
  );
  // Topic reminder
  drawtextFilters.push(
    `drawtext=${FONT}:text='${escapeDrawtext(meta.topic)}':fontsize=24:fontcolor=0xd1d5db:x=(w-text_w)/2:y=${LAYOUT.outroTopicY}:alpha='${outroAlpha}'${HEADER_BOX}`,
  );
  // CTA — "Like & Subscribe" with delayed entrance for emphasis
  const ctaDelay = 0.8; // appears slightly after other outro elements
  const ctaAlpha = fadeExpr(
    outroStart - 0.5 + ctaDelay,
    totalDuration,
    0.4,
    0.3,
  );
  drawtextFilters.push(
    `drawtext=${FONT}:text='\u25B6 Like & Subscribe':fontsize=28:fontcolor=0xfbbf24:x=(w-text_w)/2:y='${slideUpExpr(outroStart - 0.5 + ctaDelay, 0.4, LAYOUT.outroCtaY, 20)}':alpha='${ctaAlpha}'${HEADER_BOX}`,
  );

  // Progress bar background + fill
  drawtextFilters.unshift(
    `drawbox=x=80:y=${LAYOUT.progressY}:w=${WIDTH - 160}:h=${LAYOUT.progressH}:color=0x333333@0.6:t=fill`,
  );
  drawtextFilters.push(
    `drawbox=x=80:y=${LAYOUT.progressY}:w='(${WIDTH - 160})*t/${totalDuration.toFixed(3)}':h=${LAYOUT.progressH}:color=0x06b6d4:t=fill`,
  );

  // Build filter graph — with video background or solid color fallback
  const useVideoBg = bgVideoPath !== null;

  // Audio input index depends on whether we have a video background
  // With video bg: input 0 = bg video, input 1 = audio → audio is [1:a]
  // Without:       input 0 = audio → audio is [0:a]
  const audioIdx = useVideoBg ? 1 : 0;

  const bgFilter = useVideoBg
    ? // Background already graded (grayscale, dark, blurred) in buildLoopingBackground
      `[0:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT}[bg]`
    : `color=c=0x1a1a2e:s=${WIDTH}x${HEIGHT}:d=${totalDuration.toFixed(3)}[bg]`;

  // Gradient overlays — top vignette + bottom fade to black
  const topGradH = Math.round(HEIGHT * 0.15);
  const botGradH = Math.round(HEIGHT * 0.65);
  const botGradY = HEIGHT - botGradH;

  const filterGraph = [
    bgFilter,
    // Normalize audio levels, split for waveform visualization + output
    `[${audioIdx}:a]loudnorm=I=-16:TP=-1.5:LRA=11[anorm]`,
    `[anorm]asplit=2[awav][aout]`,
    // Waveform: colorkey removes black bg so it floats on the background
    `[awav]compand,showwaves=s=${LAYOUT.waveW}x${LAYOUT.waveH}:mode=cline:scale=sqrt:colors=0x06b6d4@0.7:draw=full,format=rgba,colorkey=color=black:similarity=0.12:blend=0.2[wave]`,
    `[bg][wave]overlay=(W-w)/2:${LAYOUT.waveY}[vw]`,
    // Top vignette gradient (dark edges at top for cinematic framing)
    `color=c=black:s=${WIDTH}x${topGradH}[topgrad_solid]`,
    `[topgrad_solid]format=rgba,geq='r=0:g=0:b=0:a=255*pow((${topGradH}-Y)/${topGradH},0.5)'[topgrad]`,
    `[vw][topgrad]overlay=0:0[vt]`,
    // Bottom gradient overlay for subtitle zone readability
    `color=c=black:s=${WIDTH}x${botGradH}[grad_solid]`,
    `[grad_solid]format=rgba,geq='r=0:g=0:b=0:a=255*pow(Y/${botGradH},0.35)'[grad]`,
    `[vt][grad]overlay=0:${botGradY}[v]`,
    `[v]${drawtextFilters.join(",")}[out]`,
  ].join(";");

  // Write filter graph to a file — avoids CLI arg escaping issues
  const filterScriptPath = join(videoDir, "filtergraph.txt");
  await writeFile(filterScriptPath, filterGraph);

  // 12. Render video
  const outPath = outputFile ?? join(videoDir, "shorts.mp4");
  process.stderr.write(`Rendering video → ${outPath}\n`);

  const ffmpegInputs: string[] = [];
  if (useVideoBg) ffmpegInputs.push("-i", bgVideoPath!);
  ffmpegInputs.push("-i", audioPath);

  ffmpeg([
    ...ffmpegInputs,
    "-filter_complex_script",
    filterScriptPath,
    "-map",
    "[out]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "18",
    "-profile:v",
    "high",
    "-level:v",
    "4.2",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-r",
    "30",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
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
