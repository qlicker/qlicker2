# Qlicker Production Deployment Guide

This directory contains everything needed to deploy Qlicker in production using Docker Compose behind an Nginx reverse proxy with TLS termination on ports 443 (HTTPS) and 80 (HTTP redirect).

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Quick Start](#quick-start)
4. [Setup Script](#setup-script)
5. [TLS Certificates](#tls-certificates)
6. [Server Scaling](#server-scaling)
7. [Initializing from Legacy Database](#initializing-from-legacy-database)
8. [S3 Private-Bucket Migration](#s3-private-bucket-migration)
9. [User Management](#user-management)
10. [Backups](#backups)
11. [Updating](#updating)
12. [File Structure](#file-structure)
13. [Environment Variables](#environment-variables)
14. [Monitoring & Logs](#monitoring--logs)
15. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
                    Internet
                       │
                ┌──────┴──────┐
                │  Nginx :443 │  ← TLS termination, HTTP→HTTPS redirect
                │       :80   │  ← Let's Encrypt ACME challenge
                └──────┬──────┘
                       │
          ┌────────────┼────────────┐
          │            │            │
     ┌────┴────┐  ┌───┴────┐  ┌───┴────┐
     │ Server  │  │ Server │  │ Server │  ← Fastify API (configurable replicas)
     │ :3001   │  │ :3001  │  │ :3001  │
     └────┬────┘  └───┬────┘  └───┬────┘
          │            │            │
          └────────────┼────────────┘
                       │
              ┌────────┴────────┐
              │                 │
         ┌────┴────┐      ┌────┴────┐
         │ MongoDB │      │  Redis  │
         │  :27017 │      │  :6379  │
         └─────────┘      └─────────┘
```

**Key components:**

| Service | Purpose | Exposed Ports |
|---------|---------|---------------|
| **Nginx** | TLS termination, reverse proxy, load balancing | 80, 443 |
| **Server** (Fastify) | REST API + WebSocket server | Internal only |
| **Client** (React SPA) | Static frontend served by internal Nginx | Internal only |
| **MongoDB** | Database | Internal only |
| **Redis** | WebSocket pub/sub for multi-instance sync | Internal only |
| **Certbot** (optional) | Automatic Let's Encrypt certificate renewal | None |

Only ports **80** and **443** are exposed to the host.

---

## Prerequisites

- **Docker** ≥ 24.x with Docker Compose plugin (`docker compose`)
- **Domain name** pointing to the server's IP address
- **TLS certificate** (Let's Encrypt recommended, or bring your own)
- **SMTP server** for email features (password reset, email verification)
- At least **2 GB RAM** and **2 CPU cores** for a basic deployment

---

## Quick Start

```bash
# 1. Copy the production_setup directory to your server
scp -r production_setup/ user@server:/opt/qlicker/

# 2. SSH into the server
ssh user@server
cd /opt/qlicker

# 3. Run the interactive setup
chmod +x *.sh
./setup.sh

# 4. (Optional) Obtain Let's Encrypt certificate
./setup.sh --init-certs

# 5. Start the application
docker compose up -d

# 6. Check status
docker compose ps

# 7. View logs
docker compose logs -f
```

The first user to create an account via the web UI is automatically promoted to **admin**.

---

## Setup Script

The interactive `setup.sh` script generates the `.env` file with all required configuration:

```bash
./setup.sh
```

It will prompt for:

| Setting | Description | Default |
|---------|-------------|---------|
| Domain | Your server's FQDN | `qlicker.example.com` |
| Server/client image tags | Tags applied to existing image repositories | `latest` (or current `.env` values) |
| App version label | Runtime release string baked into app images/UI | Repository `VERSION` when available, otherwise `latest`; may be overridden in `.env` |
| TLS certificate path | Path to fullchain.pem | `./certs/fullchain.pem` |
| TLS key path | Path to privkey.pem | `./certs/privkey.pem` |
| Let's Encrypt auto-renew | Whether certs are Let's Encrypt-managed (renewed by certbot, served from the shared volume) | `false` (or current `.env` value) |
| Server replicas | Number of API server instances | `2` |
| JWT secrets | Auto-generated cryptographic secrets | (generated) |
| MAIL_URL | SMTP connection string | (none) |
| MongoDB admin username | Built-in MongoDB admin user | `qlickerAdmin` |
| MongoDB admin password | Built-in MongoDB admin password | (generated) |
| MONGO_URI | MongoDB connection URI | derived from the MongoDB admin credentials |
| Mongo cache size | WiredTiger cache in GB | `0.25` |
| Redis password | Built-in Redis password | (generated) |
| REDIS_URL | Redis connection URL | derived from `REDIS_PASSWORD` |
| Backup policy | Controlled in Admin -> Backup | `02:00` local, keep `7` daily / `4` weekly / `12` monthly |

Mongo tuning variables such as `MONGO_MAX_POOL_SIZE`,
`MONGO_SERVER_SELECTION_TIMEOUT_MS`, and retry settings are also carried
through from the existing `.env` or `.env.example` and written to the generated
`.env`, even though setup does not prompt for each of them individually.

Setup also writes the other optional settings without prompting:
`TLS_RELOAD_CHECK_SECONDS`, `ANONYMOUS_SESSION_SECRET`, `TRUST_PROXY`,
`DISABLE_RATE_LIMITS`, the `AI_BACKEND_*` settings, and the `SYSTEM_MONITOR_*`
settings. When re-run against an existing production `.env`, setup keeps their
current values. Otherwise it writes the documented defaults, so development
values such as a disabled rate limiter are never imported into production.

### Configuration Inheritance

The setup script loads defaults from existing configuration files in priority order:

| Priority | Source | When used |
|----------|--------|-----------|
| 1 (highest) | `production_setup/.env` | Re-running setup — all current production values are proposed as defaults |
| 2 | Root-level `.env` (dev config in `../`) | First-time production setup — inherits JWT secrets, MAIL_URL, and other applicable settings from dev |
| 3 (lowest) | `.env.example` | Fresh install — uses documented static defaults |

When an existing config is found, the script prints a summary of imported values. At each prompt the loaded default is shown in square brackets — press **Enter** to keep it, or type a new value to override.

### Re-running Setup

Running `./setup.sh` again will detect the existing `.env` and offer to keep current values as defaults. The generated `.env` is also written with mode `600` so database and Redis credentials stay host-local by default.

If you choose to regenerate `JWT_SECRET` and `ANONYMOUS_SESSION_SECRET` is empty, setup copies the previous `JWT_SECRET` into `ANONYMOUS_SESSION_SECRET`. Students then stay linked to their answers in existing [anonymous sessions](../docs/developer/data-model.md#anonymous-sessions). Regenerating secrets signs everyone out; run `docker compose up -d` afterwards to apply the new `.env`.

---

## TLS Certificates

### How certificates reach nginx

At container start (and periodically afterwards, every `TLS_RELOAD_CHECK_SECONDS`, default 60 seconds), `nginx/tls-certs.sh` links the best available certificate pair into the paths nginx serves from:

1. **Let's Encrypt certificates** from the shared `certbot-conf` Docker volume — used when `CERTBOT_AUTORENEW=true`
2. **Operator-provided files** from `TLS_CERT_PATH`/`TLS_KEY_PATH` in `.env`
3. **A self-signed placeholder** generated on the fly, so nginx can always boot (e.g. before the first ACME issuance)

When the `certbot` container renews a certificate into the shared volume, the watcher in the nginx container detects the change and gracefully reloads nginx. Renewal is fully automatic — no copy steps, restarts, or cron jobs needed.

### Option 1: Let's Encrypt (Recommended)

```bash
# Run interactive setup and choose:
#   2) Generate a Let's Encrypt certificate now
./setup.sh

# If you skip this during setup, you can run it later:
./setup.sh --init-certs
```

This will:
1. Start Nginx (with a self-signed placeholder if no certificate exists yet) to handle the ACME challenge
2. Run Certbot to obtain the real certificate into the shared `certbot-conf` volume
3. Set `CERTBOT_AUTORENEW=true` in `.env` and recreate nginx so it serves the new certificate

From then on the `certbot` service checks for renewal every 12 hours and nginx picks up renewed certificates automatically.

### Option 2: Bring Your Own Certificate

During setup, choose:

```bash
1) I already have certificate files (Let's Encrypt or other)
```

If `./certs/fullchain.pem` and `./certs/privkey.pem` already exist, setup offers to use them automatically. Otherwise it prompts for certificate/key paths.
Keep `CERTBOT_AUTORENEW=false` for this option so nginx uses your files instead of the certbot volume; renewing/replacing the files is then your responsibility (nginx picks up in-place changes within `TLS_RELOAD_CHECK_SECONDS`).

You can also place files in `./certs/` manually:

```bash
# Copy certificates
mkdir -p certs
cp /path/to/fullchain.pem certs/fullchain.pem
cp /path/to/privkey.pem certs/privkey.pem

# Optional: point directly to host-level Let's Encrypt files in .env:
TLS_CERT_PATH=/etc/letsencrypt/live/yourdomain.com/fullchain.pem
TLS_KEY_PATH=/etc/letsencrypt/live/yourdomain.com/privkey.pem
```

### Option 3: Self-Signed (Testing Only)

During setup, choose:

```bash
3) Generate a self-signed certificate (testing only)
```

The script writes `./certs/fullchain.pem` and `./certs/privkey.pem`. **Do not use self-signed certificates in production.**

---

## Server Scaling

The number of API server replicas is controlled by `SERVER_REPLICAS` in `.env`:

```env
SERVER_REPLICAS=2
```

### Recommendations

| Concurrent Users | Recommended Replicas | Notes |
|-----------------|---------------------|-------|
| < 500 | 2 | Minimum for high availability |
| 500 – 1,000 | 3 | Good balance for most deployments |
| 1,000 – 2,000 | 4 | Each replica handles ~500 WebSocket connections |
| 2,000+ | 4+ | Scale horizontally; consider dedicated hardware |

**Note:** All replicas share the same MongoDB and Redis instances. Redis is required for multi-instance WebSocket synchronization — it ensures that live session events are broadcast to all connected clients regardless of which server replica they're connected to.

### MongoDB

A single MongoDB instance is sufficient for most Qlicker deployments (thousands of concurrent users). MongoDB 7's WiredTiger engine handles concurrent reads efficiently. The Docker Compose sets `--wiredTigerCacheSizeGB=1` by default; increase this if your server has more RAM:

```yaml
# In docker-compose.yml, under mongo service:
command: ["mongod", "--wiredTigerCacheSizeGB", "2"]
```

**When to add MongoDB replicas:** Only if you need high availability (automatic failover). For read scaling, a single MongoDB instance is typically sufficient because the application uses Redis for the most performance-critical real-time data path.

### Changing Replicas After Setup

```bash
# Edit .env
SERVER_REPLICAS=4

# Apply
docker compose up -d --scale server=4
```

---

## Initializing from Legacy Database

Use this flow when you are preparing the Fastify deployment to take over an existing Meteor-backed database.

Important operational rule: once you rewrite legacy image URLs to `/uploads/<key>`, that database copy is considered cut over to Fastify. The old Meteor app should no longer be treated as the active reader for that database because it does not serve the Fastify `/uploads/...` path.

### 1. Create a Dump of the Legacy Database

On the old server:
```bash
mongodump --uri='mongodb://host:port/qlicker' --out=/tmp/qlicker-dump
```

### 2. Transfer the Dump

```bash
# Copy the full mongodump output under production_setup/legacydb/
scp -r /tmp/qlicker-dump/qlicker user@server:/opt/qlicker/legacydb/qlicker
```

If your dump contains multiple database directories, copy the top-level dump folder instead and let the script choose the primary application database automatically.

### 3. Bring Up the Fastify Stack

```bash
docker compose up -d
```

### 4. Restore the Legacy Data

```bash
# Interactive restore + question-type migration
./init-from-legacy.sh
```

The script will:
1. Detect the dump directory in `./legacydb/`
2. Back up any existing data
3. Restore the legacy dump using `mongorestore --drop`
4. Run the question-type migration

### 5. Configure Storage in the Admin Panel

After the restore, sign in to the Fastify app as an admin and open **Admin -> Storage**.

For Amazon S3, enter:

1. bucket
2. region
3. access key ID
4. secret access key
5. optional endpoint
6. optional path-style toggle for S3-compatible services

Save the settings before running the sanitize step so the application knows how to read S3 objects through `/uploads/<key>`.

### 6. If You Are Keeping S3 Public for the Moment, Validate First

Before changing bucket privacy, confirm:

1. the Fastify app can log in against the restored database
2. a new image upload works from the profile page
3. a new image upload works from a rich-text editor

### 7. Run the S3 Sanitize Step When You Are Ready to Cut Over

If legacy image fields still contain direct public S3 URLs and you want Fastify to serve them from a private bucket, run:

```bash
./sanitize-s3.sh          # Dry run
./sanitize-s3.sh --apply  # Rewrite DB refs + attempt ACL privatization
```

Or, as a single maintenance-window command immediately after restore:

```bash
./init-from-legacy.sh --sanitize-s3
```

That option now runs the same sanitize workflow in apply mode after the database restore and question-type migration.

### 8. Final Validation Before Bucket Lockdown

After `sanitize-s3.sh --apply`, verify:

1. several old profile images load
2. several old question-editor images load inside question content
3. profile thumbnail regeneration still works
4. a brand new upload still works

---

## S3 Private-Bucket Migration

The legacy Meteor app stored direct public S3 URLs in MongoDB. Fastify now serves uploads through `/uploads/<key>` and reads the object from the configured storage backend. The cutover has two distinct parts:

1. rewrite the database references
2. remove public access from S3

Do not do part 2 first on the live bucket if Meteor is still serving traffic.

### S3-Side Preparation

Before the Fastify cutover window:

1. Identify the existing bucket name and region.
2. Create or confirm an IAM principal with `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` on `arn:aws:s3:::BUCKET/*`.
3. Keep any current public-read bucket policy or object-access path in place until Fastify has been validated against the restored DB.
4. Decide whether you want to keep ACLs enabled temporarily. If you move directly to Object Ownership `Bucket owner enforced`, the sanitize script will still rewrite MongoDB URLs, but the ACL pass will be reported as skipped because S3 no longer accepts ACL writes.

### Dry Run

```bash
./sanitize-s3.sh
```

### Apply

```bash
./sanitize-s3.sh --apply --verbose
```

### What It Does

1. Reads S3 settings from the database `Settings` document, with `AWS_*` env vars available as overrides
2. Scans `users`, `images`, and `questions`
3. Rewrites matching legacy public S3 URLs to `/uploads/<key>`
4. Backfills `images.key` if needed
5. Collects the referenced S3 object keys
6. In `--apply` mode, attempts `PutObjectAcl(..., ACL=private)` for each discovered key when credentials are available

### Admin-Panel Requirements

The sanitize step assumes **Admin -> Storage** already points Fastify at the correct S3 bucket. Specifically, confirm all of the following before you apply it:

1. storage type = `Amazon S3`
2. bucket matches the legacy bucket
3. region matches the bucket region
4. access key ID and secret access key are valid
5. endpoint/path-style are set correctly if you use MinIO or another S3-compatible service

### Bucket Lockdown After Validation

Once Fastify is rendering old and new images correctly:

1. remove any public bucket policy or public website access that made the old URLs readable
2. enable **Block Public Access** for the bucket
3. optionally switch Object Ownership to **Bucket owner enforced**

At that point, the objects can remain private while Fastify continues to serve them from `/uploads/<key>`.

---

## User Management

The `manage-user.sh` script provides CLI access to common user operations:

### Change Password

```bash
./manage-user.sh change-password --email user@example.com --password newSecure123

# Auto-generate a password
./manage-user.sh change-password --email user@example.com
```

### Create User

```bash
./manage-user.sh create \
  --email prof@university.edu \
  --firstname Jane \
  --lastname Smith \
  --role professor \
  --password securePass123

# Roles: student (default), professor, admin
```

### Promote User

```bash
./manage-user.sh promote --email user@example.com --role admin
```

### Toggle Local Email Login for One User

```bash
# Allow local email/password login for one SSO-managed account
./manage-user.sh set-email-login --email user@example.com --enable-email-login

# Remove that exception again
./manage-user.sh set-email-login --email user@example.com --disable-email-login
```

### List Users

```bash
./manage-user.sh list
```

---

## Backups

`backup.sh` and `restore.sh` work against the MongoDB data in this deployment.
They use the Docker volume mapping in `docker-compose.yml`:
- host: `${BACKUP_HOST_PATH}` (default `./backups/`)
- mongo container: `/backups/`
- the backup manager container also mounts the same directory to write live dumps
- both `backup.sh` and `backup-manager.sh` append operational logs to `${BACKUP_HOST_PATH}/qlicker_backup.log`

### How `backup.sh` Works

When you run `./backup.sh`, the script:
1. Loads `production_setup/.env` for Docker access and backup-manager runtime settings
2. Verifies the `mongo` container is running
3. Runs `mongodump` against the live database using the configured `MONGO_URI` into `/backups/qlicker_backup_<timestamp>_<label>`
4. Compresses that dump to `backups/qlicker_backup_<timestamp>_<label>.tar.gz`
5. Deletes the uncompressed dump directory
6. Prunes `.tar.gz` backups by label using the retention counts stored in Admin -> Backup
7. Appends run details and errors (including captured command output) to `backups/qlicker_backup.log`

### Create a Backup

```bash
./backup.sh
```

Creates a timestamped, compressed backup in `./backups/`:
```
backups/qlicker_backup_20260321_020000_daily.tar.gz
```

`./backups` remains the operator-friendly path in `production_setup/`. If `BACKUP_HOST_PATH` points elsewhere, `setup.sh` creates `./backups` as a symlink to that host directory.

Inspect backup log history:

```bash
tail -n 100 backups/qlicker_backup.log
```

### Store Backups on Another Disk

Set `BACKUP_HOST_PATH` in `.env` to an absolute host path on the target disk (for example `/data/qlicker2/backups`). Then recreate only the backup-writing services:

```bash
docker compose up -d --no-deps --force-recreate mongo backup-manager
```

This updates the bind mount without restarting `server`, `client`, or `nginx`.

Recommended migration sequence:

1. Create a manual backup before changing paths.
2. Copy existing `qlicker_backup_*.tar.gz` archives and `qlicker_backup.log` to the new path.
3. Set `BACKUP_HOST_PATH` in `.env`.
4. Recreate `mongo` and `backup-manager` as shown above.
5. Run `./backup.sh --label manual` and confirm the new archive lands under `BACKUP_HOST_PATH`.

### Backup Methods

Qlicker supports three primary backup trigger paths:

1. **Admin UI (manual):** **Admin -> Backup -> Backup now**
2. **Scheduled service:** `backup-manager` in `docker-compose.yml`
3. **Host command line:** run `./backup.sh` directly in `production_setup/`

For command-line runs, you can choose a label explicitly:

```bash
# default label is daily
./backup.sh

# explicit labels for one-off archival runs
./backup.sh --label manual
./backup.sh --label weekly
./backup.sh --label monthly
```

If the Backup tab shows a stuck `running` request while the manager is unhealthy, use
**Reset backup state** in the Backup tab after fixing the service health issue.

### Automatic Backups (Backup Manager Service)

The `backup-manager` service in `docker-compose.yml` checks the configured backup time once per minute, runs daily backups every day, weekly backups on Sundays, and monthly backups on the first day of the month. It updates latest run metadata in MongoDB so the Admin Dashboard can show current state and warnings.

`backup-manager` uses the same `MONGO_URI` value as the API server. If you override `MONGO_URI` in `.env`, recreate `backup-manager` and `server` so both point to the same database.

Use the Admin Dashboard's **Backup** tab to:

- enable or disable the scheduled backup job
- choose the local backup time
- change daily, weekly, and monthly retention counts
- request an immediate run with **Backup now**
- reset a stuck manual request with **Reset backup state**
- confirm manager heartbeat, run status, and archive filename
- jump directly to the recovery guidance from the UI

### Optional Cron Backups (Legacy Path)

Use this only if you intentionally want host cron to trigger backups outside the built-in backup-manager schedule.

Add to your server's crontab:

```bash
# Daily at 2 AM
0 2 * * * /opt/qlicker/production_setup/backup.sh --cron >> /var/log/qlicker-backup.log 2>&1
```

`--cron` keeps output quiet and only prints errors, which is better for cron logs.

### Backup Retention

Backup retention is configured in the Admin Dashboard's **Backup** tab. By default, Qlicker keeps:

- the latest backup for each of the last **7 days**
- the latest backup for each of the last **4 weeks**
- the latest backup for each of the last **12 months**

Archives are clearly labeled by tier:

```text
qlicker_backup_20260321_020000_daily.tar.gz
qlicker_backup_20260323_020000_weekly.tar.gz
qlicker_backup_20260401_020000_monthly.tar.gz
```

### How `restore.sh` Works

When you run `./restore.sh`, the script:
1. Loads `.env` and verifies the `mongo` container is running
2. Lets you choose a backup archive interactively (or accepts a file path argument)
3. Requires an explicit `yes` confirmation (or `--yes` for scripted maintenance)
4. Extracts the backup archive into a temporary host directory
5. Copies the dump into the MongoDB container
6. Runs `mongorestore` through the configured authenticated `MONGO_URI` to replace current data
7. Cleans up temporary files

### Restore from Backup

```bash
# Interactive — pick from available backups
./restore.sh

# Specific backup file
./restore.sh backups/qlicker_backup_20260321_020000_daily.tar.gz

# Non-interactive confirmation for scripted maintenance
./restore.sh --yes backups/qlicker_backup_20260321_020000_daily.tar.gz
```

⚠️ **Warning:** Restore will drop the current database. The script requires you to type `yes` to confirm.

### Complete Recovery Workflow

Use this sequence when recovering a deployment after host failure, data corruption, or an operator mistake:

1. Copy the `production_setup/` directory and your most recent `backups/qlicker_backup_*.tar.gz` archive onto the replacement host.
2. Run `./setup.sh` if the host is new so `.env`, TLS, and Docker settings exist again.
3. Start MongoDB and Redis if they are not already running:
   ```bash
   docker compose up -d mongo redis
   ```
4. Stop the public app containers so users are not writing new data during restore:
   ```bash
   docker compose stop nginx server client
   ```
5. Restore the selected archive:
   ```bash
   ./restore.sh backups/qlicker_backup_20260321_020000_daily.tar.gz
   ```
6. Start the full stack again:
   ```bash
   docker compose up -d
   ```
7. Verify recovery by checking `docker compose ps`, signing in as an admin, opening **Admin -> Backup**, and confirming recent courses, sessions, and user data look correct.

If you also rely on local uploaded files, restore the `uploads/` directory from the same recovery point before reopening the system to users.

### Shared Question Reference Repair

Run the diagnostic from this directory; Node.js runs inside Docker, so it is not needed on the host:

```bash
./repair-question-references.sh
```

It scans all courses and lists affected sessions by course/session name, with repeated question positions and response/grade counts. Diagnosis changes no data and needs no session ID.

After reviewing the list, back up the database and stop all app server replicas to use the interactive repair menu:

```bash
./backup.sh --label manual
docker compose stop nginx server client
./repair-question-references.sh --repair
./repair-question-references.sh
docker compose up -d server client nginx
```

The menu offers independent copies for unused sessions, or removal of accidental duplicate positions with a choice to keep historical grades or recalculate automatic grades while preserving manual overrides. Every change requires confirmation. Shared answer histories across sessions and ambiguous manual overrides require individual review. See the [diagnostic and repair guide](../docs/developer/question-reference-repair.md) for the full workflow, filters, and failure recovery. Use an updated server image containing the utility; no new environment variables are needed.

### Duplicate Grade Cleanup

The backend now blocks duplicate grade identities for the same `{ userId, courseId, sessionId }`, but older databases may still contain legacy duplicates. The maintenance script lives at the repo root.

```bash
# Dry run
node scripts/dedupe-grades.js --mongo-uri "$MONGO_URI"

# Apply deletions after reviewing the report
node scripts/dedupe-grades.js --apply --mongo-uri "$MONGO_URI"
```

Run it from a checkout of the same Qlicker revision that matches the deployment. Use `--skip-index` only if you intentionally do not want the script to recreate the unique grade index afterward.

---

## Updating

### Standard Update

```bash
./update.sh
```

This will:
1. Create a pre-update backup
2. Pull latest images (or rebuild if using local builds)
3. Restart services with zero downtime (rolling restart)
4. Run a health check

### Enabling MongoDB and Redis Authentication on an Existing Live Deployment

After copying this updated `production_setup/` directory onto a server that is already running Qlicker, use the dedicated migration script:

```bash
chmod +x *.sh
./enable-db-auth.sh
```

What the script does:

1. Creates a fresh `manual` MongoDB backup with `./backup.sh --label manual`
2. Stores safety copies of the current `.env` and `docker-compose.yml` under `backups/auth-migration-<timestamp>/`
3. Prompts for the built-in MongoDB admin username (default `qlickerAdmin`)
4. Reuses the existing MongoDB/Redis passwords if present, or generates strong new passwords with `openssl rand -hex 32`
5. Rewrites `.env` with:
   - `MONGO_INITDB_ROOT_USERNAME`
   - `MONGO_INITDB_ROOT_PASSWORD`
   - authenticated `MONGO_URI`
   - `REDIS_PASSWORD`
   - authenticated `REDIS_URL`
6. Stops the stack, removes the old `mongo-data` and `redis-data` Docker volumes, and starts fresh authenticated `mongo` + `redis` containers
7. Restores the backup into the new authenticated MongoDB volume
8. Starts the full application stack again

Recommended maintenance-window procedure:

1. Copy the updated `production_setup/` files to the server.
2. Review any local customizations in `.env` and `docker-compose.yml`.
3. Run `./enable-db-auth.sh`.
4. After it completes, confirm:
   ```bash
   docker compose ps
   docker compose logs --tail=100 mongo redis server
   curl -k https://your-domain.example/api/v1/health
   docker exec "$(docker compose ps -q redis | head -1)" redis-cli ping    # should fail with NOAUTH
   ```
5. Keep the generated backup archive and the `backups/auth-migration-<timestamp>/` directory until you are satisfied with the migration.

The bundled CSP allowlist covers Qlicker itself, the default Jitsi SaaS domains (`meet.jit.si`, `*.jit.si`), the current Jitsi inline bootstrap hash required by the hosted widget, and the built-in rich-text video embed providers. If you use a self-hosted Jitsi deployment or another external iframe/script source, extend `nginx/nginx.conf` before redeploying.

If the migration is interrupted, use the saved `.env` / `docker-compose.yml` snapshots plus the fresh backup archive noted by the script to recover manually.

### Force Rebuild from Source

```bash
./update.sh --build
```

### Skip Pre-Update Backup

```bash
./update.sh --no-backup
```

### Building Docker Images

From the repository root (where you have the source code):

```bash
# Build and tag
./scripts/build-images.sh --tag v2.0.0

# Build, tag, and push to a registry
./scripts/build-images.sh --tag v2.0.0 --registry ghcr.io/yourorg --push
```

`production_setup/docker-compose.yml` already uses pre-built images. You can override the default tags in `.env` and set the runtime release label:

```env
SERVER_IMAGE=ghcr.io/yourorg/qlicker-server:v2.0.0
CLIENT_IMAGE=ghcr.io/yourorg/qlicker-client:v2.0.0
APP_VERSION=vX.Y.Z
ENABLE_API_DOCS=false
```

---

## File Structure

```
production_setup/
├── docker-compose.yml      # Production Docker Compose orchestration
├── .env.example            # Environment variable template
├── .env                    # Your configuration (generated by setup.sh)
├── setup.sh                # Interactive setup wizard
├── enable-db-auth.sh       # Migrate a live deployment to authenticated MongoDB + Redis
├── init-from-legacy.sh     # Initialize from legacy MongoDB dump
├── sanitize-s3.js          # Self-contained DB rewrite + S3 ACL script
├── sanitize-s3.sh          # Host-side wrapper to run sanitize-s3.js in Docker
├── update.sh               # Pull/rebuild and restart
├── backup-manager.sh       # Scheduled-backup service loop and health reporting
├── backup.sh               # Create MongoDB backup
├── restore.sh              # Restore from backup
├── repair-question-references.sh # Named diagnostic and interactive repair (Docker)
├── manage-user.sh          # User management CLI
├── README.md               # This file
├── nginx/
│   ├── nginx.conf          # Nginx TLS + reverse proxy configuration
│   └── tls-certs.sh        # Certificate selection + auto-reload on renewal
├── certs/                  # Operator-provided/placeholder TLS certificates
│   ├── fullchain.pem
│   └── privkey.pem
├── backups/                # MongoDB backups (or symlink to BACKUP_HOST_PATH)
│   └── qlicker_backup_*.tar.gz
└── legacydb/               # Legacy database dumps (for init-from-legacy.sh)
    └── qlicker/            # mongodump output
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DOMAIN` | Yes | `qlicker.example.com` | Server domain name |
| `TLS_CERT_PATH` | Yes | `./certs/fullchain.pem` | Operator-provided TLS certificate path (fallback when Let's Encrypt is not used) |
| `TLS_KEY_PATH` | Yes | `./certs/privkey.pem` | Operator-provided TLS private key path |
| `CERTBOT_AUTORENEW` | No | `false` | If `true`, certbot renews Let's Encrypt certificates and nginx serves them directly from the shared volume |
| `TLS_RELOAD_CHECK_SECONDS` | No | `60` | How often nginx checks for a changed certificate and reloads |
| `SERVER_IMAGE` | No | `qlicker/qlicker-server:latest` | API server image reference |
| `CLIENT_IMAGE` | No | `qlicker/qlicker-client:latest` | Client image reference |
| `APP_VERSION` | No | repository `VERSION` during setup, otherwise `latest` | Release label baked into the application UI |
| `SERVER_REPLICAS` | No | `2` | Number of API server replicas |
| `JWT_SECRET` | Yes | — | JWT signing secret (32-byte hex) |
| `JWT_REFRESH_SECRET` | Yes | — | JWT refresh token secret (32-byte hex) |
| `ANONYMOUS_SESSION_SECRET` | No | `JWT_SECRET` | Key for anonymous-session pseudonyms. Set it to the old `JWT_SECRET` before rotating that secret, or students lose the link to their anonymous answers (see [anonymous sessions](../docs/developer/data-model.md#anonymous-sessions)) |
| `MONGO_INITDB_ROOT_USERNAME` | Yes (bundled mongo) | `qlickerAdmin` | Built-in MongoDB admin username |
| `MONGO_INITDB_ROOT_PASSWORD` | Yes (bundled mongo) | generated by `setup.sh` | Built-in MongoDB admin password |
| `MONGO_URI` | Yes | generated by `setup.sh` | MongoDB connection URI used by app, restore, and backup tooling |
| `MONGO_WIREDTIGER_CACHE_SIZE_GB` | No | `0.25` | MongoDB WiredTiger cache size in GB |
| `MONGO_MAX_POOL_SIZE` | No | `25` | Per-server MongoDB connection pool ceiling |
| `MONGO_MIN_POOL_SIZE` | No | `0` | Per-server MongoDB minimum pool size |
| `MONGO_SERVER_SELECTION_TIMEOUT_MS` | No | `10000` | MongoDB server selection timeout |
| `MONGO_SOCKET_TIMEOUT_MS` | No | `45000` | MongoDB socket timeout |
| `MONGO_CONNECT_RETRIES` | No | `6` | MongoDB connect retry attempts |
| `MONGO_CONNECT_RETRY_DELAY_MS` | No | `2000` | Base retry delay for MongoDB connects |
| `MAIL_URL` | Recommended | — | SMTP connection string |
| `REDIS_PASSWORD` | Yes (bundled redis) | generated by `setup.sh` | Built-in Redis password |
| `REDIS_URL` | Yes | generated by `setup.sh` | Redis connection URL |
| `API_PORT` | No | `3001` | Internal API port |
| `ENABLE_API_DOCS` | No | `false` in production | Enables the admin-protected Swagger/OpenAPI UI at `/docs`; leave disabled on internet-facing deployments unless required |
| `TRUST_PROXY` | No | `loopback,linklocal,uniquelocal` | Comma-separated IP/CIDR ranges for the reverse proxy connecting directly to Fastify; use `false` when exposing the API directly (numeric hop counts are unsupported) |
| `DISABLE_RATE_LIMITS` | No | `false` | Load testing only; `load-testing/run.sh --prepare` temporarily enables it and `--restore` returns it to its original setting. `setup.sh` warns when it is left `true` |
| `AI_BACKEND_ALLOW_PRIVATE_HOSTS` | No | `true` | Allow administrator-configured AI backends on private networks; set to `false` to enforce the hostname allowlist |
| `AI_BACKEND_ALLOWED_PRIVATE_HOSTS` | No | none | Comma-separated exact private-network AI backend hostnames used when `AI_BACKEND_ALLOW_PRIVATE_HOSTS=false` |
| `AI_BACKEND_REQUEST_TIMEOUT_MS` | No | `300000` | Initial/fallback AI provider timeout in milliseconds; after setup, administrators can change the global timeout in Admin → AI settings |
| `BACKUP_HOST_PATH` | No | `./backups` | Host path bind-mounted at `/backups` in `mongo` and `backup-manager` |
| `BACKUP_CHECK_INTERVAL_SECONDS` | No | `60` | Backup manager polling interval |
| `TZ` | No | `UTC` | Timezone used by the backup manager container |
| `NODE_ENV` | No | `production` | Server runtime mode; keep `production` for deployed stacks |
| `ROOT_URL` | Yes | `https://${DOMAIN}` | Public application origin used for links, CORS, and integration callbacks |

Storage backend selection and cloud credentials are **not** read from environment variables at runtime anymore. The app boots with local storage by default; after the first admin signs in, configure **Admin -> Storage** to keep using local storage or switch to S3/Azure. The database `Settings` document is the source of truth.

The one storage-related maintenance exception is [`sanitize-s3.js`](./sanitize-s3.js) / [`sanitize-s3.sh`](./sanitize-s3.sh): they resolve S3 settings from the database first and accept `AWS_*` variables as overrides when needed.

From the internet, the production stack exposes only Nginx on ports **80/443**. The API containers stay internal to the Docker network, and authenticated API calls are still enforced by the application itself with JWT bearer tokens, refresh cookies, CSRF header checks, CORS, and per-route Fastify rate limits. Direct browser calls to `/api/*` are therefore expected; the main hardening recommendation is to keep optional API documentation disabled unless administrators need it.

The bundled Nginx config intentionally does **not** place a blanket rate limit on all `/api` traffic. Qlicker is a browser SPA and normal navigation can produce short bursts of parallel authenticated API requests; broad edge throttling can therefore create false "server unavailable" failures for real users. Instead, the bundled edge rate limits target the abuse-prone public auth endpoints (`/api/v1/auth/login`, `/register`, `/forgot-password`, and `/reset-password`) while the application keeps per-route limits on sensitive server handlers.

---

## Monitoring & Logs

### In-app system monitoring

Open **Admin → Usage Statistics → System monitoring** for host CPU, RAM, inbound/outbound network rates, recent-user counts, peak periods, and collector events. See the [admin manual](../docs/user-manual/admin.md#usage-statistics) for metric definitions and investigation scenarios.

The bundled `system-monitor` service uses the same image as the API and runs **once per Linux Docker host**, independently of `SERVER_REPLICAS`. Deploy a server image containing `src/systemMonitor.js` and the updated Compose file together:

```bash
docker compose pull server system-monitor client
docker compose up -d server system-monitor client
docker compose logs --tail=50 system-monitor
```

No process outside Docker is required. Five individually mounted, read-only host `/proc` files provide CPU, memory, load, network counters, and default-route selection. Network mounts explicitly use `/proc/1/net/dev` and `/proc/1/net/route` on the host: plain `/proc/net` can resolve to the collector's network namespace. No Docker socket, shared host PID namespace, or privileged container is used. On Docker Desktop the metrics describe its Linux VM, not macOS/Windows. Restricted/rootless runtimes that refuse these mounts require a native Linux collector instead. This is a single-host dashboard: do not scale the collector or point collectors from different hosts at the same database.

The collector sleeps between samples (60 seconds by default), has a Mongo pool of two connections, and inserts one compact aggregate sample per cycle. At the default interval, seven days is about 10,080 documents; TTL indexes expire samples/events after seven days, with a periodic cleanup fallback. It never queries users, responses, or grades. Active-user tracking adds a non-awaited Redis heartbeat at most once per user per minute per API replica; pending writes and local tracking memory are bounded, and writes are dropped while Redis is unavailable. Counts deduplicate across replicas and tabs. Redis eviction/restarts can temporarily undercount active users until fresh requests arrive.

Compose caps the collector at **0.10 CPU**, **128 MiB RAM** with no extra swap, and 32 processes/threads. The root filesystem is read-only and the process runs as the unprivileged `node` user with all capabilities dropped. Its Docker logs rotate at two 5 MB files. Admin history reads are indexed, bounded, downsampled, and cached for 30 seconds; charts load on demand without background polling. These limits bound added work, but every monitoring system consumes some CPU, memory, and database I/O. Check the impact under your deployment's classroom load.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SYSTEM_MONITOR_SAMPLE_INTERVAL_SECONDS` | `60` | Collection interval, clamped to 30–300 seconds. Short bursts between samples may be missed. |
| `SYSTEM_MONITOR_ACTIVE_WINDOW_MINUTES` | `15` | Recent authenticated-request window, clamped to 5–120 minutes. This is not an exact signed-in-session count. |
| `SYSTEM_MONITOR_NETWORK_INTERFACES` | empty | Comma-separated host interfaces. Empty prefers non-tunnel default-route interfaces; if only tunnel defaults exist, selects the lowest-metric one. Without default routes, falls back to non-virtual interfaces (or loopback on a loopback-only host). Choose explicit names for unusual routing. |

Apply configuration changes with `docker compose up -d system-monitor`. History persists through restarts in MongoDB. A Redis failure omits activity counts while host metrics continue; the collector reconnects automatically. Collection failure/recovery events appear in the app when MongoDB is reachable. If MongoDB itself is unavailable, errors can only be written to container logs. An absent collector produces a missing/stale indication; it does not prevent teaching or quiz submission. Stop collection with `docker compose stop system-monitor`.

On hosts with VPNs, automatic selection avoids adding tunnel counters to the uplink carrying those packets. For custom-named tunnels, bonded links, or unusual routing, select the intended non-overlapping interface(s) explicitly with `SYSTEM_MONITOR_NETWORK_INTERFACES`. Explicit selections are deduplicated; if any requested interface is missing, network values are unavailable rather than silently switching to other traffic. Selecting both a tunnel and its underlying interface explicitly can still double-count traffic. The admin card displays the latest sample's `network.interfaces`, and rates use binary byte units (KiB/s, MiB/s), not bits or link-utilization percentages. Rates use monotonic elapsed time so wall-clock adjustments do not inflate them.

Memory is whole-host `MemTotal - MemAvailable`, not Qlicker-only memory or simply `MemTotal - MemFree`; the UI shows the absolute amounts as well as the percentage. CPU is normalized across all host cores and excludes idle/I/O-wait time. Native desktop applications and unrelated containers also contribute to host usage. Sampling remains once per minute by default with no new process scanning or polling.

After updating collector code or interface configuration, restart the collector (`docker compose up -d --force-recreate system-monitor` for Docker, or `./scripts/qlicker.sh restart` for the native stack). Check the next sample's timestamp and interface names. Historical samples are retained unchanged until their seven-day expiry; old network samples collected by summing a VPN and uplink cannot be corrected from aggregate counters alone.

For native Linux development, `./scripts/qlicker.sh start` automatically starts the same collector, reads the root `.env`, and manages it with `status`, `stop`, and `restart`. Shutdown stops the collector before Redis/MongoDB so it can persist its final event. The helper prevents duplicate collector starts, recognizes its own orphaned collector if the main PID file is lost, and skips stale PIDs that belong to unrelated processes. Collector failure does not prevent the app from running.

Native helper options are `SYSTEM_MONITOR_ENABLED=false` to opt out and `SYSTEM_MONITOR_LOG_PATH` to override `.data/system-monitor.log`. It uses a 64 MiB V8 old-space limit and lower scheduling priority (`nice 10` where available), not Docker's hard CPU/total-memory limits. Logs over 5 MiB rotate to a single `.1` file on startup; use logrotate for long-running native installations.

When starting the app manually instead of through `qlicker.sh`, run the collector separately with `MONGO_URI` and optionally `REDIS_URL` set to the application's database/services:

```bash
npm run monitor --prefix server
```

It defaults to `/proc`; `SYSTEM_MONITOR_PROC_PATH` can override that path, and `SYSTEM_MONITOR_COLLECTOR_ID` can supply a readable host label. Export environment variables before invoking `npm run monitor` directly; that entry point does not automatically load `.env`. Apply hard resource limits through your native supervisor if required. The collector creates indexes only on its two new collections; no legacy-data migration is needed.

### Log access boundaries

The in-app **Monitor events** table contains collector lifecycle, collection errors, and activity-tracking availability events, retained seven days and limited to the latest 50. Full Docker, API, MongoDB, and host logs remain accessible through the operator commands below. Importing arbitrary service logs or exposing Docker-control access is outside this collector's scope. Do not mount `/var/run/docker.sock` into Qlicker to provide log access.

### View Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f server
docker compose logs -f nginx
docker compose logs -f mongo
docker compose logs -f system-monitor
```

### Health Check

```bash
curl -k https://your-domain.com/api/v1/health
```

Returns:
```json
{
  "status": "ok",
  "timestamp": "2026-03-21T...",
  "websocket": true,
  "redis": true
}
```

### Service Status

```bash
docker compose ps
```

### Resource Usage

```bash
docker stats
```

---

## Troubleshooting

### Services won't start

```bash
# Check Docker Compose config is valid
docker compose config

# Check specific service logs
docker compose logs server
docker compose logs nginx
```

### Certificate errors

Ensure your domain's DNS A record points to the server. Check Certbot logs:
```bash
docker compose logs certbot
```

To see which certificate nginx selected and whether renewals are being picked up, check for `[tls-certs]` lines in the nginx logs:
```bash
docker compose logs nginx | grep tls-certs
```

If the site serves a stale or self-signed certificate with Let's Encrypt in use, verify `CERTBOT_AUTORENEW=true` in `.env` and that the certificate exists in the shared volume:
```bash
docker compose run --rm --entrypoint sh certbot -c "ls -l /etc/letsencrypt/live"
```

### WebSocket connection failures

If WebSocket connections fail behind a corporate firewall or CDN, ensure:
1. Your load balancer/CDN supports WebSocket upgrade
2. The connection timeout is at least 60 seconds
3. Check Nginx logs: `docker compose logs nginx`

### Database connection errors

```bash
# Check MongoDB is running and healthy
docker compose ps mongo
docker compose logs mongo

# Test connection from server container
docker exec $(docker compose ps -q server | head -1) \
  node -e "import('mongoose').then(m => m.default.connect(process.env.MONGO_URI).then(() => { console.log('OK'); process.exit(0); }))"
```

### Out of disk space

Check backup directory size and prune old backups:
```bash
set -a; . ./.env; set +a
du -sh "${BACKUP_HOST_PATH:-./backups}/"
# Reduce retention or manually remove old backups
rm "${BACKUP_HOST_PATH:-./backups}"/qlicker_backup_2026*.tar.gz
```

### Performance tuning

For high-traffic deployments:

1. **Increase server replicas** in `.env`
2. **Tune MongoDB cache** with `MONGO_WIREDTIGER_CACHE_SIZE_GB`
3. **Keep Mongo connection pools conservative** with `MONGO_MAX_POOL_SIZE`
4. **Increase Redis memory**: edit `docker-compose.yml` → `maxmemory`
5. **Enable swap** on the host to handle memory spikes
6. **Use an SSD** for MongoDB data volume

## Load tests on production-style deployments

A staging copy and the production server use this same Compose file and Docker
image workflow. Configure `load-testing/setup.sh` with `prod` and `docker` on
each host. The runner exercises named and anonymous quiz/live scenarios with
the host's own `production_setup/.env`, then restores the original rate-limit
setting. See [the load-testing guide](../load-testing/README.md#identical-staging-and-production-runs)
for the prepare, run, restore, and cleanup sequence.

## Original classroom regression check

For the routine same-host check after anonymous/shared activity changes, run
`../load-testing/run.sh --regression --students 500` from this directory, with
`load-testing/.env` configured for `prod` and `docker`. It runs one original-style
classroom session (chat on, statistics shown after answering closes), checks all
answers/results/grades, and restores rate limits and cleans fixtures automatically.
Allow about five minutes plus setup/cleanup. No `.env` edits, application image
rebuild, or separate load-generator machine are needed. See the
[classroom regression guide](../load-testing/README.md#classroom-regression-check).

## Focused ordinary-session load test

With `load-testing/.env` configured for `prod` and `docker`, run
`../load-testing/run.sh --ordinary --students 500` from this directory. This checks
ordinary sessions with statistics hidden/visible during answering, using the deployed
images and public proxy path, and automatically prepares, restores rate limits, and
cleans up. It takes roughly 11 minutes plus setup/cleanup with default timings.
Use `--live-stats on` to investigate only the statistics-visible case. No manual
`.env` edits are required. See the [focused comparison guide](../load-testing/README.md#focused-ordinary-session-performance-check)
for artifacts, diagnostics, and baseline-versus-feature comparisons.

## Production-equivalent load-test matrix

With `load-testing/.env` configured for `prod` and `docker`, run
`../load-testing/run.sh --matrix` from this directory. It runs both live-statistics
modes, records container utilization, restores rate limits, and cleans its fixtures.
See the [matrix instructions](../load-testing/README.md#compare-shared-interactive-latency).
The deployment `.env` rate-limit setting is temporarily changed and restored;
load-test settings do not need editing.

Preparation/recovery restarts Nginx, which regenerates its configuration from
`nginx/nginx.conf`. Keep deployment-specific front-proxy settings in that persistent
template, not only in the rendered container file. A proxy sending PROXY protocol
requires matching HTTPS listeners and a `real_ip_header proxy_protocol` setting,
with `set_real_ip_from` restricted to the verified proxy source address. Preserve
loopback-only backend port bindings when using a host-level front proxy.
