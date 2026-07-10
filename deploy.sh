#!/bin/bash

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

# 3. Restart process Node.js menggunakan PM2
echo -e "\n${KUNING}[3/3] Melakukan restart PM2 process: tdrive-app...${NC}"
pm2 restart tdrive-app

if [ $? -eq 0 ]; then
    echo -e "${HIJAU}✔ PM2 process 'tdrive-app' berhasil direstart!${NC}"
else
    echo -e "${KUNING}⚠ PM2 gagal restart langsung. Mencoba mendaftarkan & menjalankan ulang...${NC}"
    pm2 start src/app.js --name "tdrive-app"
    if [ $? -eq 0 ]; then
      echo -e "${HIJAU}✔ PM2 process 'tdrive-app' berhasil didaftarkan & dijalankan!${NC}"
    else
      echo -e "${MERAH}❌ Gagal menjalankan PM2 process.${NC}"
      exit 1
    fi
fi

echo -e "\n${HIJAU}====================================================${NC}"
echo -e "${HIJAU}       PROSES DEPLOY BERHASIL DISELESAIKAN!         ${NC}"
echo -e "${HIJAU}====================================================${NC}"
