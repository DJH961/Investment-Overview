/**
 * devkit — Node ESM resolve hook for running the TypeScript CLI directly.
 *
 * Node 22+ strips TypeScript types natively, but its ESM resolver does not add a
 * `.ts` extension to the codebase's extensionless relative imports (e.g.
 * `import { loadQuotes } from "./quotes"`). This hook fills that one gap: for a
 * relative specifier with no extension, it resolves to the sibling `.ts` file
 * when one exists, then defers to Node's default resolver for everything else.
 *
 * It is dev-only tooling (used by `npm run data-pull`) and adds no dependency.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(specifier);
  if (isRelative && !hasExtension && context.parentURL) {
    const candidate = new URL(specifier, context.parentURL);
    const tsPath = `${fileURLToPath(candidate)}.ts`;
    if (existsSync(tsPath)) {
      return { url: pathToFileURL(tsPath).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
