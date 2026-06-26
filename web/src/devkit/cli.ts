/**
 * devkit — the **CLI** for the data-pulling test harness.
 *
 * Runs the built-in {@link SCENARIOS} by name (or `all`) and prints, for each:
 * what the orchestrator *would* pull, what the real fetchers *did* pull against
 * the fake providers, how every symbol resolved, and the credit cost. No UI, no
 * network, no secrets — exactly the "preset a condition, see how it reacts" loop
 * for development and bug-fixing.
 *
 * Usage (see `web/devkit/README.md`):
 *   npm run data-pull              # list the built-in scenarios
 *   npm run data-pull -- all       # run every scenario
 *   npm run data-pull -- stale-quotes blob-304   # run specific scenarios
 */

import { formatResult, runScenario } from "./harness";
import { SCENARIOS, findScenario } from "./scenarios";

function listScenarios(): void {
  process.stdout.write("Available data-pull scenarios:\n\n");
  for (const s of SCENARIOS) {
    process.stdout.write(`  ${s.name.padEnd(16)} ${s.description ?? ""}\n`);
  }
  process.stdout.write("\nRun one with:  npm run data-pull -- <name> [<name> …]\n");
  process.stdout.write("Run them all:  npm run data-pull -- all\n");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));

  if (args.length === 0) {
    listScenarios();
    return 0;
  }

  const wanted = args.includes("all") ? SCENARIOS.map((s) => s.name) : args;
  let failures = 0;

  for (const name of wanted) {
    const scenario = findScenario(name);
    if (!scenario) {
      process.stderr.write(`unknown scenario: ${name}\n`);
      failures += 1;
      continue;
    }
    const result = await runScenario(scenario);
    process.stdout.write(`\n${formatResult(result)}\n`);
  }

  if (failures > 0) {
    process.stderr.write(`\n${failures} scenario name(s) not found. Run with no args to list them.\n`);
  }
  return failures > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`devkit CLI failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
