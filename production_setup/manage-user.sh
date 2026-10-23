#!/usr/bin/env bash
# =============================================================================
# Qlicker Production — User Management Script
# =============================================================================
# Manage users from the command line. Runs inside the Docker server container
# so all server dependencies (Mongoose, Argon2) are available.
#
# Usage:
#   ./manage-user.sh change-password --email user@example.com [--password newpwd]
#   ./manage-user.sh create --email user@example.com --firstname John --lastname Doe [--role student|professor|admin] [--password pass123]
#   ./manage-user.sh promote --email user@example.com --role professor|admin
#   ./manage-user.sh set-email-login --email user@example.com --allow-email-login true|false
#   ./manage-user.sh list
#   ./manage-user.sh --help
if [ -z "${BASH_VERSION:-}" ]; then
  echo "[ERROR] This script requires bash. Run with: bash ./manage-user.sh ..." >&2
  exit 1
fi
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
MIN_PASSWORD_LENGTH=8

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { printf "${GREEN}[INFO]${NC}  %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
error() { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; }

usage() {
  cat <<'EOF'
Qlicker User Management

Commands:
  change-password  Change a user's password
  create           Create a new user account
  promote          Change a user's role
  set-email-login  Enable or disable local email login for one account
  list             List all users (email, name, role)

Options:
  --email EMAIL        User email (required for change-password, create, promote)
  --password PASS      New password (min 8 chars; auto-generated if omitted for create/change-password)
  --firstname NAME     First name (required for create)
  --lastname NAME      Last name (required for create)
  --role ROLE          Role: student, professor, or admin (default: student)
  --allow-email-login true|false  Explicitly allow or block email login
  --enable-email-login           Shortcut for --allow-email-login true
  --disable-email-login          Shortcut for --allow-email-login false

Examples:
  ./manage-user.sh change-password --email admin@example.com --password newSecure123
  ./manage-user.sh create --email prof@university.edu --firstname Jane --lastname Smith --role professor
  ./manage-user.sh promote --email user@example.com --role admin
  ./manage-user.sh set-email-login --email sso.user@example.com --disable-email-login
  ./manage-user.sh list
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    error "Missing required command: $1"
    exit 1
  fi
}

validate_email() {
  local email="$1"
  [[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}

validate_role() {
  case "$1" in
    student|professor|admin) return 0 ;;
    *) return 1 ;;
  esac
}

generate_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 18 | tr -d '\n'
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(18))
PY
    return 0
  fi
  if [ -r /dev/urandom ]; then
    local generated=""
    set +o pipefail
    generated="$(LC_ALL=C tr -dc 'A-Za-z0-9@#%^+=:.,_-' < /dev/urandom | head -c 24 || true)"
    set -o pipefail
    if [ -n "$generated" ]; then
      printf '%s' "$generated"
      return 0
    fi
  fi
  return 1
}

