# Video Polish Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade video generation from "functional ffmpeg demo" to "clean podcast studio" quality — fix platform bugs and add smooth animations.

**Architecture:** All changes are in `src/cli/video.ts`. Replace hardcoded macOS font with cross-platform detection, fix drawtext escaping to use proper ffmpeg backslash escaping instead of fullwidth Unicode, switch showfreqs to showwaves for podcast waveform, and add alpha fade + slide-up animations to all text overlays via ffmpeg expression parameters.

**Tech Stack:** TypeScript, ffmpeg filter expressions (drawtext alpha/y params, showwaves, compand)

---

### Task 1: Cross-Platform Font Detection

**Files:**
- Modify: `src/cli/video.ts:30` (replace `FONT_PATH` constant)

**Step 1: Replace the hardcoded constant with `resolveFontPath()`**

Replace this (line 30):
```typescript
const FONT_PATH = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf";
```

With:
```typescript
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
```

**Step 2: Update the FONT helper string to handle empty path**

Replace (line 811):
```typescript
const FONT = `:fontfile='${FONT_PATH}'`;
```

With:
```typescript
const FONT = FONT_PATH ? `:fontfile='${FONT_PATH}'` : "";
```

**Step 3: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 4: Commit**

```bash
git add src/cli/video.ts
git commit -m "fix: cross-platform font detection for video generation"
```

---

### Task 2: Fix `escapeDrawtext()`

**Files:**
- Modify: `src/cli/video.ts:131-144` (replace `escapeDrawtext` function body)

**Step 1: Replace the escaping function**

Replace the entire `escapeDrawtext` function (lines 131-144) with proper ffmpeg escaping:

```typescript
function escapeDrawtext(text: string): string {
  // ffmpeg drawtext escaping requires two levels:
  // Level 1 (text value): escape \, ', :
  // Level 2 (filter graph): escape \, ', ;
  // We apply both in one pass. Order matters: backslashes first.
  return text
    .replace(/\\/g, "\\\\\\\\")  // \ → \\\\ (escaped at both levels)
    .replace(/'/g, "\\\\\\'")     // ' → \\' (escaped at both levels)
    .replace(/:/g, "\\\\:")       // : → \\: (text-level escape)
    .replace(/;/g, "\\;")         // ; → \; (filter-level escape)
    .replace(/%/g, "%%%%")        // % → %% (drawtext expansion escape)
    .replace(/\[/g, "\\[")        // [ → \[ (filter-level escape)
    .replace(/\]/g, "\\]")        // ] → \] (filter-level escape)
    .replace(/\n/g, " ");
}
```

Important: the exact number of backslashes depends on how the string flows through shell → ffmpeg CLI → filter parser → drawtext parser. The key insight is:
- TypeScript string literal `"\\\\\\\\"` produces the string `\\\\`
- ffmpeg filter parser consumes one level → `\\`
- drawtext text parser consumes one level → `\` (displayed)

For the single quote:
- TypeScript `"\\\\\\'"` produces string `\\\\'`
- Filter parser → `\\'`
- Text parser → `'` (displayed)

For colon:
- TypeScript `"\\\\:"` produces string `\\:`
- Filter parser → `\:`
- Text parser → `:` (displayed)

**Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/cli/video.ts
git commit -m "fix: proper ffmpeg drawtext escaping instead of fullwidth Unicode"
```

---

### Task 3: Animation Helper Functions

**Files:**
- Modify: `src/cli/video.ts` (add two new functions after `escapeDrawtext`)

**Step 1: Add `fadeExpr()` and `slideUpExpr()` helpers**

Add these after the `escapeDrawtext` function (after line ~144):

```typescript
// ── Animation expression helpers for ffmpeg drawtext ────────────

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
  // Commas inside if() must be backslash-escaped for the filter graph parser
  return (
    `if(lt(t\\,${s})\\,0\\,` +
    `if(lt(t\\,${fi})\\,(t-${s})/${fadeIn.toFixed(3)}\\,` +
    `if(lt(t\\,${fo})\\,1\\,` +
    `if(lt(t\\,${e})\\,(${e}-t)/${fadeOut.toFixed(3)}\\,` +
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
  return (
    `if(lt(t\\,${s})\\,${finalY + offset}\\,` +
    `if(lt(t\\,${sd})\\,${base}+${off}*(1-sin(PI/2*(t-${s})/${d}))\\,` +
    `${base}))`
  );
}
```

**Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/cli/video.ts
git commit -m "feat: add fadeExpr and slideUpExpr animation helpers for ffmpeg"
```

