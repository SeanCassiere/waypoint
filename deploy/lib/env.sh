# shellcheck shell=bash
# Strict env-file parsing for deploy/upgrade.sh. Source it; don't run it.
#
# Env files are data, never code: each non-blank, non-comment line must be a literal KEY=value
# with a known key. Nothing is executed, expanded or unquoted, and values never reach the
# terminal. Callers set `log_prefix` first.

# Usage: envfile_fail <message>
envfile_fail() {
  echo "${log_prefix:-upgrade}: $*" >&2
  return 1
}

# A file that holds secrets: a regular file readable by its owner only (mode 600 or 400).
# Usage: envfile_check_secret_mode <file>
envfile_check_secret_mode() {
  local file="$1" mode
  [[ -f "$file" ]] || { envfile_fail "missing env file: $file"; return 1; }
  mode="$(stat -c %a "$file")"
  [[ "$mode" == 600 || "$mode" == 400 ]] || { envfile_fail "env file must be mode 600: $file (is $mode)"; return 1; }
}

# A file that holds no secrets but decides what runs: owned by the current user and writable by
# nobody else.
# Usage: envfile_check_config_mode <file>
envfile_check_config_mode() {
  local file="$1" mode owner
  [[ -f "$file" ]] || { envfile_fail "missing file: $file"; return 1; }
  owner="$(stat -c %u "$file")"
  mode="$(stat -c %a "$file")"
  [[ "$owner" == "$(id -u)" ]] || { envfile_fail "$file must be owned by $(id -un)"; return 1; }
  (( (8#$mode & 8#022) == 0 )) || { envfile_fail "$file must not be writable by group or others (is $mode)"; return 1; }
}

# Reads <file> into shell variables named <prefix><KEY>. <accept> is the name of a function that
# returns 0 for a key the caller knows. Repeated keys are an error, so a later line can't silently
# override an earlier one. Values are always taken literally. By default quotes, `$` and backticks
# are rejected, because they'd suggest shell semantics that don't exist here. With `secret`,
# they're allowed (a token or password may contain any of them); only a value wrapped in a pair
# of quotes is rejected, since the quotes would become part of it.
# Usage: envfile_read <file> <prefix> <accept function> [secret]
envfile_read() {
  local file="$1" prefix="$2" accept="$3" mode="${4:-}" line key value lineno=0 seen=" "
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ ! "$line" =~ ^([A-Za-z][A-Za-z0-9_]*)=(.*)$ ]]; then
      envfile_fail "$file:$lineno: expected KEY=value"
      return 1
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if ! "$accept" "$key"; then
      envfile_fail "$file:$lineno: unexpected key $key"
      return 1
    fi
    if [[ "$seen" == *" $key "* ]]; then
      envfile_fail "$file:$lineno: $key is set twice"
      return 1
    fi
    seen+="$key "
    if [[ "$mode" == secret ]]; then
      if [[ "$value" =~ ^\".*\"$ || "$value" =~ ^\'.*\'$ ]]; then
        envfile_fail "$file:$lineno: $key: values are literal; remove the surrounding quotes"
        return 1
      fi
    elif [[ "$value" == *[\"\'\`\$]* ]]; then
      envfile_fail "$file:$lineno: $key: values are literal; remove quotes, \$ and backticks"
      return 1
    fi
    printf -v "$prefix$key" '%s' "$value"
  done < "$file"
}

# Cloudflare deploy credentials (cloudflare.env): CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN.
envfile_cloudflare_key() {
  [[ "$1" == CLOUDFLARE_ACCOUNT_ID || "$1" == CLOUDFLARE_API_TOKEN ]]
}

# Reader secrets (reader-<target>.env). Required: everything but the S3 overrides, and
# R2_ACCOUNT_ID unless WAYPOINT_S3_ENDPOINT is set (docs/configuration.md).
reader_secret_keys=(TURSO_DATABASE_URL TURSO_READONLY_TOKEN R2_ACCOUNT_ID R2_READER_ACCESS_KEY_ID R2_READER_SECRET_ACCESS_KEY R2_BUCKET RAW_CAP_KEY WAYPOINT_S3_ENDPOINT WAYPOINT_S3_REGION)
envfile_reader_key() {
  local key
  for key in "${reader_secret_keys[@]}"; do
    [[ "$1" == "$key" ]] && return 0
  done
  return 1
}

# Parses a reader secrets file and writes it as a mode-600 JSON object for `wrangler secret
# bulk`, holding only the keys that are set. The values pass to node through its environment,
# never its command line, and are unset again before returning.
# Usage: reader_secrets_json <secrets env file> <output json>
reader_secrets_json() {
  local file="$1" out="$2" key
  envfile_check_secret_mode "$file" || return 1
  for key in "${reader_secret_keys[@]}"; do unset "rs_$key"; done
  envfile_read "$file" rs_ envfile_reader_key secret || return 1
  for key in TURSO_DATABASE_URL TURSO_READONLY_TOKEN R2_READER_ACCESS_KEY_ID R2_READER_SECRET_ACCESS_KEY R2_BUCKET RAW_CAP_KEY; do
    local name="rs_$key"
    [[ -n "${!name:-}" ]] || { envfile_fail "$file: missing $key"; return 1; }
  done
  if [[ -z "${rs_R2_ACCOUNT_ID:-}" && -z "${rs_WAYPOINT_S3_ENDPOINT:-}" ]]; then
    envfile_fail "$file: set R2_ACCOUNT_ID or WAYPOINT_S3_ENDPOINT"
    return 1
  fi
  (
    for key in "${reader_secret_keys[@]}"; do
      local name="rs_$key"
      if [[ -n "${!name:-}" ]]; then export "WPSECRET_$key=${!name}"; fi
    done
    node -e '
      const fs = require("node:fs");
      const out = {};
      for (const [k, v] of Object.entries(process.env))
        if (k.startsWith("WPSECRET_")) out[k.slice(9)] = v;
      fs.writeFileSync(process.argv[1], JSON.stringify(out), { mode: 0o600 });
    ' "$out"
  ) || return 1
  for key in "${reader_secret_keys[@]}"; do unset "rs_$key"; done
}