run_in_container() {
  local js_code="$1"
  shift
  ensure_server_container
  docker exec "$@" "$SERVER_CONTAINER" node --input-type=module -e "$js_code"
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] || [ $# -eq 0 ]; then
  usage
  exit 0
fi

require_command docker
if ! docker compose version >/dev/null 2>&1; then
  error "'docker compose' is required"
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  error "Compose file not found: $COMPOSE_FILE"
  exit 1
fi

# Load .env
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; . "$SCRIPT_DIR/.env"; set +a
fi

SERVER_CONTAINER=""
ensure_server_container() {
  if [ -n "$SERVER_CONTAINER" ]; then
    return 0
  fi
  SERVER_CONTAINER="$(docker compose -f "$COMPOSE_FILE" ps -q server 2>/dev/null | head -1 || true)"
  if [ -z "$SERVER_CONTAINER" ]; then
    error "Server container is not running. Start with: docker compose up -d"
    exit 1
  fi
}

COMMAND="$1"
shift

# Parse remaining arguments
EMAIL=""
PASSWORD=""
FIRSTNAME=""
LASTNAME=""
ROLE="student"
ALLOW_EMAIL_LOGIN=""
EMAIL_SET=false
PASSWORD_SET=false
FIRSTNAME_SET=false
LASTNAME_SET=false
ROLE_SET=false
ALLOW_EMAIL_LOGIN_SET=false

while [ $# -gt 0 ]; do
  case "$1" in
    --email)
      if [ $# -lt 2 ] || [[ "$2" == --* ]]; then
        error "Missing value for --email"
        exit 1
      fi
      EMAIL="$2"
      EMAIL_SET=true
      shift 2
      ;;
    --password)
      if [ $# -lt 2 ] || [[ "$2" == --* ]]; then
        error "Missing value for --password"
        exit 1
      fi
      PASSWORD="$2"
      PASSWORD_SET=true
      shift 2
      ;;
    --firstname)
      if [ $# -lt 2 ] || [[ "$2" == --* ]]; then
        error "Missing value for --firstname"
        exit 1
      fi
      FIRSTNAME="$2"
      FIRSTNAME_SET=true
      shift 2
      ;;
    --lastname)
      if [ $# -lt 2 ] || [[ "$2" == --* ]]; then
        error "Missing value for --lastname"
        exit 1
      fi
      LASTNAME="$2"
      LASTNAME_SET=true
      shift 2
      ;;
    --role)
      if [ $# -lt 2 ] || [[ "$2" == --* ]]; then
        error "Missing value for --role"
        exit 1
      fi
      ROLE="$2"
      ROLE_SET=true
      shift 2
      ;;
    --allow-email-login)
      if [ $# -lt 2 ] || [[ "$2" == --* ]]; then
        error "Missing value for --allow-email-login"
        exit 1
      fi
      case "$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')" in
        true|false)
          ALLOW_EMAIL_LOGIN="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
          ALLOW_EMAIL_LOGIN_SET=true
          ;;
        *)
          error "--allow-email-login must be true or false"
          exit 1
          ;;
      esac
      shift 2
      ;;
    --enable-email-login)
      ALLOW_EMAIL_LOGIN="true"
      ALLOW_EMAIL_LOGIN_SET=true
      shift
      ;;
    --disable-email-login)
      ALLOW_EMAIL_LOGIN="false"
      ALLOW_EMAIL_LOGIN_SET=true
      shift
      ;;
    *) error "Unknown argument: $1"; usage; exit 1 ;;
  esac
done