---

### Task 4: Switch showfreqs → showwaves

**Files:**
- Modify: `src/cli/video.ts:920-926` (filter graph construction)

**Step 1: Replace the audio visualization pipeline**

Replace these three lines in the filter graph array (lines 922-925):

```typescript
`[${audioIdx}:a]showfreqs=s=16x350:mode=bar:fscale=log:ascale=log:colors=white|white|white|white:win_size=2048[eq_raw]`,
`[eq_raw]tmix=frames=4:weights=1 3 3 1[eq_smooth]`,
`[eq_smooth]scale=920:350:flags=neighbor[eq]`,
`[bg][eq]overlay=(W-w)/2:500[v]`,
```

With these two lines (removes tmix, changes visualization):

```typescript
`[${audioIdx}:a]compand,showwaves=s=920x200:mode=cline:scale=sqrt:colors=0x06b6d4@0.7:draw=full[wave]`,
`[bg][wave]overlay=(W-w)/2:550[v]`,
```

Changes:
- `compand` before showwaves → dynamic range compression for fuller waveform
- `showwaves` mode=cline → centered symmetric waveform (podcast look)
- `scale=sqrt` → lifts quiet parts, compresses peaks
- `colors=0x06b6d4@0.7` → semi-transparent cyan
- `draw=full` → fills the waveform
- Size 920x200 (was 920x350) → more compact
- Overlay Y=550 (was 500) → moved down slightly
- Removed tmix smoothing (not needed for showwaves)

**Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/cli/video.ts
git commit -m "feat: replace showfreqs bars with showwaves podcast waveform"
```

---

### Task 5: Animated Intro Participant Cards

**Files:**
- Modify: `src/cli/video.ts:835-853` (intro card drawtext generation)

**Step 1: Replace snap-appearing cards with fade + slide-up**

Replace the intro cards loop (lines 835-853) with:

```typescript
  for (let pi = 0; pi < participants.length; pi++) {
    const p = participants[pi];
    const hexColor = p.color.replace("#", "0x");
    const cardY = introCardY + pi * introCardSpacing;
    const appearAt = speakerInterval * (pi + 1);
    const disappearAt = INTRO_DURATION;
    const introFadeIn = 0.4;
    const introFadeOut = 0.5;

    const nameAlpha = fadeExpr(appearAt, disappearAt, introFadeIn, introFadeOut);
    const nameY = slideUpExpr(appearAt, introFadeIn, cardY, 20);

    // Colored name with fade-in + slide-up
    drawtextFilters.push(
      `drawtext=${FONT}:text='${escapeDrawtext(p.name)}':fontsize=36:fontcolor=${hexColor}:x=(w-text_w)/2:y=${nameY}:alpha=${nameAlpha}${SUBTITLE_BOX}`,
    );

    // Tagline underneath with same animation
    if (p.tagline) {
      const tagY = slideUpExpr(appearAt, introFadeIn, cardY + 48, 20);
      drawtextFilters.push(
        `drawtext=${FONT}:text='${escapeDrawtext(p.tagline)}':fontsize=22:fontcolor=0xd1d5db:x=(w-text_w)/2:y=${tagY}:alpha=${nameAlpha}${HEADER_BOX}`,
      );
    }
  }
```

Also remove the `introEnable` variable (no longer using `enable=between()` — the alpha expression handles visibility).

**Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/cli/video.ts
git commit -m "feat: animated intro cards with fade-in and slide-up"
```

---

### Task 6: Speaker Name Fade + Slide Transitions

**Files:**
- Modify: `src/cli/video.ts:858-870` (speaker name drawtext per segment)

**Step 1: Replace snap-on speaker names with crossfading fade + slide**

In the per-segment loop (starting around line 858), replace the speaker name drawtext generation. The current code:

```typescript
    const fadeIn = Math.max(0, seg.startTime - 0.15);
    const fadeOut = seg.endTime + 0.15;

    // Speaker name — visible for entire segment, just above subtitle zone
    drawtextFilters.push(
      `drawtext=${FONT}:text='● ${name}':fontsize=36:fontcolor=${hexColor}:x=(w-text_w)/2:y=${SUBTITLE_Y_START - 60}${SUBTITLE_BOX}:` +
        `enable='between(t,${fadeIn.toFixed(3)},${fadeOut.toFixed(3)})'`,
    );
```

