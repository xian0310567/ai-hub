#!/bin/sh
set -e

# ── 설정 ──────────────────────────────────────────────────────────────
PGDATA="/data/pgdata"
PG_USER="${POSTGRES_USER:-aihub}"
PG_DB="${POSTGRES_DB:-aihub}"
PG_PASS="${POSTGRES_PASSWORD:-aihub}"

# ── PostgreSQL 초기화 (첫 실행 시) ─────────────────────────────────────
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "[fly] PostgreSQL 초기화 중..."
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  su postgres -c "initdb -D $PGDATA --encoding=UTF8 --locale=C"

  # 로컬 전용 접근 설정
  cat > "$PGDATA/pg_hba.conf" << 'PGEOF'
local   all   all                 trust
host    all   all   127.0.0.1/32  md5
PGEOF

  # PostgreSQL 설정 튜닝
  cat >> "$PGDATA/postgresql.conf" << 'PGCONF'
listen_addresses = '127.0.0.1'
shared_buffers = 128MB
max_connections = 100
work_mem = 4MB
wal_level = minimal
max_wal_senders = 0
PGCONF

  # 임시 시작 → 유저/DB 생성
  su postgres -c "pg_ctl start -D $PGDATA -l /tmp/pg-init.log -w"
  su postgres -c "psql -c \"CREATE USER $PG_USER WITH PASSWORD '$PG_PASS';\""
  su postgres -c "psql -c \"CREATE DATABASE $PG_DB OWNER $PG_USER;\""
  su postgres -c "pg_ctl stop -D $PGDATA -m fast -w"

  echo "[fly] PostgreSQL 초기화 완료"
fi

# ── 데이터 디렉토리 확보 ──────────────────────────────────────────────
mkdir -p /data/backups /data/openclaw-runtime
chown postgres:postgres "$PGDATA"

# ── PostgreSQL 시작 ──────────────────────────────────────────────────
echo "[fly] PostgreSQL 시작..."
su postgres -c "pg_ctl start -D $PGDATA -l /data/pg.log -w"
echo "[fly] PostgreSQL 준비 완료"

# ── 환경변수 설정 ─────────────────────────────────────────────────────
export DATABASE_URL="${DATABASE_URL:-postgres://$PG_USER:$PG_PASS@127.0.0.1:5432/$PG_DB}"
export DATA_DIR="/data"

# ── 종료 핸들러 ──────────────────────────────────────────────────────
cleanup() {
  echo "[fly] 종료 중..."
  kill "$NODE_PID" 2>/dev/null || true
  wait "$NODE_PID" 2>/dev/null || true
  su postgres -c "pg_ctl stop -D $PGDATA -m fast -w"
  exit 0
}
trap cleanup SIGTERM SIGINT

# ── Node.js 앱 시작 ──────────────────────────────────────────────────
echo "[fly] vm-server 시작..."
node dist/index.js &
NODE_PID=$!
wait "$NODE_PID"
