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

# Apply the repo-owned docker-compose.yml (Postgres + Redis + anything you add)
mkdir -p /opt/hive-db
cp docker-compose.yml /opt/hive-db/docker-compose.yml
PG_PW=$(grep -oP '^POSTGRES_PASSWORD=\K.*' .env.production | head -1)
echo "POSTGRES_PASSWORD=${PG_PW}" > /opt/hive-db/.env
chmod 600 /opt/hive-db/.env
cd /opt/hive-db
sudo dnf install -y docker-compose-plugin >/dev/null 2>&1 || true
docker compose up -d 2>/dev/null || docker-compose up -d

# @info - DB password CONVERGENCE: compose only sets the password at volume
# init. If the shipped env changed it, sync it to the running Postgres so
# the app never breaks on a password rotation. The check runs from the HOST
# (through docker-proxy = real scram auth; in-container 127.0.0.1 is trust).
# ALTER uses the in-container socket (passwordless). POSTGRES_USER/DB are
# structural and still require a manual migration.
sudo dnf install -y postgresql16 >/dev/null 2>&1 || sudo dnf install -y postgresql15 >/dev/null 2>&1 || true
PG_PW_ESC=${PG_PW//\'/''}
if ! PGPASSWORD="$PG_PW" psql -h 127.0.0.1 -U postgres -d hive -t -A -c "SELECT 1" >/dev/null 2>&1; then
  docker exec hive-postgres psql -U postgres -d hive -c "ALTER USER postgres PASSWORD '$PG_PW_ESC';" >/dev/null 2>&1 || true
  echo "postgres password synced to the shipped env"
fi
cd /home/ec2-user/hive-backend

NODE_ENV=production node ./dist/migrate.js

export PATH="$PATH:$(npm config get prefix 2>/dev/null)/bin"
pm2 startup systemd -u ec2-user --hp /home/ec2-user >/dev/null 2>&1 || true
# @info - pm2 MUST run as ec2-user (not root): the systemd unit targets
# ec2-user, so root-owned processes would vanish on reboot and ec2-user's
# `pm2 list` would show an empty daemon while root runs the apps.
runuser -u ec2-user -- bash -lc "pm2 delete hive-backend hive-workers 2>/dev/null || true"
runuser -u ec2-user -- bash -lc "cd /home/ec2-user/hive-backend && pm2 start ecosystem.config.cjs"
runuser -u ec2-user -- bash -lc "pm2 save >/dev/null 2>&1 || true"
sleep 3
runuser -u ec2-user -- bash -lc "pm2 status"