Replace with:

```typescript
    const speakerFadeIn = 0.3;
    const speakerFadeOut = 0.3;
    const speakerStart = Math.max(0, seg.startTime - 0.15);
    const speakerEnd = seg.endTime + seg.pauseAfter;
    const speakerY = SUBTITLE_Y_START - 60;

    const speakerAlpha = fadeExpr(speakerStart, speakerEnd, speakerFadeIn, speakerFadeOut);
    const speakerYExpr = slideUpExpr(speakerStart, speakerFadeIn, speakerY, 15);

    // Speaker name — fade + slide-up, crossfades with adjacent segments
    drawtextFilters.push(
      `drawtext=${FONT}:text='● ${name}':fontsize=36:fontcolor=${hexColor}:x=(w-text_w)/2:y=${speakerYExpr}:alpha=${speakerAlpha}${SUBTITLE_BOX}`,
    );
```

Key change: speaker name now extends through the pause (`+ seg.pauseAfter`) and uses alpha+y expressions for smooth transitions. The 0.15s early start creates a crossfade overlap with the previous speaker's 0.3s fade-out.

**Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/cli/video.ts
git commit -m "feat: speaker name crossfade with slide-up animation"
```

---

### Task 7: Subtitle Chunk Fade Transitions

**Files:**
- Modify: `src/cli/video.ts:878-895` (subtitle chunk drawtext loop)

**Step 1: Replace snap-on subtitle chunks with alpha fades**

Replace the subtitle chunk inner loop. Current code (around lines 878-895):

```typescript
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
```

Replace with:

```typescript
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

      // Render each line as its own drawtext with fade transition
      for (let li = 0; li < chunk.lines.length; li++) {
        const y = SUBTITLE_Y_START + li * SUBTITLE_LINE_HEIGHT;
        drawtextFilters.push(
          `drawtext=${FONT}:text='${escapeDrawtext(chunk.lines[li])}':fontsize=${SUBTITLE_FONT_SIZE}:fontcolor=white:x=(w-text_w)/2:y=${y}:alpha=${chunkAlpha}${SUBTITLE_BOX}`,
        );
      }

      chunkStart = chunkEnd;
    }
```

The change: `enable=between()` replaced with `alpha=fadeExpr()`. Subtitle text now fades in/out over 0.2s instead of snapping.

**Step 2: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/cli/video.ts
git commit -m "feat: subtitle chunks fade in/out instead of snapping"
```

---

### Task 8: Final Type-Check + Format + Integration Verification

**Files:**
- Check: `src/cli/video.ts`

**Step 1: Run type-check**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 2: Format**

Run: `npx prettier --write src/cli/video.ts`

**Step 3: Verify the full filter graph is syntactically sound**

Read through the final `filterGraph` array construction to ensure:
- No dangling commas or semicolons between filter chain sections
- `[v]` label flows correctly from overlay through drawtext chain to `[out]`
- No `enable=` clauses remain on animated elements (replaced by `alpha=`)
- All `fadeExpr`/`slideUpExpr` calls have matching parameter counts

**Step 4: Commit if formatting changed anything**

```bash
git add src/cli/video.ts
git commit -m "chore: format video.ts after visual polish changes"
```

---

## Testing Strategy

Since video.ts is a CLI pipeline with no unit tests (per CLAUDE.md: "TUI layer and provider (network I/O) are not tested"), verification is manual:

1. **Type-check**: `npx tsc --noEmit` after every task
2. **Format**: `npx prettier --write src/cli/video.ts` at the end
3. **Smoke test** (if a room with TTS cache exists): `just video <room-name> --from 1 --to 5` to render a short clip and visually inspect

## Summary of All Changes

| Area | Before | After |
|---|---|---|
| Font path | macOS only, hardcoded | Cross-platform detection, 4 candidates |
| Text escaping | Fullwidth Unicode (，：) | Proper ffmpeg backslash escaping |
| Waveform | showfreqs 16-bar chart + tmix | showwaves cline + compand, centered |
| Waveform size | 920x350 at Y=500 | 920x200 at Y=550 |
| Speaker names | Snap on/off with enable= | Fade in/out 0.3s + slide up 15px |
| Subtitles | Snap on/off with enable= | Fade in/out 0.2s |
| Intro cards | Snap-appear with enable= | Fade in 0.4s + slide up 20px, fade out 0.5s |
