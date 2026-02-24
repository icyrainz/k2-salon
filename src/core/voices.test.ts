import { describe, expect, it } from "bun:test";
import { voiceFor } from "./voices.js";
import type { TtsVoice } from "./voices.js";

describe("voiceFor", () => {
  it("returns mapped voice for known agents", () => {
    expect(voiceFor("Sage")).toBe("onyx");
    expect(voiceFor("Nova")).toBe("nova");
    expect(voiceFor("Riko")).toBe("echo");
    expect(voiceFor("DocK")).toBe("alloy");
    expect(voiceFor("Wren")).toBe("fable");
    expect(voiceFor("Jules")).toBe("shimmer");
    expect(voiceFor("Chip")).toBe("echo");
    expect(voiceFor("Ora")).toBe("nova");
    expect(voiceFor("YOU")).toBe("alloy");
  });

  it("returns a stable fallback for unknown agents", () => {
    const voice1 = voiceFor("UnknownAgent");
    const voice2 = voiceFor("UnknownAgent");
    expect(voice1).toBe(voice2);
  });

  it("assigns different fallbacks to different unknown agents", () => {
    const v1 = voiceFor("FallbackTestA");
    const v2 = voiceFor("FallbackTestB");
    const validVoices: TtsVoice[] = [
      "alloy",
      "echo",
      "fable",
      "onyx",
      "nova",
      "shimmer",
    ];
    expect(validVoices).toContain(v1);
    expect(validVoices).toContain(v2);
  });
});
