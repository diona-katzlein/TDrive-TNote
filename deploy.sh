#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p logs

# ==============================================================================
# Script Otomatisasi Deploy - TDrive & TNote
# ==============================================================================

# Warna output terminal
HIJAU='\033[0;32m'
BIRU='\033[0;34m'
KUNING='\033[1;33m'
MERAH='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BIRU}====================================================${NC}"
echo -e "${BIRU}   Memulai Proses Sinkronisasi & Deploy TDrive App  ${NC}"
echo -e "${BIRU}====================================================${NC}"

# 1. Menarik pembaruan dari repositori Git
echo -e "\n${KUNING}[1/3] Menarik kode terbaru dari remote git...${NC}"
git pull origin main

if [ $? -eq 0 ]; then
    echo -e "${HIJAU}✔ Pembaruan git pull berhasil ditarik!${NC}"
else
    echo -e "${MERAH}❌ Gagal melakukan git pull. Pastikan tidak ada konflik lokal.${NC}"
    exit 1
fi

# 2. Instalasi dependencies jika ada perubahan package.json
echo -e "\n${KUNING}[2/3] Memeriksa instalasi npm dependencies...${NC}"
npm install --no-audit --no-fund

if [ $? -eq 0 ]; then
    echo -e "${HIJAU}✔ Dependencies ter-update dengan sukses!${NC}"
else
    echo -e "${MERAH}❌ Gagal melakukan instalasi dependencies.${NC}"
    exit 1
fi

# 3. Start/reload menggunakan definisi ecosystem agar cwd, port, log, dan env konsisten.
echo -e "\n${KUNING}[3/3] Reload PM2 process dari ecosystem.config.js...${NC}"
pm2 startOrReload ecosystem.config.js --env production --update-env
pm2 save

# Keep this synchronized with ecosystem.config.js. Do not prefer the deployment
# shell's PORT because PM2/shell sessions may retain a stale PORT=3000 value.
APP_PORT=3101
READY_URL="http://127.0.0.1:${APP_PORT}/readyz"
for attempt in {1..20}; do
    if curl --fail --silent --show-error --max-time 3 "$READY_URL" >/dev/null; then
        echo -e "${HIJAU}✔ PM2 process 'tdrive-app' siap pada port ${APP_PORT}.${NC}"
        break
    fi
    if [ "$attempt" -eq 20 ]; then
        echo -e "${MERAH}❌ Aplikasi tidak ready setelah 20 percobaan. Log terakhir:${NC}"
        pm2 logs tdrive-app --lines 80 --nostream
        exit 1
    fi
    sleep 1
done

echo -e "\n${HIJAU}====================================================${NC}"
echo -e "${HIJAU}       PROSES DEPLOY BERHASIL DISELESAIKAN!         ${NC}"
echo -e "${HIJAU}====================================================${NC}"
