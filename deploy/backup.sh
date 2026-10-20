#!/usr/bin/env bash
# Nightly context-hub backup.
#
# context-hub keeps everything in one SQLite file inside a Docker volume: the
# uploaded conversations, their digests, the project state pages and the access
# tokens (hashed). Conversations can be uploaded again from each computer, and digests
# can be regenerated at a cost, so a lost volume is recoverable but slow and not
# free. This script makes it a restore instead.
#
# The copy is taken with SQLite's online backup, through the app's own admin
# command, so it is consistent even while the server is writing. Copying the
# file out of the volume directly is NOT safe while the server runs.
set -euo pipefail

STACK_DIR="${STACK_DIR:-$(cd "$(dirname "$0")" && pwd)}"

# Off-box settings (S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY and
# optionally S3_REGION) live in a file that is not in git, so cron needs no
# secrets on its command line. Without the file the upload below is skipped.
if [ -f "${STACK_DIR}/.env.backup" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${STACK_DIR}/.env.backup"
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:-${STACK_DIR}/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="${BACKUP_DIR}/context-hub-${STAMP}.sqlite.gz"
COMPOSE=(docker compose -f "${STACK_DIR}/docker-compose.yml")
INSIDE="/tmp/hub-backup.sqlite"

# The hub's dashboard shows the state of this job, but the container must never
# see ${BACKUP_DIR} itself — n8n's dumps live there too. So the only thing it is
# shown is this one folder, read-only, holding this one JSON file.
STATUS_DIR="${STATUS_DIR:-${BACKUP_DIR}/status}"
STATUS_FILE="${STATUS_DIR}/context-hub.json"
STATUS_TMP="${STATUS_DIR}/.context-hub.json.tmp"

# What the status file will say. Each is promoted as the run gets further, so a
# run that dies half way through reports exactly how far it got.
LOCAL_OK=false
SIZE_BYTES=null
OFFSITE_OK=null
OFFSITE_CONFIGURED=false
if [ -n "${S3_BUCKET:-}" ]; then OFFSITE_CONFIGURED=true; fi

mkdir -p "${BACKUP_DIR}" "${STATUS_DIR}"

# Written on every exit, success or failure, so a failed run shows as failed
# rather than as a stale success. The temp file is in the same folder as the
# final one, so the `mv` is atomic and the hub never reads half a file.
write_status() {
  local rc=$?
  # Grouped, and the exit code is passed on explicitly: under `set -e` a failure
  # in here would otherwise replace the real reason the run ended.
  {
    mkdir -p "${STATUS_DIR}" &&
      printf '{"finished_at":"%s","local_ok":%s,"size_bytes":%s,"offsite_configured":%s,"offsite_ok":%s}\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${LOCAL_OK}" "${SIZE_BYTES}" "${OFFSITE_CONFIGURED}" "${OFFSITE_OK}" \
        > "${STATUS_TMP}" &&
      chmod 644 "${STATUS_TMP}" &&
      mv -f "${STATUS_TMP}" "${STATUS_FILE}"
  } || {
    rm -f "${STATUS_TMP}"
    echo "WARN: could not write ${STATUS_FILE}" >&2
  }
  exit "${rc}"
}
trap write_status EXIT

"${COMPOSE[@]}" exec -T context-hub rm -f "${INSIDE}"
"${COMPOSE[@]}" exec -T context-hub node /app/dist/admin-bin.js backup "${INSIDE}"
"${COMPOSE[@]}" exec -T context-hub cat "${INSIDE}" | gzip -9 > "${DUMP}"
"${COMPOSE[@]}" exec -T context-hub rm -f "${INSIDE}"

# A zero-length or truncated backup is worse than none, because it looks like
# a backup exists. Fail loudly instead.
if [ ! -s "${DUMP}" ]; then
  echo "FATAL: backup ${DUMP} is empty" >&2
  rm -f "${DUMP}"
  exit 1
fi
if ! gzip -t "${DUMP}"; then
  echo "FATAL: backup ${DUMP} is not a valid gzip file" >&2
  exit 1
fi
# Every SQLite file starts with this 15-byte header.
if [ "$(gunzip -c "${DUMP}" | head -c 15)" != "SQLite format 3" ]; then
  echo "FATAL: backup ${DUMP} is not a SQLite database" >&2
  exit 1
fi

# Past every check: the local copy is real, so the status file may claim it.
LOCAL_OK=true
SIZE_BYTES="$(wc -c < "${DUMP}")"

echo "wrote ${DUMP} ($(du -h "${DUMP}" | cut -f1))"

# Optional off-box copy, same variables as backup-n8n.sh. Skipped entirely
# when S3_BUCKET is unset.
if [ -n "${S3_BUCKET:-}" ]; then
  # false until the upload returns, so a failed one (or a missing key below,
  # which aborts the shell) is reported as a failure rather than as "unknown".
  OFFSITE_OK=false
  docker run --rm \
    -e AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY:?S3_ACCESS_KEY required when S3_BUCKET is set}" \
    -e AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY:?S3_SECRET_KEY required when S3_BUCKET is set}" \
    -e AWS_DEFAULT_REGION="${S3_REGION:-auto}" \
    -e AWS_REQUEST_CHECKSUM_CALCULATION=when_required \
    -e AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
    -v "${BACKUP_DIR}:/backups:ro" \
    amazon/aws-cli:latest \
    --endpoint-url "${S3_ENDPOINT:?S3_ENDPOINT required when S3_BUCKET is set}" \
    s3 cp "/backups/$(basename "${DUMP}")" "s3://${S3_BUCKET}/context-hub/"
  OFFSITE_OK=true
  echo "uploaded to s3://${S3_BUCKET}/context-hub/"
fi

# -maxdepth 1 keeps the pruner out of status/, which is not ours to tidy.
find "${BACKUP_DIR}" -maxdepth 1 -name 'context-hub-*.sqlite.gz' -mtime "+${RETENTION_DAYS}" -delete
echo "pruned local backups older than ${RETENTION_DAYS} days"
