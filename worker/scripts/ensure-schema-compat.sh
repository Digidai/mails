#!/usr/bin/env bash
set -euo pipefail

DB_NAME="${1:-mails}"
CONFIG_FILE="${2:-wrangler.toml}"

table_exists() {
  local table="$1"
  npx wrangler d1 execute "$DB_NAME" --remote --config "$CONFIG_FILE" --command "SELECT 1 FROM \"$table\" LIMIT 0" >/tmp/d1-table-check.log 2>&1
}

column_exists() {
  local table="$1"
  local column_expr="$2"
  npx wrangler d1 execute "$DB_NAME" --remote --config "$CONFIG_FILE" --command "SELECT $column_expr FROM \"$table\" LIMIT 0" >/tmp/d1-column-check.log 2>&1
}

ensure_column() {
  local table="$1"
  local column_expr="$2"
  local add_column_sql="$3"

  if ! table_exists "$table"; then
    echo "Table $table does not exist yet; base schema will create it."
    return
  fi

  if column_exists "$table" "$column_expr"; then
    echo "Column $table.$column_expr already exists."
    return
  fi

  echo "Adding missing column $table.$column_expr..."
  npx wrangler d1 execute "$DB_NAME" --remote --config "$CONFIG_FILE" --command "ALTER TABLE \"$table\" ADD COLUMN $add_column_sql"
}

# Older hosted D1 databases may have tables created before mailbox-scoped auth,
# delivery metadata, or smart routing columns existed. CREATE TABLE IF NOT EXISTS
# will not add missing columns, so normalize those legacy tables before applying
# the full schema and indexes.
ensure_column "auth_tokens" "mailbox" "mailbox TEXT"
ensure_column "auth_tokens" "webhook_url" "webhook_url TEXT"
ensure_column "auth_tokens" "created_at" "created_at TEXT"
ensure_column "auth_tokens" "scope" "scope TEXT DEFAULT 'full'"
ensure_column "auth_tokens" "status" "status TEXT DEFAULT 'active'"
ensure_column "auth_tokens" "webhook_failures" "webhook_failures INTEGER DEFAULT 0"
ensure_column "auth_tokens" "webhook_status" "webhook_status TEXT DEFAULT 'active'"
ensure_column "auth_tokens" "send_unlocks_at" "send_unlocks_at TEXT"
ensure_column "auth_tokens" "expires_at" "expires_at TEXT"

ensure_column "emails" "message_id" "message_id TEXT"
ensure_column "emails" "thread_id" "thread_id TEXT"
ensure_column "emails" "in_reply_to" "in_reply_to TEXT"
ensure_column "emails" '"references"' '"references" TEXT'
ensure_column "emails" "has_attachments" "has_attachments INTEGER NOT NULL DEFAULT 0"
ensure_column "emails" "attachment_count" "attachment_count INTEGER NOT NULL DEFAULT 0"
ensure_column "emails" "attachment_names" "attachment_names TEXT DEFAULT ''"
ensure_column "emails" "attachment_search_text" "attachment_search_text TEXT DEFAULT ''"
ensure_column "emails" "raw_storage_key" "raw_storage_key TEXT"

ensure_column "domains" "mailbox" "mailbox TEXT"
