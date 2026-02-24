/**
 * shuffle-personas — pick a random subset of personas and write them into
 * the salon.yaml roster.
 *
 * Usage:
 *   bun run src/cli/shuffle-personas.ts          # pick 6 personas
 *   bun run src/cli/shuffle-personas.ts --count 4
 *
 * The providers block and room settings in salon.yaml are left untouched.
 * Only the roster: section is replaced.
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { parse, stringify } from "yaml";

// ── Persona shape (what personas.yaml contains) ──────────────────────

interface PersonaEntry {
  name: string;
  provider: string;
  model: string;
  personality: {
    tagline: string;
    traits: string[];
    style: string[];
    bias: string;
    chattiness: number;
    contrarianism: number;
    color?: string;
  };
}

interface PersonasFile {
  personas: PersonaEntry[];
}

// ── Semantic color cycle for auto-assignment ─────────────────────────
// Colors use semantic AgentColor names (ink-compatible).

const COLOR_NAME_MAP: Record<string, string> = {
  cyan: "cyan",
  yellow: "yellow",
  magenta: "magenta",
  green: "green",
  blue: "blue",
  red: "red",
  "bright-red": "redBright",
  "bright-yellow": "yellowBright",
  "bright-green": "greenBright",
  "bright-cyan": "cyanBright",
  "bright-magenta": "magentaBright",
};

// Fallback cycle used when no color is specified
const COLOR_CYCLE = Object.values(COLOR_NAME_MAP);

function resolveColor(raw: string | undefined, index: number): string {
  if (!raw) return COLOR_CYCLE[index % COLOR_CYCLE.length];
  // Already a semantic name (no escape codes)
  const mapped = COLOR_NAME_MAP[raw.toLowerCase()];
  if (mapped) return mapped;
  // If it's already a valid semantic name, use it directly
  if (COLOR_CYCLE.includes(raw)) return raw;
  return COLOR_CYCLE[index % COLOR_CYCLE.length];
}

// ── Helpers ──────────────────────────────────────────────────────────

function shuffleArray<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function parseArgs(): { count: number } {
  const args = process.argv.slice(2);
  let count = 6;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--count" || args[i] === "-n") && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (!isNaN(n) && n > 0) count = n;
      i++;
    }
  }
  return { count };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const root = process.cwd();
  const personasPath = join(root, "personas.yaml");
  const salonPath = join(root, "salon.yaml");

  if (!existsSync(personasPath)) {
    console.error(`personas.yaml not found at ${personasPath}`);
    process.exit(1);
  }
  if (!existsSync(salonPath)) {
    console.error(`salon.yaml not found at ${salonPath}`);
    process.exit(1);
  }

  const { count } = parseArgs();

  // Load persona pool
  const personasRaw = await readFile(personasPath, "utf-8");
  const personasFile = parse(personasRaw) as PersonasFile;
  const pool = personasFile.personas ?? [];

  if (pool.length === 0) {
    console.error("personas.yaml has no personas defined.");
    process.exit(1);
  }

  const effective = Math.min(count, pool.length);
  if (effective < count) {
    console.warn(
      `Warning: only ${pool.length} personas available, using all of them.`,
    );
  }

  const picked = shuffleArray(pool).slice(0, effective);

  // Build roster entries for salon.yaml
  const roster = picked.map((p, i) => {
    const color = resolveColor(p.personality.color, i);
    return {
      name: p.name,
      provider: p.provider,
      model: p.model,
      personality: {
        name: p.name,
        tagline: p.personality.tagline,
        traits: p.personality.traits,
        style: p.personality.style,
        bias: p.personality.bias,
        chattiness: p.personality.chattiness,
        contrarianism: p.personality.contrarianism,
        color,
      },
    };
  });

  // Load salon.yaml, replace the roster block, write back
  const salonRaw = await readFile(salonPath, "utf-8");
  const salonParsed = parse(salonRaw) as Record<string, unknown>;
  salonParsed.roster = roster;

  // stringify with yaml produces clean YAML
  const newYaml = [
    "# ─────────────────────────────────────────────────────────────────────",
    "# k2-salon configuration  (roster last shuffled: " +
      new Date().toISOString() +
      ")",
    "# ─────────────────────────────────────────────────────────────────────",
    "# To shuffle again:  just shuffle",
    "# To see models:     just models",
    "# To start:          just room <name>",
    "# ─────────────────────────────────────────────────────────────────────",
    "",
    stringify(salonParsed, { lineWidth: 100 }),
  ].join("\n");

  await writeFile(salonPath, newYaml, "utf-8");

  console.log(`Shuffled ${effective} personas into salon.yaml roster:`);
  for (const p of picked) {
    console.log(`  • ${p.name.padEnd(10)} ${p.provider}/${p.model}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
