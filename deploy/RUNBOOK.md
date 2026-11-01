# Server runbook

How the v6 server is set up and how to look after it, in plain steps. The plan
behind it is [`../docs/v6_one_app_plan.md`](../docs/v6_one_app_plan.md) §3. This
repository is public: no IP addresses or secrets go in here.

## What exists

| Thing | Value |
| --- | --- |
| Server | Hetzner Cloud, x86, 1 vCPU / 1 GB RAM + 2 GB swap, Ubuntu 26.04 LTS, Germany |
| Public IPv4 | see the Hetzner console (keep the primary IP's auto-delete off, so it survives a rebuild) |
| Hetzner firewall | inbound TCP 80 and 443 from anywhere; nothing else |
| Tailnet name | `hetzner-djh-v1` (key expiry disabled; its IP is in the Tailscale admin) |
| Admin user | `daniel`: SSH key only, passwordless sudo, in the `docker` group, plus a console-only password in your password manager |
| App address | `https://investments.daniel-henke.de` (Porkbun `A` record → public IPv4) |
| Off-site backups | Backblaze B2 bucket `Investment-Overview`, endpoint `s3.eu-central-003.backblazeb2.com`; bucket-scoped key in `~/b2.env` on the server |
| App directory | `/opt/investments` (owned by `daniel`) |

Root login, password login and public SSH are all off. Only ports 80/443 are open to
the internet (Hetzner firewall + `ufw`); everything else goes over Tailscale.

## Everyday access

From PowerShell on the laptop:

```bash
ssh daniel@hetzner-djh-v1
```

This needs Tailscale running on the laptop and your key loaded in the Windows SSH
agent. One-time setup per laptop: in an **admin** PowerShell run
`Get-Service ssh-agent | Set-Service -StartupType Automatic; Start-Service ssh-agent`,
then in a normal PowerShell `ssh-add $env:USERPROFILE\.ssh\id_ed25519` and type the
key's passphrase. The agent remembers it across reboots.

**Locked out?** The Hetzner web console (`>_` on the server page) always works,
independent of SSH, Tailscale and the firewall. Log in there as `daniel` with the
console password from your password manager. That password only works on the
console: SSH password login is off.

## Restart

- **Normal restart:** `ssh daniel@hetzner-djh-v1 'sudo reboot'`, or **Power → Reboot**
  in the Hetzner console. Takes about a minute.
- **Comes back by itself:** firewall, Tailscale, Docker, and every container started
  with a restart policy (`caddy-check` today, the app stack later).
- **Automatic reboots:** security updates reboot the server at 04:30 UTC when a
  kernel update needs it. Nothing to do.
- **Check after a restart:** `ssh daniel@hetzner-djh-v1 'uptime; docker ps; sudo ufw status | head -1'`
  and open `https://investments.daniel-henke.de`.

## Rebuild from scratch (about 30 minutes)

Use this when the server is broken beyond repair or you want a clean start. The
script does the heavy lifting; the steps below are the parts only you can do.

**Before you start**

- Once the v6 app is running: make sure the latest B2 snapshot is recent (see
  "Backups"), then restore with the "server gone" recipe under "Restore". Today the server holds no data, so nothing can be lost.
- Have ready: your password manager, the laptop with this repo, Hetzner, Tailscale,
  Porkbun and Backblaze logins.

**1. Fresh server**

- Easiest: in Hetzner, open the server → **Rebuild** → choose the latest Ubuntu LTS.
  This keeps the same server, IP and firewall, and wipes the disk.
- Or create a new server (Ubuntu LTS, x86, your SSH key, backups on, the existing
  firewall) and attach the existing primary IPv4. If the IP changes anyway, update
  the Porkbun `A` record for `investments` to the new IP.
- Temporarily add **TCP 22 from your home IP** to the Hetzner firewall (look up your
  IP at <https://api.ipify.org>).

**2. Laptop: forget the old server's identity**

The new server has a new SSH identity, so your laptop would warn
"REMOTE HOST IDENTIFICATION HAS CHANGED". Clear the old entries:

```bash
ssh-keygen -R <public-ip>
ssh-keygen -R hetzner-djh-v1
```

Then log in once as root to accept the new identity (`ssh root@<public-ip>`, type
`yes`, then `exit`).

**3. Run the bootstrap (from PowerShell in the repo folder)**

```bash
scp deploy/bootstrap.sh root@<public-ip>:/root/
ssh root@<public-ip> 'bash /root/bootstrap.sh'
ssh daniel@<public-ip> 'echo ok'
ssh daniel@<public-ip> 'sudo LOCK_ROOT=1 bash /root/bootstrap.sh'
```

The third line checks that `daniel` works **before** root login is switched off.

**4. Console password**

```bash
ssh daniel@<public-ip>
sudo passwd daniel
```

Use a new strong password, save it in your password manager, and test it once in the
Hetzner web console.

**5. Tailscale**

- In the Tailscale admin (**Machines**), remove the old `hetzner-djh-v1` first, so the
  new server can take the same name.
- On the server: `sudo tailscale up`, open the printed link, approve.
- In the Tailscale admin: **⋯ → Disable key expiry** for the new machine.

**6. Close public SSH**

```bash
ssh daniel@hetzner-djh-v1 'sudo CLOSE_PUBLIC_SSH=1 bash /root/bootstrap.sh'
```

Then delete the port 22 rule in the Hetzner firewall.

**7. Secrets**

- In Backblaze → **Application Keys**, delete the old `investments-server` key and
  create a new one (bucket `Investment-Overview` only, Read and Write).
- On the server, `nano ~/b2.env` with two lines,
  `AWS_ACCESS_KEY_ID=<keyID>` and `AWS_SECRET_ACCESS_KEY=<applicationKey>`, then
  `chmod 600 ~/b2.env`.
- The app's own secrets go in `/opt/investments/app.env` (template:
  `backend/.env.example`; see "First install" step 2).

**8. Web**

Until the v6 app exists, restore the HTTPS placeholder:

```bash
ssh daniel@hetzner-djh-v1
sudo install -d -o daniel -g daniel /opt/investments
printf 'investments.daniel-henke.de {\n\theader X-Robots-Tag "noindex, nofollow"\n\trespond "ok - Investment Overview placeholder" 200\n}\n' > /opt/investments/Caddyfile
docker run -d --name caddy-check --restart unless-stopped -p 80:80 -p 443:443 \
  -v /opt/investments/Caddyfile:/etc/caddy/Caddyfile:ro -v caddy_data:/data -v caddy_config:/config caddy:2
```

Once v6 Phase 2 exists, this step becomes "deploy the app stack and restore the data
from B2".

**9. Check**

`https://investments.daniel-henke.de` loads, `ssh daniel@hetzner-djh-v1` works, and
`ssh root@<public-ip>` is refused.

`bootstrap.sh` is safe to re-run at any time; each step checks before it changes
anything.

## Updates

- **OS:** `unattended-upgrades` installs security updates daily and reboots at
  04:30 UTC when a kernel update needs it.
- **Manual catch-up** (rarely needed): `sudo apt-get update && sudo apt-get full-upgrade`,
  then `sudo reboot` if `/var/run/reboot-required` exists.
- **Containers:** the app image is updated by the deploy workflow (v6 Phase 2).

## Deploying v6

After the one-time setup in "Secrets" below, every green commit on `main` deploys by
itself: GitHub builds the image, pushes it to GHCR (GitHub's container registry), joins
your Tailscale network, and runs on the server (in `/opt/investments`)
`docker compose pull app && docker compose up -d app`. It then asks the app's
`/api/health` for up to two minutes. If the app does not answer, the workflow puts the
previous version back and the run turns red.

- **Switch it on or off:** GitHub repo, **Settings -> Secrets and variables -> Actions
  -> Variables**, `DEPLOY_ENABLED` = `true` (anything else, or missing, = nothing
  deploys).
- **Deploy by hand:** repo **Actions** tab -> **Deploy** -> **Run workflow**.
- **What runs where:** the version in use is the line `APP_TAG=<git sha>` in
  `/opt/investments/.env` on the server; the compose file reads it. Before each
  `docker compose pull` the workflow copies `docker-compose.yml`, `Caddyfile`,
  `restore.sh` and `first_install.sh` from the commit into `/opt/investments`, so the
  server never needs a git checkout. Secrets (`app.env`, `rclone.conf`, `.env`) are never
  touched by it.
- **Look at it:** `ssh daniel@hetzner-djh-v1 'cd /opt/investments && docker compose ps && docker compose logs --tail 50 app'`

## Rolling back

Automatic: a failed health check restores the previous tag (see above).

By hand, to any older version (every deployed commit stays in GHCR as
`ghcr.io/djh961/investment-overview:<git sha>`; find the sha in the repo's commit list):

```bash
ssh daniel@hetzner-djh-v1
cd /opt/investments
sed -i 's/^APP_TAG=.*/APP_TAG=<old git sha>/' .env
docker compose pull app && docker compose up -d app
```

Then turn `DEPLOY_ENABLED` off (or the next green commit deploys over it) until the
bad commit is fixed. A rollback never touches the data in the `app-data` volume; if a
migration changed the database shape, restore the data instead (see
"Restore" below).

## Secrets

Everything below is created by you (AGENTS.md: agents never handle secrets). Never
paste any of it into chat, an issue or a file in the repo.

**A. Tailscale OAuth client (lets GitHub reach the server)**

1. Tailscale admin console -> **Access controls**: add `"tag:ci": ["autogroup:admin"]`
   under `tagOwners`, and an `acls` rule allowing `tag:ci` to reach the server on
   port 22. Save.
2. **Settings -> OAuth clients -> Generate OAuth client**, scope **Auth Keys: write**,
   tag `tag:ci`. Copy the client ID and secret.
3. GitHub repo -> **Settings -> Secrets and variables -> Actions -> Secrets -> New
   repository secret**: `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET`.

**B. Deploy SSH key (GitHub logs in to the server with it)**

1. On the laptop, PowerShell: `ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\inv_deploy -N '""'`
   (a key without passphrase, used only for this).
2. Add the public half on the server (owner types this on the server):
   `ssh daniel@hetzner-djh-v1` then
   `echo '<contents of inv_deploy.pub>' >> ~/.ssh/authorized_keys`.
3. GitHub secret `DEPLOY_SSH_KEY` = the full contents of the private file `inv_deploy`
   (including the `BEGIN`/`END` lines). Then delete the private file from the laptop.

**C. Let the server pull the image from GHCR (owner types this on the server)**

1. GitHub -> your avatar -> **Settings -> Developer settings -> Personal access tokens
   -> Tokens (classic) -> Generate new token**, scope `read:packages` only.
2. On the server: `docker login ghcr.io -u DJH961` and paste the token at the password
   prompt (it is stored in `~/.docker/config.json` on the server).

**D. App secrets (owner types these on the server)**

Create `/opt/investments/app.env` (mode 600) from `backend/.env.example` with the
database passphrase, the backup passphrase and the public address (passkeys). Generate
each random value with `openssl rand -base64 32`. Keep both passphrases in your
password manager as well: losing the DB passphrase means losing the data.

**E. Switch deploys on:** variable `DEPLOY_ENABLED` = `true` (see "Deploying v6"), but
only after "First install" has worked once by hand.

| GitHub item | Kind |
| --- | --- |
| `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `DEPLOY_SSH_KEY` | secrets |
| `DEPLOY_ENABLED` | variable |

## First install

Do this once, after the server is rebuilt/bootstrapped (see "Rebuild from scratch") and
before switching `DEPLOY_ENABLED` on. Everything lives in `/opt/investments`; secrets
A-E are in the "Secrets" section further down.

1. **Secrets A-C** (Tailscale OAuth client, deploy SSH key, GHCR login on the server).
2. **Secret D, on the server:** create `/opt/investments/app.env` from
   `backend/.env.example` (`nano /opt/investments/app.env`, then
   `chmod 600 /opt/investments/app.env`). Fill in at least the database passphrase,
   the backup passphrase, `INV_DASHBOARD_WEBAUTHN_RP_ID` and
   `INV_DASHBOARD_WEBAUTHN_ORIGIN`. Leave the optional token lines commented out.
3. **Backups, on the server:** copy `rclone.conf.example` to
   `/opt/investments/rclone.conf`, fill in the B2 key, `chmod 600` it (see "Backups").
4. **Get the deploy files onto the server** (no git checkout there). From Git Bash in
   the repo folder:

   ```bash
   /c/Windows/System32/OpenSSH/scp.exe deploy/docker-compose.yml deploy/Caddyfile deploy/restore.sh deploy/first_install.sh daniel@hetzner-djh-v1:/opt/investments/
   ```

   (After secret E the deploy workflow does this by itself on every deploy.)
5. **Run the installer, on the server:**

   ```bash
   cd /opt/investments && chmod +x first_install.sh restore.sh && ./first_install.sh
   ```

   It checks Docker, the GHCR login, `app.env` (mode 600 and the required keys, never
   printing values) and `rclone.conf`, removes the `caddy-check` placeholder, runs
   `docker compose up -d` and waits for `/api/health`. If a check fails it says exactly
   what is missing; fix that and run it again.
6. **Set your password, on the server** (you type it; it is not written to any file):

   ```bash
   cd /opt/investments && docker compose exec app inv-dashboard-set-password
   ```

7. **Upload your ledger:** follow "Uploading the ledger" below.
8. **Check from the laptop** (Git Bash, repo folder): `bash deploy/check.sh` (health,
   401 without a login, security headers, HSTS, valid TLS, and with `nmap` installed
   only ports 80/443 open). Sign in at `https://investments.daniel-henke.de`, add a
   passkey on the Onboarding page, and compare the totals with v5.
9. **Switch automatic deploys on** (secret E).

## Try it before the server

Run the real v6 app on your laptop with a copy of your real ledger, and open it on your
phone, before the server is involved. Your v5 files are only read.

1. Close the v5 app. Tailscale must be running on the laptop and on the phone.
2. **Easy way:** in Windows PowerShell, from the repo folder, run
   `.\deploy\try_local.ps1`. It asks for the folder with `ledger.sqlite` and
   `config.sqlite` and does everything below. **By hand:** follow steps 3 to 7.
3. Copy the two files into an empty working folder, e.g. `C:\Temp\upload`.
4. Make the encrypted database with the local flag (you type a passphrase of your
   choice; hidden input):

   ```bash
   cd backend
   uv run inv-dashboard-upload-db --ledger C:/Temp/upload/ledger.sqlite --config C:/Temp/upload/config.sqlite --out C:/Temp/upload/app.sqlite --local-only
   ```

   `--local-only` only changes the "what next" text: nothing is sent anywhere. If it
   says there is no SQLCipher driver (typical on Windows), run the same command inside
   the container on a machine with Docker, as described in "Uploading the ledger".
5. Build the frontend once: `cd frontend && npm install && npm run build`.
6. Find your laptop's Tailscale name (`tailscale status --json`, field `Self.DNSName`,
   without the trailing dot), e.g. `my-laptop.my-tailnet.ts.net`. Passkeys need HTTPS
   and an address that matches exactly, so in the same PowerShell window (from
   `backend/`):

   ```powershell
   $env:INV_DASHBOARD_DB_PATH = "C:\Temp\upload\app.sqlite"
   $env:INV_DASHBOARD_DB_PASSPHRASE = "<the passphrase from step 4>"
   $env:INV_DASHBOARD_SERVER_MODE = "true"
   $env:INV_DASHBOARD_ENCRYPT_SYNCED_TIERS = "true"
   $env:INV_DASHBOARD_COOKIE_SECURE = "true"
   $env:INV_DASHBOARD_HOST = "127.0.0.1"
   $env:INV_DASHBOARD_PORT = "8000"
   $env:INV_DASHBOARD_FRONTEND_DIST = "..\frontend\dist"
   $env:INV_DASHBOARD_WEBAUTHN_RP_ID = "my-laptop.my-tailnet.ts.net"
   $env:INV_DASHBOARD_WEBAUTHN_ORIGIN = "https://my-laptop.my-tailnet.ts.net"
   uv run inv-dashboard-set-password
   ```

7. Share it over Tailscale and start the server:

   ```powershell
   tailscale serve --bg 8000
   uv run inv-dashboard-server
   ```

   On the laptop or phone open `https://my-laptop.my-tailnet.ts.net`, sign in, add a
   passkey. Press Ctrl+C to stop, then `tailscale serve reset` to stop sharing.
8. Clean up: delete `C:\Temp\upload` (it holds your ledger) and close the PowerShell
   window (the passphrase lived only there).

## Rollback to v5

Use this only if v6 has to be abandoned. It turns the server's database back into the
two files the v5.3.1 desktop app reads. Anything that exists only in v6 (FX conversion
batches, passkeys, the login password) is not carried over.

1. On the server: `cd /opt/investments && docker compose stop app`, then make a spare
   copy of the database first (see "Backups").
2. Export (asks for the DB passphrase; never changes `app.sqlite`):
   `docker compose run --rm --no-deps -v /tmp/v5-export:/out --entrypoint inv-dashboard-export-v5 app --db /data/app.sqlite --out /out`
3. From Git Bash on the laptop:
   `/c/Windows/System32/OpenSSH/scp.exe -r daniel@hetzner-djh-v1:/tmp/v5-export .`
   then on the server `rm -r /tmp/v5-export`.
4. Close the v5 desktop app. In `OneDrive\inv-dashboard\`, rename the current
   `ledger.sqlite` and `config.sqlite` to `*.bak`.
5. Copy `ledger.sqlite` and `config.sqlite` from the export into that folder.
6. Start v5 (installer or `git checkout legacy/v5`, see `docs/legacy_v5.md`). It
   rebuilds prices and FX itself on the first refresh. Read
   `docs/legacy_v5_known_bugs.md` on that branch for the numbers v5 gets wrong.
7. Leave the server stopped, or `docker compose up -d app` to go back to v6.

## Side-by-side week

After the first upload, run v5 (desktop, as always) and v6 (server) together for a week.
v5 stays the source of truth until you switch.

- **Every day:** open both, look at Overview and Holdings in EUR and in USD. Compare the
  totals (value, invested, gain), XIRR/TWR and the biggest holding. Write the numbers and
  the date in your own notes (not in this repo).
- **If something differs:** first check Diagnostics in v6 (deposits at the ECB rate,
  missing prices). Known v5 bugs are listed in `docs/legacy_v5.md`; a difference you can
  explain from there is expected. Anything else: stop and ask before trusting v6.
- **New data during the week:** enter it in v5 only, then repeat "Uploading the ledger"
  (it replaces the server database) when you want v6 to catch up. Do not enter data in
  both.
- **When to switch:** seven days in a row with no unexplained difference, backups
  visible in B2 every day (see "Backups"), and one successful restore drill (see
  "Restore"). Then: do a final upload from v5, stop using v5, and from then on enter
  data in v6 only. Keep the v5 files and the "Rollback to v5" steps for at least a month.

## Uploading the ledger

One-off (or repeated for a rehearsal): turns your v5 `ledger.sqlite` and
`config.sqlite` into a single encrypted file for the server. Your v5 files are only
read; the tool works on copies.

1. **Close the v5 app**, then copy `ledger.sqlite` and `config.sqlite` from your
   OneDrive folder into an empty folder, e.g. `C:\Temp\upload`. (Copies, so the app
   cannot write to them while you work.)
2. **Run the tool** (owner types the passphrase; it is the same value as the app's
   `INV_DASHBOARD_DB_PASSPHRASE`; it is asked for with hidden input):

   ```bash
   cd backend
   uv run inv-dashboard-upload-db --ledger C:/Temp/upload/ledger.sqlite --config C:/Temp/upload/config.sqlite --out C:/Temp/upload/app.sqlite
   ```

   It checks the files, brings them to the current schema, merges config into the
   ledger, removes instruments and accounts with no transactions (it lists them;
   `--no-prune` keeps everything), encrypts, reopens the result with the key and
   compares the row counts. It prints the counts and the commands below.
   If it says there is no SQLCipher driver (typical on Windows), run it inside the
   container instead: copy the two files to the server first, then
   `docker compose run --rm -v ~/upload:/in app inv-dashboard-upload-db --ledger /in/ledger.sqlite --config /in/config.sqlite --out /in/app.sqlite`
   (owner types the passphrase there).
3. **Copy to the server** from Git Bash:
   `/c/Windows/System32/OpenSSH/scp.exe C:/Temp/upload/app.sqlite daniel@hetzner-djh-v1:/tmp/app.sqlite`
4. **Put it in the data volume** (this replaces the server's database; the app is
   stopped meanwhile). On the server:

   ```bash
   cd /opt/investments
   docker compose stop app
   docker compose run --rm --no-deps -v /tmp/app.sqlite:/in/app.sqlite:ro --entrypoint sh app -c 'cp /in/app.sqlite /data/app.sqlite && rm -f /data/app.sqlite-wal /data/app.sqlite-shm'
   rm /tmp/app.sqlite
   docker compose up -d app
   ```
5. **Check:** open `https://investments.daniel-henke.de` and compare the totals with
   the v5 app. Then delete `C:\Temp\upload` (it holds your ledger).

## Backups

What is backed up: the whole database (`/data/app.sqlite`, including passkeys and
settings; it is SQLCipher-encrypted already). Prices and FX are re-downloadable and
are just part of the same file.

- **Sealed snapshots.** The app takes a consistent copy of the running database about a
  minute after any change, and at least once a night, and seals it (AES-256-GCM) into
  `/data/backups/snapshot-YYYYMMDD-HHMMSS.sealed.json`. Kept: the newest of each of the
  last 24 hours, 14 days and 12 months.
- **Off-site.** The `backup` container copies `/data/backups` to the B2 bucket
  (`b2:Investment-Overview/snapshots`) every 5 minutes. It only adds files (never
  deletes or overwrites), so a compromised server cannot erase history. In Backblaze set
  the bucket lifecycle to **Keep all versions** (and delete old ones only if you want to
  save space).
- **Download from the app:** Settings -> Download backup (the same sealed file,
  `GET /api/backup?kind=sealed`).

**One-time setup (you do this on the server)**

1. Copy `deploy/rclone.conf.example` to
   `/opt/investments/rclone.conf`, fill in the B2 *application key ID* and *key* (bucket
   `Investment-Overview` only), then `chmod 600 /opt/investments/rclone.conf`.
2. In `app.env` add `INV_DASHBOARD_BACKUP_PASSPHRASE=<long random value>` (for example
   `openssl rand -base64 32`). If you leave it out, the database passphrase is used.
3. **Store offline (password manager, plus a printout if you like):** the database
   passphrase `INV_DASHBOARD_DB_PASSPHRASE`, the backup passphrase, and the B2
   application key. A restore needs both passphrases; without them the backups are
   unreadable by design.
4. `docker compose up -d` and check after a few minutes:
   `docker compose logs backup | tail` shows no errors, and the file appears in the
   bucket.

## Restore

The command is `inv-dashboard-restore`. It lists snapshots, unseals the one you pick,
checks the SQLite integrity and the row counts recorded when it was sealed, and only
then swaps it in atomically. The database it replaces is kept next to it as
`app.sqlite.before-restore-<time>` (nothing is deleted). If anything fails it says so
and leaves the live database untouched.

One command does everything: `deploy/restore.sh` (in `/opt/investments` next to
`docker-compose.yml`). It fetches the snapshots from B2 through the compose `backup`
(rclone) service, stops the app, runs `inv-dashboard-restore`, and starts the app again
(also when the restore fails, then with the old database). `./restore.sh --list` only
shows the snapshots; `--yes` skips the confirmation.

**Server gone (new server, empty volume)**

1. Rebuild the server (see "Rebuild from scratch"), put `app.env` (with both
   passphrases) and `rclone.conf` into `/opt/investments`, and start the stack once:
   `docker compose up -d`.
2. Restore the newest snapshot:

   ```bash
   cd /opt/investments
   ./restore.sh
   ```

3. Open the site and compare the totals with a recent screenshot or the v5 app.

**Bad import or a mistake you want to undo (server is fine)**

```bash
cd /opt/investments
./restore.sh --list                                           # pick a time before the mistake
./restore.sh --at snapshot-20261101-120000.sealed.json
```

Anything entered after that snapshot is lost; the state just before the restore is
still in `app.sqlite.before-restore-<time>` if you need to look at it.

**If the restore refuses:** "wrong passphrase / tampered" means the backup passphrase
differs from the one the snapshot was sealed with; "database cannot be read" means the
database passphrase is wrong; "row counts differ" or "integrity" means that file is
damaged: try the previous snapshot.

**Drill checklist (do this once before relying on it, then every few months)**

- [ ] `docker compose logs backup | tail` clean; newest object in B2 is minutes old.
- [ ] On a scratch machine or a second compose project: fresh volume, `app.env` and
      `rclone.conf` only from your password manager.
- [ ] `./restore.sh --list`, then `./restore.sh` (newest).
- [ ] App starts, login works (passkey or password), totals match the live site.
- [ ] Try `./restore.sh --at <older file>`, and confirm a wrong passphrase is refused.
- [ ] Note the date of the drill here or in your own log.

## Firewall note

Docker-published ports bypass `ufw`. Only the Caddy container publishes ports
(80/443, which are public anyway); app containers must never publish ports.

## Current state (Phase 0 checks)

- `caddy-check` container (Caddy 2.11) serves a placeholder `ok` page with a valid
  Let's Encrypt certificate, `X-Robots-Tag: noindex`, and redirects HTTP → HTTPS.
  It is replaced by the real stack in v6 Phase 2: `docker rm -f caddy-check`.
- yfinance one-shot from the server (2026-10-31): daily closes and 1-minute bars
  returned in under 2 s.
- All-day yfinance polling test: a throwaway job (`yf-spike.timer`, files in
  `/opt/investments/spike/`, not in this repo) runs on Monday 2026-11-02 during the
  US session. After the results are read, remove it:
  `sudo systemctl disable --now yf-spike.timer && sudo rm /etc/systemd/system/yf-spike.* && sudo systemctl daemon-reload && rm -rf /opt/investments/spike && docker rmi yf-spike:1`.
- B2 (2026-10-31): a bucket-scoped key in `~/b2.env` (mode 600) can upload, list,
  download and delete in `Investment-Overview`, and is refused when listing other buckets.
