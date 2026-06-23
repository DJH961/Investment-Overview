# Investment Overview — Setup Simplification Plan

_Authored 2026-06-23. Reference doc to compare the finished work against._

Repo (working tree): `web/`

## Why
The first-run "Set up the companion" screen presented 7 fields as equals. In
practice:
- Only the **API key** and a **CORS-enabled data-source URL** (the Cloudflare
  Worker) are actually required — the GitHub release-asset path can't be fetched
  cross-origin (no CORS header), so "Data repository" framed as the primary
  source was misleading and unusable for the hosted app.
- **Repo / Release tag / Version-file URL** were dead/derivable plumbing.
- **Quote cache** vs **Auto-refresh** were two knobs for one perceived thing
  ("how fresh are my prices"), with no good reason to diverge for a single user.
- Re-entering API key + blob URL + preferences on every device was painful.

## Goals (agreed with user)
1. **Three core fields** on setup: Twelve Data API key · Data source URL ·
   Update every N minutes.
2. **Sunset entirely**: `repo`, `releaseTag`, `metaUrl` (UI + AppConfig +
   storage). Data fetch uses the blob URL only; meta sidecar auto-derives.
3. **Merge** `quoteCacheMinutes` + `autoRefreshMinutes` → a single
   `updateMinutes` driving both the wake cadence and cache staleness.
4. **Export / Import config (Plan A)**: a portable JSON packet the user can save
   and load on another device, then edit. Plaintext is acceptable for A because
   it's a private file (no worse than today's localStorage). Packet carries
   `type` + `version` so a future **encrypted, Worker-published Plan B** drops in
   without breaking A.
5. **All preferences available pre-login**: Theme, Clock format, Auto-lock (and
   Fingerprint where supported) shown on the setup screen as well as Settings,
   so the user never has to set dark mode / 24h after entering the passphrase.
6. Setup screen stays **fully editable before login**; Import repopulates the
   visible fields for review/tweak before "Save & continue".

## Flow (as user described)
3 core fields + Import button → if Import, return to the same fields now filled
in and editable → continue (Save & continue → unlock) as before.

## Migration (no data loss for existing installs)
On `loadConfig`:
- If no new `blobUrl` but a legacy `repo` exists → synthesize the release-asset
  URL into `blobUrl` once.
- `updateMinutes` ← legacy `quoteCacheMinutes` (preferred, it's the real refetch
  gate) → else legacy `autoRefreshMinutes` → else default (15).
On `saveConfig`: clear all legacy storage keys so migration only fires once.

## Config shape (after)
```
AppConfig = { apiKey, blobUrl, updateMinutes, autoLockMinutes }
```
Dropped: `repo`, `releaseTag`, `metaUrl`, `quoteCacheMinutes`,
`autoRefreshMinutes`.

Defaults: `updateMinutes` 15 (max 240), `autoLockMinutes` 5 (max 240, 0 = never).

## Files to change
- `web/src/config.ts` — new AppConfig, storage keys + legacy migration,
  `resolveBlobUrl`/`resolveMetaUrl` simplified, `parseUpdateMinutes`,
  `serializeConfig` / `parseConfigPacket` (packet type+version).  **[done]**
- `web/src/app.ts` — setup form: 3 core fields + preferences (theme/clock/
  auto-lock/fingerprint) shown pre-login + Export/Import; submit validates
  `apiKey` + `blobUrl`; timing consumers use `updateMinutes`
  (`cacheTtlMs` @ ~969, `slowIntervalMs` @ ~1344); fix imports.  **[in progress]**
- `web/src/styles.css` — remove the now-unused `.advanced` disclosure block I
  added in an earlier pass; add any button-row/import styling needed.  **[todo]**
- `web/test/config.test.ts` (+ any others referencing the old shape) — update to
  the new config + add packet round-trip and migration coverage.  **[todo]**

## Security notes
- API key remains encrypted at rest in localStorage (unchanged).
- Plan A export is plaintext **by design**, for a private file. The user
  explicitly accepted this. Plan B (future) is always passphrase-encrypted,
  reusing the unlock passphrase, since it would be network-reachable.

## Out of scope (this pass)
- Plan B (encrypted packet published via the Cloudflare Worker) — requires
  Worker + desktop publisher changes. Packet format is forward-compatible for it.

## Verification
- `npm run typecheck` clean.
- `npm test` green.
- `npm run build` succeeds.
- Manual: fresh setup shows 3 fields + prefs + Import; export → import round
  trips; legacy localStorage migrates; prices still refresh.

## Status checklist
- [x] config.ts rewrite
- [x] app.ts setup form (3 fields + prefs pre-login + import/export)
- [x] app.ts timing merge to updateMinutes
- [x] styles.css cleanup
- [x] tests updated + green
- [x] typecheck + test + build verified (431 tests pass)
