# Video Generation Visual Polish

Date: 2026-02-24

## Goal

Improve video generation output from "functional ffmpeg demo" to "clean podcast
studio" quality. Fix platform bugs (font path, text escaping) and add smooth
animations (fade transitions, waveform visualization, slide-up effects).

## Target Aesthetic

Clean podcast style — minimal, dark background, elegant typography, subtle
centered waveform. Think Spotify Canvas or social media podcast clips. Not
flashy or attention-grabbing — professional and readable.

## Changes

### 1. Cross-Platform Font Detection

Replace hardcoded macOS font path with a `resolveFontPath()` function that
checks common locations in order:

1. `/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf` (Debian/Ubuntu)
2. `/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf` (Fedora)
3. `/usr/share/fonts/TTF/DejaVuSans.ttf` (Arch)
4. `/System/Library/Fonts/Supplemental/Arial Unicode.ttf` (macOS)
5. Empty string fallback with stderr warning (ffmpeg bitmap font)

Returns the first path that exists. Called once at startup.

### 2. Fix `escapeDrawtext()`

Replace fullwidth Unicode substitution with proper ffmpeg escaping. The current
approach displays `，` and `：` in the video instead of `,` and `:`.

Proper ffmpeg drawtext escaping requires two levels:
- **Text value level**: escape `'`, `\`, `:` with backslashes
- **Filter graph level**: escape `;`, `'`, `\` with backslashes

The function will apply both levels correctly. Special chars that genuinely
can't be escaped (`%` for drawtext expansion) get replaced with the spelled
form ("percent") only as a last resort.

### 3. Audio Visualization: showfreqs → showwaves

Replace the 16-column frequency bar chart with a centered waveform:

```
[audio]compand,showwaves=s=920x200:mode=cline:scale=sqrt:colors=0x06b6d4@0.7:draw=full[wave]
```

- `compand` before showwaves — dynamic range compression for fuller waveform
- `mode=cline` — centered symmetric waveform (classic podcast look)
- `scale=sqrt` — lifts quiet parts, compresses loud peaks
- `colors=0x06b6d4@0.7` — semi-transparent cyan accent
- `draw=full` — fills area vs point rendering
- Size 920x200 (reduced from 920x350) — more breathing room for text
- Remove `tmix` smoothing (not needed, showwaves is inherently smooth)

### 4. Fade & Slide Animations

All text elements get smooth transitions via ffmpeg expression-based alpha
and y parameters.

#### Helper: `fadeExpr(startTime, endTime, fadeIn, fadeOut)`

Returns an alpha expression string:
```
if(lt(t,S),0, if(lt(t,S+FI),(t-S)/FI, if(lt(t,E-FO),1, if(lt(t,E),(E-t)/FO, 0))))
```

Where S=startTime, E=endTime, FI=fadeIn duration, FO=fadeOut duration.

#### Helper: `slideUpExpr(startTime, duration, finalY, offset)`

Returns a y expression:
```
if(lt(t,S), finalY+offset, if(lt(t,S+D), finalY+offset*(1-sin(PI/2*(t-S)/D)), finalY))
```

Sine ease-out: fast entry, gentle settle.

#### Speaker name transitions

- Fade in over 0.3s + slide up 15px with sine easing
- Fade out over 0.3s
- 0.15s overlap between outgoing and incoming speaker for crossfade effect

#### Subtitle chunk transitions

- Fade in over 0.2s per chunk
- Fade out over 0.2s per chunk
- No slide animation (fixed vertical positions for readability)

#### Intro participant cards

- Staggered fade in + slide up 20px over 0.4s each
- All cards fade out together over 0.5s at end of intro

#### Static elements

Title, topic text, progress bar — no animation (always visible).

### 5. Layout Adjustments

```
┌──────────────────────────────┐
│                              │
│       K2 Salon               │  Y=40, fontsize 48
│   "Topic goes here"          │  Y=108+, fontsize 28
│                              │
│                              │
│    ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌   │  Y=550, showwaves 920x200
│    ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌   │
│                              │
│                              │
│          ● Sage              │  Y=1390, speaker name + fade/slide
│                              │
│   "The real question is      │  Y=1450, subtitle line 1
│    whether fear is even      │  Y=1496, subtitle line 2
│    the right frame..."       │  Y=1542, subtitle line 3
│                              │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━  │  Y=1750, progress bar
│                              │
└──────────────────────────────┘
```

Waveform at Y=550 (from 500) and 200px tall (from 350px). More breathing
room between visual zones.

## Scope

All changes are in `src/cli/video.ts`. No new files, no new dependencies.
Approximately 200 lines changed — mostly the filter graph construction and
the new helper functions.

## Files to Change

- `src/cli/video.ts` — all changes (font detection, escaping, filter graph,
  animation helpers, layout constants)

## Non-Goals

- No new npm dependencies
- No renderer swap (still pure ffmpeg)
- No changes to the manifest format or pipeline architecture
- No TTS concurrency limiting (separate concern)
