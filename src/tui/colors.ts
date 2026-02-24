import type { AgentColor } from "../core/types.js";

// ── Semantic AgentColor → ink color ────────────────────────────────
// AgentColor values are already valid ink color names, so this is an
// identity mapping. It exists for type-safety and documentation.

export function toInkColor(color: AgentColor): string {
  return color;
}

// ── Legacy ANSI → AgentColor (for backward-compatible transcripts) ──

const ANSI_TO_AGENT_COLOR: Record<string, AgentColor> = {
  "\x1b[30m": "black",
  "\x1b[31m": "red",
  "\x1b[32m": "green",
  "\x1b[33m": "yellow",
  "\x1b[34m": "blue",
  "\x1b[35m": "magenta",
  "\x1b[36m": "cyan",
  "\x1b[37m": "white",
  "\x1b[90m": "gray",
  "\x1b[91m": "redBright",
  "\x1b[92m": "greenBright",
  "\x1b[93m": "yellowBright",
  "\x1b[94m": "blueBright",
  "\x1b[95m": "magentaBright",
  "\x1b[96m": "cyanBright",
  "\x1b[97m": "whiteBright",
};

export function ansiToAgentColor(ansi: string): AgentColor {
  return ANSI_TO_AGENT_COLOR[ansi] ?? "white";
}

// ── AgentColor → hex (for video rendering) ───────────────────────

const HEX_MAP: Record<string, string> = {
  black: "#000000",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  blue: "#3b82f6",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#e5e7eb",
  gray: "#9ca3af",
  redBright: "#f87171",
  greenBright: "#4ade80",
  yellowBright: "#facc15",
  blueBright: "#60a5fa",
  magentaBright: "#c084fc",
  cyanBright: "#22d3ee",
  whiteBright: "#ffffff",
};

export function toHexColor(color: AgentColor): string {
  return HEX_MAP[color] ?? "#ffffff";
}
