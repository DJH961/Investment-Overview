# Server runbook

How the v6 server is set up and how to look after it. Plain steps, newest first
where it matters. The plan behind it is [`../docs/v6_one_app_plan.md`](../docs/v6_one_app_plan.md) §3.

## What exists

| Thing | Value |
| --- | --- |
| Server | Hetzner Cloud, x86, 1 vCPU / 1 GB RAM + 2 GB swap, Ubuntu 26.04 LTS, Germany |
| Public IPv4 | see the Hetzner console (keep the primary IP's auto-delete off, so it survives a rebuild) |
| Tailnet name | `hetzner-djh-v1` (key expiry disabled; its IP is in the Tailscale admin) |
| Admin user | `daniel` (SSH key only, passwordless sudo, in the `docker` group) |
| App address | `https://investments.daniel-henke.de` (Porkbun `A` record → public IPv4) |
| Off-site backups | Backblaze B2 bucket `Investment-Overview`, endpoint `s3.eu-central-003.backblazeb2.com` |
| App directory | `/opt/investments` (owned by `daniel`) |

Root login, password login and public SSH are all off. Only ports 80/443 are open to
the internet (Hetzner firewall + `ufw`); everything else goes over Tailscale.

## Everyday access

```bash
ssh daniel@hetzner-djh-v1
```

Your laptop needs Tailscale running and your key loaded in the Windows SSH agent
(`ssh-add $env:USERPROFILE\.ssh\id_ed25519` once; the agent remembers it).

**Locked out?** The Hetzner web console (`>_` on the server page) always works,
independent of SSH, Tailscale and the firewall. Log in there as `daniel` with the
console password from your password manager. That password only works on the console:
SSH password login is off.

## Rebuild from scratch (about 15 minutes)

1. Create the server in Hetzner: Ubuntu LTS, x86, your SSH key, the firewall
   (80/443 from anywhere, 22 from your home IP only, temporarily), backups on, and
   attach the existing primary IPv4.
2. Copy and run the bootstrap, step by step:
   ```bash
   scp deploy/bootstrap.sh root@<ip>:/root/
   ssh root@<ip> 'bash /root/bootstrap.sh'                    # base setup + admin user
   ssh daniel@<ip> 'echo ok'                                  # check before locking root
   ssh daniel@<ip> 'sudo LOCK_ROOT=1 bash /root/bootstrap.sh' # no root / password login
   ```
3. Join the tailnet: `ssh daniel@<ip>`, then `sudo tailscale up`, open the printed
   link and approve. In the Tailscale admin, disable key expiry for the machine.
4. Close public SSH: `ssh daniel@<tailnet-name> 'sudo CLOSE_PUBLIC_SSH=1 bash /root/bootstrap.sh'`,
   then delete the port 22 rule in the Hetzner firewall.
5. Restore data from B2 (procedure added in v6 Phase 2).

`bootstrap.sh` is safe to re-run at any time; each step checks before it changes
anything.

## Updates

- **OS:** `unattended-upgrades` installs security updates daily and reboots at
  04:30 UTC when a kernel update needs it.
- **Manual catch-up** (rarely needed): `sudo apt-get update && sudo apt-get full-upgrade`,
  then `sudo reboot` if `/var/run/reboot-required` exists.
- **Containers:** the app image is updated by the deploy workflow (v6 Phase 2).

## Firewall note

Docker-published ports bypass `ufw`. Only the Caddy container publishes ports
(80/443, which are public anyway); app containers must never publish ports.

## Current state (Phase 0 checks)

- `caddy-check` container (Caddy 2.11) serves a placeholder `ok` page with a valid
  Let's Encrypt certificate, `X-Robots-Tag: noindex`, and redirects HTTP → HTTPS.
  It is replaced by the real stack in v6 Phase 2: `docker rm -f caddy-check`.
- yfinance one-shot from the server (2026-10-31): daily closes and 1-minute bars
  returned in under 2 s. The all-day polling test is still to do.
- B2 (2026-10-31): a bucket-scoped key in `~/b2.env` (mode 600) can upload, list,
  download and delete in `Investment-Overview`, and is refused when listing other buckets.
