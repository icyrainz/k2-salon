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
import { join } from "path";
import { loadRoomMeta, loadPreviousSessions } from "../engine/persist.js";
import { generateAndCacheTts, ttsPath } from "../engine/tts.js";
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
  writeFileSync(
    listPath,
    inputPaths.map((p) => `file '${p}'`).join("\n"),
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
    process.stderr.write(
      "Usage: just video <room-name> [--from N] [--to N] [--out file.mp4]\n",
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
    process.stderr.write(
      `Error: no messages found in room "${roomName}"\n`,
    );
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

  const contentMessages = filtered.filter(
    (m) => m.id && isContentId(m.id),
  );
  if (contentMessages.length === 0) {
    process.stderr.write(
      "Error: no content messages in the specified range\n",
    );
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

  // 5. Probe durations and build segments
  const segments: VideoSegment[] = [];
  let currentTime = 0;

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

  // 6. Resolve participant metadata
  const salonConfig = await loadConfig();
  const roster = resolveRoster(salonConfig, PERSONALITY_PRESETS);
  const seenAgents = new Set(contentMessages.map((m) => m.agent));
  const participants = [...seenAgents].map((name) => {
    const agent = roster.find((a) => a.personality.name === name);
    return {
      name,
      color: toHexColor(
        (agent?.personality.color ?? "white") as AgentColor,
      ),
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
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.audioFile) continue;
    chunkPaths.push(seg.audioFile);
    if (seg.pauseAfter > 0) {
      const silPath = join(
        tmpDir,
        `${String(i).padStart(4, "0")}-silence.mp3`,
      );
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
