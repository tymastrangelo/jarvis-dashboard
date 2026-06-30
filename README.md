# JARVIS Home Lab Dashboard

A real-time HUD-style dashboard for monitoring a home server. Pulls live data from the host system, Docker, Tailscale, and AdGuard Home.

## Stack
- **Backend**: Node.js (no dependencies), reads `/proc`, Docker socket, and shells out to `tailscale`
- **Frontend**: Static HTML/CSS/JS served by nginx
- **Networking**: Both containers run in `network_mode: host` so the backend can read host stats directly

## First-time setup
```bash
git clone <your-repo-url> jarvis
cd jarvis
cp .env.example .env
nano .env   # set ADGUARD_PASS
sudo docker compose up -d --build
```

Dashboard will be live at `http://<server-ip>:3010`.

## Updating after a code change
```bash
cd /opt/stacks/jarvis
./update.sh
```

This pulls the latest from git and recreates the containers.

## Environment variables (.env)
- `ADGUARD_PASS` — your AdGuard Home admin password, used to pull DNS stats
- `DASHBOARD_PASSWORD` — set this to require the custom JARVIS login screen. **Leave blank to keep the dashboard open** (no login). Changing it logs everyone out.
- `SESSION_SECRET` — optional; pin it to keep logins valid across a full data wipe. Auto-generated and saved to `./data/.session-secret` if blank.
- `REFRESH_MS` — optional; how often (ms) the backend recomputes and pushes live stats. Default `3000`.

## Custom login (replacing Cloudflare Access)
The dashboard has its own themed login. To switch off Cloudflare's password and use it:
1. Set `DASHBOARD_PASSWORD=something` in `.env` and run `./update.sh`.
2. Confirm the login screen works (locally and over your tunnel).
3. **Only then**, in the Cloudflare Zero Trust dashboard, remove the Access policy/application protecting the tunnel hostname. (This step is on Cloudflare's side — it can't be done from this repo.)

Security note: the login protects all data APIs (`/api/stats`, `/api/events`, `/api/layout`). The static HTML shell itself is served without auth but contains no data. This is weaker than Cloudflare Access — keep the tunnel + this login if you want defense in depth.

## Live updates
Stats stream to the browser over Server-Sent Events (`/api/events`); the backend computes once on a `REFRESH_MS` loop and fans out to every client. If SSE can't hold open, the frontend falls back to polling automatically. Connection loss, service outages, critical temperature, and low disk raise on-screen toast alerts.

## Architecture notes
- Docker stats come from the Docker socket's HTTP API directly (no `docker` CLI needed in the container)
- Tailscale status comes from shelling out to the `tailscale` binary, mounted read-only from the host
- CPU usage is calculated from two `/proc/stat` samples one refresh cycle apart (not `top`, which behaves inconsistently across distros)
# Auto-deploy test Mon Jun 29 23:21:16 EDT 2026
# Test 2
# Test 3
