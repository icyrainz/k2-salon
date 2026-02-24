# Video Generation for YouTube Shorts

Date: 2026-02-24

## Goal

Generate vertical (1080x1920) YouTube Shorts from existing room conversations.
Walk through all messages in a room, generate TTS for content messages (reusing
cached audio), build a renderer-agnostic timeline manifest, and produce a video
with ffmpeg.

## Visual Style

Audiogram / waveform visualizer:

```
┌──────────────────────────────┐
│                              │
│       K2 Salon               │  title
│   "Topic goes here"          │  topic subtitle
│                              │
│    ┌──────────────────────┐  │
│    │   ∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿   │  │  showwaves (center)
│    │   ∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿   │  │
│    └──────────────────────┘  │
│                              │
│          ● Sage              │  speaker name (agent color)
│                              │
│   "The real question is      │
│    whether fear is even      │  subtitle (word-wrapped)
│    the right frame..."       │
│                              │
│  ━━━━━━━━━━━━━━━━━━━ 3:42   │  progress bar
│                              │
└──────────────────────────────┘
```

Speaker transitions use alpha crossfade (~0.3s) on name and subtitle text.

## Message ID Redesign

Single monotonic sequence with type suffix:

```
00-e  (system: topic announced)
01-e  (Sage joined)
02-e  (Wren joined)
03-m  (Sage: first message)
04-m  (Wren: reply)
05-e  (DocK joined)
06-m  (DocK: message)
...
```

- One counter, always incrementing. Suffix `-m` = content (chat/user),
  `-e` = event (join/leave/system).
- Total order preserved by numeric prefix. Zero-padded (4 digits for long rooms).
- Content messages (`-m`) get TTS audio. Events (`-e`) are metadata only.
- Backward compat: old bare `#N` on chat/user → `N-m`, on events → `N-e`.
  Or just start fresh rooms.

### Type change

```typescript
interface RoomMessage {
  id: string;        // "0003-m", "0004-e", always set
  timestamp: Date;
  agent: string;
  content: string;
  color: AgentColor;
  kind: "chat" | "join" | "leave" | "system" | "user";
  providerLabel?: string;
  modelLabel?: string;
}
```

### Engine change

```typescript
private nextId = 0;

private pushMessage(msg: RoomMessage): void {
  const suffix = (msg.kind === "chat" || msg.kind === "user") ? "m" : "e";
  msg.id = `${String(this.nextId++).padStart(4, "0")}-${suffix}`;
  this.history.push(msg);
  this.emit("message", msg);
}
```

### Transcript format

- Content: `**Sage** *11:07* #0003-m`
- Events: `> **Wren** *11:05* #0001-e [join] — Devil's advocate`

### TTS cache

Files keyed on full ID: `rooms/<name>/tts/0003-m.mp3`. Old `msg-N.mp3` format
abandoned.

### Resume loading

Parse IDs from transcripts, extract numeric prefix, find max, continue from
`max + 1`.

## Architecture: Hybrid Pipeline (Approach 3)

```
just video <room-name>
       │
       ▼
  Load room transcripts     persist.ts: loadPreviousSessions()
       │                    Parse into RoomMessage[] with IDs
       ▼
  TTS phase                 engine/tts.ts: generateAndCacheTts()
       │                    Parallel synthesis, reuse cached files
       ▼                    Shared cache: rooms/<name>/tts/
  Audio concat              ffmpeg concat demuxer
       │                    Reuse podcast.ts pattern
       ▼                    Output: rooms/<name>/video/audio.mp3
  Build VideoManifest       Pure data, renderer-agnostic
       │                    Output: rooms/<name>/video/manifest.json
       ▼
  Render video              ffmpeg filter graph (swappable)
       │                    Output: rooms/<name>/video/shorts.mp4
       ▼
  Done
```

## VideoManifest (Renderer-Agnostic)

```typescript
interface VideoManifest {
  meta: {
    room: string;
    topic: string;
    language: string;
    fromId: number;           // numeric prefix of first content msg
    toId: number;             // numeric prefix of last content msg
    totalDuration: number;    // seconds
    resolution: { w: number; h: number };
  };

  participants: {
    name: string;
    color: string;            // hex, resolved from AgentColor
    voice: TtsVoice;
    tagline: string;
  }[];

  segments: VideoSegment[];
}

interface VideoSegment {
  id: string;                  // full ID: "0003-m" or "0004-e"
  kind: "chat" | "user" | "join" | "leave" | "system";
  agent: string;
  text: string;
  audioFile?: string;          // path to TTS mp3 (content only)
  startTime: number;           // seconds offset in concatenated audio
  endTime: number;
  duration: number;
  pauseAfter: number;          // silence gap in seconds
}
```

Events have `startTime`/`endTime` placed between surrounding content segments
(brief display window). Renderers decide whether to show them.

## ffmpeg Rendering

Single-pass filter graph on the concatenated audio:

1. `color=c=0x1a1a2e:s=1080x1920` — dark background
2. `showwaves=s=800x200:mode=cline:colors=<agent-hex>` — waveform
3. Timed `drawtext` layers with `enable='between(t,start,end)'`:
   - Title (static): "K2 Salon" + topic
   - Speaker name: per-segment, colored per agent
   - Subtitle: per-segment, word-wrapped message text
   - Progress bar: `drawbox` with width = `t / totalDuration * barWidth`
4. Speaker transitions: alpha fade out (0.3s) old text, fade in new text

Agent colors: `AgentColor` → hex mapping (new function, similar to
`toInkColor()` in `colors.ts`).

## CLI Interface

```bash
just video <room-name>                     # all content messages
just video <room-name> --from 10 --to 45   # content msg sequence 10-45
just video <room-name> --out custom.mp4    # custom output path
```

`--from`/`--to` refer to the numeric prefix of `-m` IDs only.

## File Structure

### New file

```
src/cli/video.ts         # CLI entry point + pipeline orchestration
```

### Reused modules

- `engine/persist.ts` — load room transcripts
- `engine/tts.ts` — TTS synthesis + caching
- `core/voices.ts` — agent→voice mapping
- `engine/config.ts` — room resolution

### Output

```
rooms/<name>/
  tts/
    0003-m.mp3           # shared TTS cache
    0006-m.mp3
  video/
    manifest.json        # VideoManifest
    audio.mp3            # concatenated audio
    shorts.mp4           # rendered video
```

### Justfile

```
video *ARGS:
  bun run src/cli/video.ts {{ARGS}}
```

## Dependencies

No new npm packages. Requires ffmpeg + ffprobe (already needed for podcast).

## Scope

This design covers two changes:

1. **Message ID redesign** — change `id` from `number | undefined` to `string`
   with `NNNN-m` / `NNNN-e` format. Touches: `core/types.ts`,
   `engine/salon-engine.ts`, `engine/persist.ts`, `engine/tts.ts`,
   `tui/app.tsx` (display), and their tests.

2. **Video generation CLI** — new `src/cli/video.ts` implementing the hybrid
   pipeline. Touches: `Justfile`, `README.md`.
