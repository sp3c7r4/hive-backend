#!/bin/bash
# ------------------------------------------------------------------
# Hive backend — STAGING deploy script (runs ON the EC2 box via SSM)
# Shares the prod box + code dir; never touches prod PM2 apps.
# Env vars provided by the workflow: S3_BUCKET, ARTIFACT_KEY, ENV_KEY
# ------------------------------------------------------------------
set -euo pipefail

cd /home/ec2-user
aws s3 cp "s3://${S3_BUCKET}/${ARTIFACT_KEY}" /tmp/release.tar.gz
aws s3 cp "s3://${S3_BUCKET}/${ENV_KEY}" /tmp/env.staging

rm -rf hive-backend.tmp && mkdir -p hive-backend.tmp
tar -xzf /tmp/release.tar.gz -C hive-backend.tmp
rm -f /tmp/release.tar.gz

# @info - Code dir is SHARED with prod (same box). Rsyncing the dist
# under running prod processes is safe: prod forks keep the old code in
# memory until their own restart. Staging restarts pick up the new code.
rsync -a hive-backend.tmp/ /home/ec2-user/hive-backend/
rm -rf hive-backend.tmp

cp /tmp/env.staging /home/ec2-user/hive-backend/.env.staging
chmod 600 /home/ec2-user/hive-backend/.env.staging
chown ec2-user:ec2-user /home/ec2-user/hive-backend/.env.staging
rm -f /tmp/env.staging

cd /home/ec2-user/hive-backend

# Staging migrations run against hive_staging only (env points there)
runuser -u ec2-user -- bash -lc "cd /home/ec2-user/hive-backend && NODE_ENV=staging node ./dist/migrate.js"

# Restart ONLY the staging PM2 apps
runuser -u ec2-user -- bash -lc "cd /home/ec2-user/hive-backend && pm2 delete hive-api-staging >/dev/null 2>&1 || true; NODE_ENV=staging PORT=5010 pm2 start dist/server.js --name hive-api-staging"
runuser -u ec2-user -- bash -lc "cd /home/ec2-user/hive-backend && pm2 delete hive-workers-staging >/dev/null 2>&1 || true; NODE_ENV=staging pm2 start dist/init.workers.js --name hive-workers-staging"
runuser -u ec2-user -- bash -lc "pm2 save >/dev/null 2>&1 || true"
runuser -u ec2-user -- bash -lc "pm2 jlist 2>/dev/null | python3 -c \"import sys,json; d=json.load(sys.stdin); [print(p['name'], p['pm2_env']['status']) for p in d if 'staging' in p['name']]\""
echo "STAGING_DEPLOY_DONE"
