/**
 * devkit — registers the TypeScript resolve hook, then launches the CLI.
 *
 * Used as the `--import` bootstrap for `npm run data-pull`: it installs the
 * `.ts`-extension resolver ({@link ./ts-resolve-hook.mjs}) on the module loader so
 * Node's native type-stripping can run the harness's extensionless TypeScript
 * imports. The CLI itself is imported lazily afterwards so the hook is active
 * before any `.ts` module is resolved.
 */
import { register } from "node:module";

register("./ts-resolve-hook.mjs", import.meta.url);
