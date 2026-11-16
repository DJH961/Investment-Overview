# Legacy v5 (frozen at v5.3.1)

## What it is

**v5.3.1 is the final v5 release**: the desktop app (NiceGUI) plus the read-only
web companion. It is frozen on:

- branch `legacy/v5`
- tag `v5.3.1`

It has **zero support**: no fixes, no dependency updates, no backports. Nothing is
ever committed to `legacy/v5`, except the owner-requested list of known, unfixed v5
bugs (`docs/legacy_v5_known_bugs.md` on that branch).

**Since 7.0 the v5 code is gone from `main`.** The v5 desktop app, the Windows
installer, the Cloudflare Worker and the encrypted-blob publishing were deleted in
the cutover release (see [`v7_plan.md`](v7_plan.md) §8). The last `main` tree that
still contained them is kept under the tag **`v5-archive`**. The GitHub Pages site
(`web/`, built with `VITE_DEMO_ONLY=1`) stays as an offline demo only.

## Comparing with v5

For "do it like in v5", read the old code from the `v5-archive` tag; do not copy it
back into the tree without a design decision (it breaks the layering and the
server-computes rule). All of these are read-only:

- Search the old code: `git grep -n "<pattern>" v5-archive`
- Show one old file: `git show v5-archive:<path>`
  (for example `git show v5-archive:backend/src/investment_dashboard/ui/main.py`)
- List an old folder: `git ls-tree -r --name-only v5-archive <dir>/`
- Browse it like a normal checkout, in a separate read-only worktree next to the repo:
  `git worktree add ../Investment-Overview-v5 v5-archive`
  (this checks out a detached HEAD; do not commit there).
  Remove it when done: `git worktree remove ../Investment-Overview-v5`

`legacy/v5` and `v5.3.1` stay frozen as before. `v5-archive` is a tag: never move or
delete it.

## Running v5 again

Only as a temporary fallback, and only on the home network (LAN-only, as before).
From a separate worktree (see above) of tag `v5.3.1` or `legacy/v5`, run it from
source: `run_dashboard.vbs` (or `run_dashboard.bat`). The `v5.3.1` GitHub release
also still carries `InvestmentDashboard-Setup.exe` and
`InvestmentDashboard-Portable.zip`.

Where the v5 data lives:

- Ledger and config: `OneDrive\inv-dashboard\`
- Cache (prices, FX, snapshots; safe to rebuild): `%LOCALAPPDATA%\inv-dashboard\cache.sqlite`

Going back to v5 with data entered in v6 is no longer a supported tool: the
`inv-dashboard-export-v5` exporter and the "downgrade to `0014`" CI check were removed
in 7.0. If it is ever needed, take them from `v5-archive`
(`git show v5-archive:backend/src/investment_dashboard/tools/export_v5_ledger.py`).
The pre-cutover v5 ledger is also kept as a sealed (encrypted) backup.

## Troubleshooting: installed but nothing opens (Windows)

The shortcuts and the portable `.cmd` start the app with the windowless
`pythonw.exe`, which discards all console output, so a crash (port 8080 already in
use, missing dependency, firewall block) looks like "nothing happened". Every
launch therefore writes a `launcher.log` with the environment and any traceback:

- Installed app: `%LOCALAPPDATA%\InvestmentDashboard\launcher.log`
- Portable bundle: next to `Run-InvestmentDashboard.cmd`
- From a source checkout: next to `run_dashboard.py`

Steps, in order:

1. Read `launcher.log` (set `INV_DASHBOARD_LAUNCHER_DEBUG=1` for more detail).
2. Run the launcher with the console interpreter to see errors live, e.g.
   `"%LOCALAPPDATA%\InvestmentDashboard\python\python.exe" "%LOCALAPPDATA%\InvestmentDashboard\launcher.py"`
   (portable: `.\python\python.exe .\portable_launcher.py`).
3. Check the port: `netstat -ano | findstr :8080`. If taken, set
   `INV_DASHBOARD_PORT=8099` and retry.
4. Open `http://localhost:8080` manually; the app may be running with only the
   browser tab missing.

## Security note

Frozen dependencies will age and collect known vulnerabilities. Use legacy v5 only
as a **temporary fallback**, and only on your home network (LAN-only, as before).
Do not expose it to the internet.
