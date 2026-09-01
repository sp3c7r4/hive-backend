#!/bin/bash
# ------------------------------------------------------------------
# Hive backend — remote deploy script (runs ON the EC2 box via SSM)
# Env vars provided by the workflow: S3_BUCKET, ARTIFACT_KEY, ENV_KEY
# ------------------------------------------------------------------
set -euo pipefail

sudo dnf install -y rsync >/dev/null 2>&1 || true
# self-heal: a corrupted box once lost /usr/bin/cp (rpm -V missing)
command -v cp >/dev/null 2>&1 || sudo dnf reinstall -y coreutils >/dev/null 2>&1 || true

cd /home/ec2-user
aws s3 cp "s3://${S3_BUCKET}/${ARTIFACT_KEY}" /tmp/release.tar.gz
aws s3 cp "s3://${S3_BUCKET}/${ENV_KEY}" /tmp/env.production

rm -rf hive-backend.tmp && mkdir -p hive-backend.tmp
tar -xzf /tmp/release.tar.gz -C hive-backend.tmp
rm -f /tmp/release.tar.gz

rsync -a --delete hive-backend.tmp/ /home/ec2-user/hive-backend/
rm -rf hive-backend.tmp

cp /tmp/env.production /home/ec2-user/hive-backend/.env.production
chmod 600 /home/ec2-user/hive-backend/.env.production
rm -f /tmp/env.production

cd /home/ec2-user/hive-backend
rm -rf node_modules   # npm ci ENOTEMPTY on stale dirs otherwise
npm ci --omit=dev --ignore-scripts

# Apply the repo-owned docker-compose.yml (Postgres + Redis + anything you add)
mkdir -p /opt/hive-db
cp docker-compose.yml /opt/hive-db/docker-compose.yml
PG_PW=$(grep -oP '^POSTGRES_PASSWORD=\K.*' .env.production | head -1)
echo "POSTGRES_PASSWORD=${PG_PW}" > /opt/hive-db/.env
chmod 600 /opt/hive-db/.env
cd /opt/hive-db && docker compose up -d
cd /home/ec2-user/hive-backend

NODE_ENV=production node ./dist/migrate.js

export PATH="$PATH:$(npm config get prefix 2>/dev/null)/bin"
pm2 startup systemd -u ec2-user --hp /home/ec2-user >/dev/null 2>&1 || true
pm2 startOrReload ecosystem.config.cjs || pm2 start ecosystem.config.cjs
pm2 save >/dev/null 2>&1 || true
sleep 3
pm2 status
