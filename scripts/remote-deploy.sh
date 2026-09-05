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
# pm2 runs the apps as ec2-user - the env file must be readable by it
chown ec2-user:ec2-user /home/ec2-user/hive-backend/.env.production
rm -f /tmp/env.production

cd /home/ec2-user/hive-backend
rm -rf node_modules   # npm ci ENOTEMPTY on stale dirs otherwise
npm ci --omit=dev --ignore-scripts

# Apply the PROD compose (Redis only, redis.conf). The database lives in
# RDS; the old Postgres container is retired below.
mkdir -p /opt/hive-db
cp docker-compose.prod.yml /opt/hive-db/docker-compose.prod.yml
cp redis.conf /opt/hive-db/redis.conf
cd /opt/hive-db
sudo dnf install -y docker-compose-plugin >/dev/null 2>&1 || true
docker compose -f docker-compose.prod.yml up -d 2>/dev/null || docker-compose -f docker-compose.prod.yml up -d
# Retire the local Postgres container (data now lives in RDS). The old
# volume is kept for a week as a rollback artifact.
if docker ps -a --format '{{.Names}}' | grep -q '^hive-postgres$'; then
  docker rm -f hive-postgres || true
  echo "hive-postgres container retired (volume kept)"
fi

cd /home/ec2-user/hive-backend

NODE_ENV=production node ./dist/migrate.js

# @info - Headless Chrome for the browser engine (certificates/receipts).
# Puppeteer-core ships no binary: install the pinned version + its system
# libs, or the workers crash at boot (BrowserEngine.start) and the queues
# sit unprocessed (hard-won 2026-09-02: every email job waited forever).
sudo dnf install -y atk at-spi2-atk cups-libs libXcomposite libXdamage libXrandr libgbm libxkbcommon nss alsa-lib pango cairo libX11 libXcursor libXext libXi libXinerama libXScrnSaver libXtst mesa-libGL >/dev/null 2>&1 || true
runuser -u ec2-user -- bash -lc "cd /home/ec2-user/hive-backend && npx puppeteer browsers install chrome >/dev/null 2>&1 || true"

export PATH="$PATH:$(npm config get prefix 2>/dev/null)/bin"
pm2 startup systemd -u ec2-user --hp /home/ec2-user >/dev/null 2>&1 || true
# @info - rsync -a copies the temp dir's ROOT ownership over the app dir,
# which is why logs/errors EACCES kept resurrecting after deploys: the
# ec2-user processes cannot create log files. chown the whole app dir
# (npm ci above also runs as root).
chown -R ec2-user:ec2-user /home/ec2-user/hive-backend
# @info - pm2 MUST run as ec2-user (not root): the systemd unit targets
# ec2-user, so root-owned processes would vanish on reboot and ec2-user's
# `pm2 list` would show an empty daemon while root runs the apps.
runuser -u ec2-user -- bash -lc "pm2 delete hive-backend hive-workers 2>/dev/null || true"
runuser -u ec2-user -- bash -lc "cd /home/ec2-user/hive-backend && pm2 start ecosystem.config.cjs"
runuser -u ec2-user -- bash -lc "pm2 save >/dev/null 2>&1 || true"
sleep 3
runuser -u ec2-user -- bash -lc "pm2 status"
