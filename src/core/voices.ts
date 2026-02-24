// ── OpenAI TTS voice mapping ───────────────────────────────────────
// Shared between the TTS engine and the podcast CLI.

export type TtsVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

export const VOICE_MAP: Record<string, TtsVoice> = {
  Sage: "onyx",
  Nova: "nova",
  Riko: "echo",
  DocK: "alloy",
  Wren: "fable",
  Jules: "shimmer",
  Chip: "echo",
  Ora: "nova",
  YOU: "alloy",
};

const FALLBACK_VOICES: TtsVoice[] = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
];
const fallbackAssigned = new Map<string, TtsVoice>();

export function voiceFor(agent: string): TtsVoice {
  if (VOICE_MAP[agent]) return VOICE_MAP[agent];
  if (!fallbackAssigned.has(agent)) {
    fallbackAssigned.set(
      agent,
      FALLBACK_VOICES[fallbackAssigned.size % FALLBACK_VOICES.length],
    );
  }
  return fallbackAssigned.get(agent)!;
}
