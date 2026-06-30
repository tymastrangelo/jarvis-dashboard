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

## Architecture notes
- Docker stats come from the Docker socket's HTTP API directly (no `docker` CLI needed in the container)
- Tailscale status comes from shelling out to the `tailscale` binary, mounted read-only from the host
- CPU usage is calculated from two `/proc/stat` samples 10 seconds apart (not `top`, which behaves inconsistently across distros)