case "$COMMAND" in
  change-password)
    if [ "$EMAIL_SET" = false ]; then
      error "--email is required"; exit 1
    fi
    if ! validate_email "$EMAIL"; then
      error "Invalid email format: $EMAIL"; exit 1
    fi
    if [ "$FIRSTNAME_SET" = true ] || [ "$LASTNAME_SET" = true ] || [ "$ROLE_SET" = true ] || [ "$ALLOW_EMAIL_LOGIN_SET" = true ]; then
      error "change-password only accepts --email and optional --password"
      exit 1
    fi
    if [ "$PASSWORD_SET" = false ]; then
      if ! PASSWORD="$(generate_password)"; then
        error "Could not generate password automatically (openssl/python3 unavailable)."
        exit 1
      fi
      info "Generated password: $PASSWORD"
    fi
    if [ "${#PASSWORD}" -lt "$MIN_PASSWORD_LENGTH" ]; then
      error "Password must be at least $MIN_PASSWORD_LENGTH characters."; exit 1
    fi

    run_in_container "
      import mongoose from 'mongoose';
      import { hash, Algorithm, Version } from '@node-rs/argon2';
      const uri = process.env.MONGO_URI || 'mongodb://mongo:27017/qlicker';
      const email = String(process.env.MANAGE_USER_EMAIL || '').toLowerCase().trim();
      const password = String(process.env.MANAGE_USER_PASSWORD || '');
      const escapeRegex = (value) => value.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
      const connectWithRetry = async () => {
        let lastError = null;
        for (let attempt = 1; attempt <= 6; attempt += 1) {
          try {
            if (mongoose.connection.readyState !== 0) {
              await mongoose.disconnect().catch(() => {});
            }
            await mongoose.connect(uri, {
              autoIndex: false,
              maxPoolSize: 4,
              minPoolSize: 0,
              serverSelectionTimeoutMS: 10000,
              socketTimeoutMS: 45000,
            });
            return;
          } catch (error) {
            lastError = error;
            if (attempt >= 6) break;
            const delayMs = Math.min(2000 * attempt, 10000);
            console.warn('Mongo connection attempt ' + attempt + '/6 failed: ' + (error?.message || error) + '. Retrying in ' + delayMs + 'ms ...');
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
        throw lastError;
      };
      await connectWithRetry();
      try {
        const col = mongoose.connection.collection('users');
        const user = await col.findOne({ 'emails.address': new RegExp('^' + escapeRegex(email) + '\$', 'i') });
        if (!user) {
          console.error('User not found: ' + email);
          process.exit(1);
        }
        const hashed = await hash(password, { algorithm: Algorithm.Argon2id, version: Version.V0x13, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 });
        await col.updateOne(
          { _id: user._id },
          { \$set: { 'services.password.hash': hashed }, \$unset: { 'services.password.bcrypt': '', 'services.resetPassword': '' } }
        );
        console.log('Password updated for ' + email);
      } finally {
        await mongoose.disconnect();
      }
    " \
    -e MANAGE_USER_EMAIL="$EMAIL" \
    -e MANAGE_USER_PASSWORD="$PASSWORD"
    ;;

  create)
    if [ "$EMAIL_SET" = false ] || [ "$FIRSTNAME_SET" = false ] || [ "$LASTNAME_SET" = false ]; then
      error "--email, --firstname, and --lastname are required"; exit 1
    fi
    if ! validate_email "$EMAIL"; then
      error "Invalid email format: $EMAIL"; exit 1
    fi
    if ! validate_role "$ROLE"; then
      error "Role must be student, professor, or admin"; exit 1
    fi
    if [ "$PASSWORD_SET" = false ]; then
      if ! PASSWORD="$(generate_password)"; then
        error "Could not generate password automatically (openssl/python3 unavailable)."
        exit 1
      fi
      info "Generated password: $PASSWORD"
    fi
    if [ "${#PASSWORD}" -lt "$MIN_PASSWORD_LENGTH" ]; then
      error "Password must be at least $MIN_PASSWORD_LENGTH characters."; exit 1
    fi

    run_in_container "
      import mongoose from 'mongoose';
      import crypto from 'crypto';
      import { hash, Algorithm, Version } from '@node-rs/argon2';
      const uri = process.env.MONGO_URI || 'mongodb://mongo:27017/qlicker';
      const email = String(process.env.MANAGE_USER_EMAIL || '').toLowerCase().trim();
      const password = String(process.env.MANAGE_USER_PASSWORD || '');
      const firstname = String(process.env.MANAGE_USER_FIRSTNAME || '').trim();
      const lastname = String(process.env.MANAGE_USER_LASTNAME || '').trim();
      const role = String(process.env.MANAGE_USER_ROLE || 'student');
      const escapeRegex = (value) => value.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
      const connectWithRetry = async () => {
        let lastError = null;
        for (let attempt = 1; attempt <= 6; attempt += 1) {
          try {
            if (mongoose.connection.readyState !== 0) {
              await mongoose.disconnect().catch(() => {});
            }
            await mongoose.connect(uri, {
              autoIndex: false,
              maxPoolSize: 4,
              minPoolSize: 0,
              serverSelectionTimeoutMS: 10000,
              socketTimeoutMS: 45000,
            });
            return;
          } catch (error) {
            lastError = error;
            if (attempt >= 6) break;
            const delayMs = Math.min(2000 * attempt, 10000);
            console.warn('Mongo connection attempt ' + attempt + '/6 failed: ' + (error?.message || error) + '. Retrying in ' + delayMs + 'ms ...');
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
        throw lastError;
      };
      await connectWithRetry();
      try {
        const col = mongoose.connection.collection('users');
        const existing = await col.findOne({ 'emails.address': new RegExp('^' + escapeRegex(email) + '\$', 'i') });
        if (existing) {
          console.error('User already exists: ' + email);
          process.exit(1);
        }
        const chars = '23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz';
        let id = '';
        const bytes = crypto.randomBytes(17);
        for (let i = 0; i < 17; i += 1) id += chars[bytes[i] % chars.length];
        const hashed = await hash(password, { algorithm: Algorithm.Argon2id, version: Version.V0x13, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 });
        await col.insertOne({
          _id: id,
          emails: [{ address: email, verified: true }],
          services: {
            password: { hash: hashed },
            resume: { loginTokens: [] },
            email: { verificationTokens: [] }
          },
          profile: {
            firstname,
            lastname,
            roles: [role],
            courses: [],
            studentNumber: '',
            profileImage: '',
            profileThumbnail: '',
            canPromote: false
          },
          createdAt: new Date()
        });
        console.log('Created user: ' + email + ' (role: ' + role + ')');
      } finally {
        await mongoose.disconnect();
      }
    " \
    -e MANAGE_USER_EMAIL="$EMAIL" \
    -e MANAGE_USER_PASSWORD="$PASSWORD" \
    -e MANAGE_USER_FIRSTNAME="$FIRSTNAME" \
    -e MANAGE_USER_LASTNAME="$LASTNAME" \
    -e MANAGE_USER_ROLE="$ROLE"
    ;;

  promote)
    if [ "$EMAIL_SET" = false ]; then
      error "--email is required"; exit 1
    fi
    if [ "$ROLE_SET" = false ]; then
      error "--role is required for promote"
      exit 1
    fi
    if ! validate_email "$EMAIL"; then
      error "Invalid email format: $EMAIL"; exit 1
    fi
    if ! validate_role "$ROLE"; then
      error "Role must be student, professor, or admin"; exit 1
    fi
    if [ "$PASSWORD_SET" = true ] || [ "$FIRSTNAME_SET" = true ] || [ "$LASTNAME_SET" = true ] || [ "$ALLOW_EMAIL_LOGIN_SET" = true ]; then
      error "promote only accepts --email and --role"
      exit 1
    fi

    run_in_container "
      import mongoose from 'mongoose';
      const uri = process.env.MONGO_URI || 'mongodb://mongo:27017/qlicker';
      const email = String(process.env.MANAGE_USER_EMAIL || '').toLowerCase().trim();
      const role = String(process.env.MANAGE_USER_ROLE || '');
      const escapeRegex = (value) => value.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
      const connectWithRetry = async () => {
        let lastError = null;
        for (let attempt = 1; attempt <= 6; attempt += 1) {
          try {
            if (mongoose.connection.readyState !== 0) {
              await mongoose.disconnect().catch(() => {});
            }
            await mongoose.connect(uri, {
              autoIndex: false,
              maxPoolSize: 4,
              minPoolSize: 0,
              serverSelectionTimeoutMS: 10000,
              socketTimeoutMS: 45000,
            });
            return;
          } catch (error) {
            lastError = error;
            if (attempt >= 6) break;
            const delayMs = Math.min(2000 * attempt, 10000);
            console.warn('Mongo connection attempt ' + attempt + '/6 failed: ' + (error?.message || error) + '. Retrying in ' + delayMs + 'ms ...');
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
        throw lastError;
      };
      await connectWithRetry();
      try {
        const col = mongoose.connection.collection('users');
        const user = await col.findOne({ 'emails.address': new RegExp('^' + escapeRegex(email) + '\$', 'i') });
        if (!user) {
          console.error('User not found: ' + email);
          process.exit(1);
        }
        await col.updateOne({ _id: user._id }, { \$set: { 'profile.roles': [role] } });
        console.log('Updated ' + email + ' role to: ' + role);
      } finally {
        await mongoose.disconnect();
      }
    " \
    -e MANAGE_USER_EMAIL="$EMAIL" \
    -e MANAGE_USER_ROLE="$ROLE"
    ;;

  set-email-login)
    if [ "$EMAIL_SET" = false ]; then
      error "--email is required"; exit 1
    fi
    if [ "$ALLOW_EMAIL_LOGIN_SET" = false ]; then
      error "--allow-email-login, --enable-email-login, or --disable-email-login is required"
      exit 1
    fi
    if ! validate_email "$EMAIL"; then
      error "Invalid email format: $EMAIL"; exit 1
    fi
    if [ "$PASSWORD_SET" = true ] || [ "$FIRSTNAME_SET" = true ] || [ "$LASTNAME_SET" = true ] || [ "$ROLE_SET" = true ]; then
      error "set-email-login only accepts --email and an email-login flag"
      exit 1
    fi

    run_in_container "
      import mongoose from 'mongoose';
      const uri = process.env.MONGO_URI || 'mongodb://mongo:27017/qlicker';
      const email = String(process.env.MANAGE_USER_EMAIL || '').toLowerCase().trim();
      const allowEmailLogin = String(process.env.MANAGE_USER_ALLOW_EMAIL_LOGIN || '').toLowerCase() === 'true';
      const escapeRegex = (value) => value.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
      const connectWithRetry = async () => {
        let lastError = null;
        for (let attempt = 1; attempt <= 6; attempt += 1) {
          try {
            if (mongoose.connection.readyState !== 0) {
              await mongoose.disconnect().catch(() => {});
            }
            await mongoose.connect(uri, {
              autoIndex: false,
              maxPoolSize: 4,
              minPoolSize: 0,
              serverSelectionTimeoutMS: 10000,
              socketTimeoutMS: 45000,
            });
            return;
          } catch (error) {
            lastError = error;
            if (attempt >= 6) break;
            const delayMs = Math.min(2000 * attempt, 10000);
            console.warn('Mongo connection attempt ' + attempt + '/6 failed: ' + (error?.message || error) + '. Retrying in ' + delayMs + 'ms ...');
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
        throw lastError;
      };
      await connectWithRetry();
      try {
        const col = mongoose.connection.collection('users');
        const user = await col.findOne({ 'emails.address': new RegExp('^' + escapeRegex(email) + '\$', 'i') });
        if (!user) {
          console.error('User not found: ' + email);
          process.exit(1);
        }
        const isAdmin = Array.isArray(user.profile?.roles) && user.profile.roles.includes('admin');
        const nextAllowEmailLogin = isAdmin ? true : allowEmailLogin;
        const update = { \$set: { allowEmailLogin: nextAllowEmailLogin } };
        if (!nextAllowEmailLogin || isAdmin) {
          update.\$unset = { 'services.resetPassword': '' };
        }
        await col.updateOne({ _id: user._id }, update);
        console.log('Updated allowEmailLogin for ' + email + ': ' + nextAllowEmailLogin);
      } finally {
        await mongoose.disconnect();
      }
    " \
    -e MANAGE_USER_EMAIL="$EMAIL" \
    -e MANAGE_USER_ALLOW_EMAIL_LOGIN="$ALLOW_EMAIL_LOGIN"
    ;;

  list)
    if [ "$EMAIL_SET" = true ] || [ "$PASSWORD_SET" = true ] || [ "$FIRSTNAME_SET" = true ] || [ "$LASTNAME_SET" = true ] || [ "$ROLE_SET" = true ] || [ "$ALLOW_EMAIL_LOGIN_SET" = true ]; then
      error "list does not accept options"
      exit 1
    fi
    run_in_container "
      import mongoose from 'mongoose';
      const uri = process.env.MONGO_URI || 'mongodb://mongo:27017/qlicker';
      const connectWithRetry = async () => {
        let lastError = null;
        for (let attempt = 1; attempt <= 6; attempt += 1) {
          try {
            if (mongoose.connection.readyState !== 0) {
              await mongoose.disconnect().catch(() => {});
            }
            await mongoose.connect(uri, {
              autoIndex: false,
              maxPoolSize: 4,
              minPoolSize: 0,
              serverSelectionTimeoutMS: 10000,
              socketTimeoutMS: 45000,
            });
            return;
          } catch (error) {
            lastError = error;
            if (attempt >= 6) break;
            const delayMs = Math.min(2000 * attempt, 10000);
            console.warn('Mongo connection attempt ' + attempt + '/6 failed: ' + (error?.message || error) + '. Retrying in ' + delayMs + 'ms ...');
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
        throw lastError;
      };
      await connectWithRetry();
      try {
        const users = await mongoose.connection
          .collection('users')
          .find({}, { projection: { 'emails.address': 1, 'profile.firstname': 1, 'profile.lastname': 1, 'profile.roles': 1 } })
          .sort({ 'emails.0.address': 1 })
          .toArray();
        console.log('Email | Name | Roles');
        console.log('------|------|------');
        for (const u of users) {
          const email = u.emails?.[0]?.address || 'N/A';
          const name = ((u.profile?.firstname || '') + ' ' + (u.profile?.lastname || '')).trim();
          const roles = (u.profile?.roles || []).join(', ');
          console.log(email + ' | ' + (name || 'N/A') + ' | ' + (roles || 'N/A'));
        }
        console.log('\\nTotal: ' + users.length + ' users');
      } finally {
        await mongoose.disconnect();
      }
    "
    ;;

  *)
    error "Unknown command: $COMMAND"
    usage
    exit 1
    ;;
esac
