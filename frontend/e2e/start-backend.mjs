// Prepares a throwaway database (migrate + set password) and runs the API server.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const backend = resolve(import.meta.dirname, "..", "..", "backend");
const dir = mkdtempSync(join(tmpdir(), "inv-e2e-"));
const password = process.env.E2E_PASSWORD ?? "e2e-test-password-12345";
const env = {
  ...process.env,
  INV_DASHBOARD_DB_PATH: join(dir, "e2e.sqlite"),
  INV_DASHBOARD_SERVER_MODE: "true",
  INV_DASHBOARD_COOKIE_SECURE: "false",
  INV_DASHBOARD_HOST: "127.0.0.1",
  INV_DASHBOARD_PORT: process.env.E2E_API_PORT ?? "8000",
  INV_DASHBOARD_WEBAUTHN_ORIGIN: `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? "5173"}`,
  INV_DASHBOARD_LOG_DIR: join(dir, "logs"),
};
const uv = (args, input) =>
  spawnSync("uv", ["run", "--directory", backend, ...args], { env, input, stdio: [input ? "pipe" : "ignore", "inherit", "inherit"] });

for (const [args, input] of [
  [["alembic", "upgrade", "head"]],
  [["inv-dashboard-set-password", "--stdin"], `${password}\n`],
]) {
  const r = uv(args, input);
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const child = spawn("uv", ["run", "--directory", backend, "inv-dashboard-server"], { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill());
