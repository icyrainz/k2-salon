import { loadConfig } from "../engine/config.js";
import { listModels } from "../engine/provider.js";

// ── List available models from all configured providers ─────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const MAX_DISPLAY = 20;

async function main() {
  const config = await loadConfig();

  process.stdout.write(
    `\n${BOLD}k2-salon${RESET} ${DIM}— Available Models${RESET}\n`,
  );

  const providers = Object.entries(config.providers);

  for (const [name, entry] of providers) {
    process.stdout.write(
      `\n${DIM}┌${RESET} ${BOLD}${name}${RESET} ${DIM}(${entry.baseUrl})${RESET}\n`,
    );

    try {
      const models = await listModels(entry.kind, {
        baseUrl: entry.baseUrl,
        apiKey: entry.apiKey,
      });

      if (models.length === 0) {
        process.stdout.write(
          `${DIM}│${RESET}  ${DIM}(no models found)${RESET}\n`,
        );
      } else {
        const show = models.slice(0, MAX_DISPLAY);
        for (const m of show) {
          process.stdout.write(`${DIM}│${RESET}  ${m.id}\n`);
        }
        if (models.length > MAX_DISPLAY) {
          process.stdout.write(
            `${DIM}│  ... and ${models.length - MAX_DISPLAY} more${RESET}\n`,
          );
        }
      }
    } catch (err: any) {
      const msg = err?.cause?.code ?? err?.message ?? String(err);
      process.stdout.write(
        `${DIM}│${RESET}  ${RED}(unreachable: ${msg})${RESET}\n`,
      );
    }

    process.stdout.write(`${DIM}└${RESET}\n`);
  }

  process.stdout.write("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
