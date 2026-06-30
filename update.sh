#!/bin/bash
set -e
echo "==> Pulling latest changes..."
git pull
echo "==> Rebuilding containers..."
sudo docker compose up -d --build --force-recreate
echo "==> Done. Dashboard live at http://localhost:3010"
