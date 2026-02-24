/**
 * Headless simulation mode — no TUI, no input, purely turn-based.
 *
 * Usage:
 *   bun run src/cli/simulate.ts "your topic" [--messages 10] [--lang Vietnamese]
 *   just simulate "your topic"
 *
 * Flags:
 *   --messages N   Number of chat messages to collect (default 10)
 *   --lang LANG    Language agents must use (default: from salon.yaml or "English")
 */

import { PERSONALITY_PRESETS } from "../core/roster.js";
import { loadConfig, resolveRoster } from "../engine/config.js";
import { SalonEngine } from "../engine/salon-engine.js";
import type { RoomConfig, RoomMessage } from "../core/types.js";

// ── Parse CLI args ──────────────────────────────────────────────────

const args = process.argv.slice(2);

let topic = "";
let targetMessages = 10;
let langFlag: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--messages" && args[i + 1]) {
    targetMessages = parseInt(args[++i], 10);
  } else if (args[i] === "--lang" && args[i + 1]) {
    langFlag = args[++i];
  } else if (!args[i].startsWith("--") && !topic) {
    topic = args[i].trim();
  }
}

if (!topic) {
  process.stderr.write(
    'Usage: bun run src/cli/simulate.ts "topic" [--messages N] [--lang LANG]\n',
  );
  process.exit(1);
}

// ── Run simulation ──────────────────────────────────────────────────

async function simulate() {
  const salonConfig = await loadConfig();
  const roster = resolveRoster(salonConfig, PERSONALITY_PRESETS);

  const language = langFlag ?? salonConfig.room.language;

  process.stderr.write(`\nSimulating: "${topic}"\n`);
  process.stderr.write(`Language: ${language}\n`);
  process.stderr.write(`Target: ${targetMessages} chat messages\n\n`);

  const config: RoomConfig = { ...salonConfig.room, topic, language };
  const engine = new SalonEngine(config, roster);

  const allMessages: RoomMessage[] = [];
  let chatCount = 0;

  engine.on("message", (msg) => {
    allMessages.push(msg);
  });

  engine.open();

  // Step until we have enough chat messages — no polling, no wait loop
  while (chatCount < targetMessages) {
    await engine.step({ verbose: true, churn: false });

    // Count chat messages collected since last check
    const newCount = allMessages.filter((m) => m.kind === "chat").length;
    if (newCount > chatCount) {
      chatCount = newCount;
      const last = allMessages.filter((m) => m.kind === "chat").at(-1)!;
      process.stderr.write(
        `  [${chatCount}/${targetMessages}] ${last.agent}\n`,
      );
    }
  }

  // ── Render markdown report ──────────────────────────────────────────

  const appearedNames = new Set(
    allMessages
      .filter((m) => m.kind === "chat" || m.kind === "join")
      .map((m) => m.agent),
  );
  const rosterMap = new Map(roster.map((a) => [a.personality.name, a]));

  const lines: string[] = [];

  lines.push(`# Simulation Report`);
  lines.push(``);
  lines.push(`**Topic:** ${topic}`);
  lines.push(`**Language:** ${language}`);
  lines.push(`**Mode:** simulation`);
  lines.push(`**Messages:** ${chatCount} chat messages`);
  lines.push(`**Participants:** ${[...appearedNames].join(", ")}`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`## Conversation`);
  lines.push(``);

  for (const msg of allMessages) {
    switch (msg.kind) {
      case "system":
        lines.push(`*[${msg.content}]*`);
        lines.push(``);
        break;
      case "join":
        lines.push(`*→ **${msg.agent}** joined — ${msg.content}*`);
        lines.push(``);
        break;
      case "leave":
        lines.push(`*← **${msg.agent}** left — ${msg.content}*`);
        lines.push(``);
        break;
      case "user":
        lines.push(`**[YOU]**`);
        lines.push(msg.content);
        lines.push(``);
        break;
      case "chat":
        lines.push(`### ${msg.agent}`);
        lines.push(``);
        lines.push(msg.content);
        lines.push(``);
        break;
    }
  }

  lines.push(`---`);
  lines.push(``);
  lines.push(`## Participants`);
  lines.push(``);

  // Only list agents who actually appeared in the conversation
  for (const name of appearedNames) {
    const agent = rosterMap.get(name);
    if (!agent) continue;
    const p = agent.personality;
    lines.push(`**${p.name}** — ${p.tagline}`);
    lines.push(`> ${p.traits.join(" · ")}`);
    lines.push(``);
  }

  process.stdout.write(lines.join("\n") + "\n");
}

simulate().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
