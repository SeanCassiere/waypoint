# Shared by deploy-reader.sh and preview-reader.sh. Source it; don't run it.
#
# Loads the Cloudflare deploy credentials and a reader env file with strict parsing: literal
# KEY=value lines with known keys only, never executed and never echoed. The callers set
# `temporary` (a mode-700 scratch directory removed on exit) and `log_prefix` first.

reader_secret_keys=(TURSO_DATABASE_URL TURSO_READONLY_TOKEN R2_ACCOUNT_ID R2_READER_ACCESS_KEY_ID R2_READER_SECRET_ACCESS_KEY R2_BUCKET RAW_CAP_KEY)
reader_config_dir="$HOME/.config/waypoint"

# DRY_RUN: point reader_config_dir at fake, mode-600 env files in the scratch directory.
# Usage: reader_dry_run_config <reader env name>
reader_dry_run_config() {
  reader_config_dir="$temporary/config"
  mkdir -m 700 "$reader_config_dir"
  printf 'CLOUDFLARE_ACCOUNT_ID=dry-run\nCLOUDFLARE_API_TOKEN=dry-run\n' > "$reader_config_dir/cloudflare.env"
  printf 'TURSO_DATABASE_URL=dry-run\nTURSO_READONLY_TOKEN=dry-run\nR2_ACCOUNT_ID=dry-run\nR2_READER_ACCESS_KEY_ID=dry-run\nR2_READER_SECRET_ACCESS_KEY=dry-run\nR2_BUCKET=dry-run\nRAW_CAP_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n' > "$reader_config_dir/reader-$1.env"
  chmod 600 "$reader_config_dir"/*.env
}

# Accept only literal assignments. Never execute env file contents or echo values.
reader_read_env() {
  local file="$1" line key value
  [[ -f "$file" && "$(stat -c %a "$file")" == 600 ]] || { echo "$log_prefix: missing or non-600 env file: $file" >&2; return 1; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      echo "$log_prefix: invalid env assignment in $file" >&2; return 1
    fi
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    case "$key" in
      CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_TOKEN|TURSO_DATABASE_URL|TURSO_READONLY_TOKEN|R2_ACCOUNT_ID|R2_READER_ACCESS_KEY_ID|R2_READER_SECRET_ACCESS_KEY|R2_BUCKET|RAW_CAP_KEY) printf -v "$key" '%s' "$value" ;;
      *) echo "$log_prefix: unexpected env key $key" >&2; return 1 ;;
    esac
  done < "$file"
}

reader_require() {
  local key
  for key in "$@"; do
    [[ -n "${!key:-}" ]] || { echo "$log_prefix: missing $key" >&2; return 1; }
  done
}

# Loads cloudflare.env and exports the account ID and API token for wrangler.
reader_load_cloudflare() {
  reader_read_env "$reader_config_dir/cloudflare.env"
  reader_require CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN
  export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN
}

# Loads reader-<env>.env (the seven read-only reader values) into unexported shell variables.
# Usage: reader_load_secrets <reader env name>
reader_load_secrets() {
  reader_read_env "$reader_config_dir/reader-$1.env"
  reader_require "${reader_secret_keys[@]}"
}

# Writes the reader values to a mode-600 JSON file for wrangler, then unsets them.
# Usage: reader_write_secrets <path>
reader_write_secrets() {
  TURSO_DATABASE_URL="$TURSO_DATABASE_URL" TURSO_READONLY_TOKEN="$TURSO_READONLY_TOKEN" R2_ACCOUNT_ID="$R2_ACCOUNT_ID" R2_READER_ACCESS_KEY_ID="$R2_READER_ACCESS_KEY_ID" R2_READER_SECRET_ACCESS_KEY="$R2_READER_SECRET_ACCESS_KEY" R2_BUCKET="$R2_BUCKET" RAW_CAP_KEY="$RAW_CAP_KEY" node -e 'const fs=require("fs");const keys=["TURSO_DATABASE_URL","TURSO_READONLY_TOKEN","R2_ACCOUNT_ID","R2_READER_ACCESS_KEY_ID","R2_READER_SECRET_ACCESS_KEY","R2_BUCKET","RAW_CAP_KEY"];fs.writeFileSync(process.argv[1],JSON.stringify(Object.fromEntries(keys.map(k=>[k,process.env[k]]))),{mode:0o600})' "$1"
  unset "${reader_secret_keys[@]}"
}

# The dry-run wrangler's check that a secrets file is mode 600 and holds every reader value.
# Usage: reader_check_secrets_file <path>
reader_check_secrets_file() {
  node -e 'const fs=require("fs");const p=process.argv[1];const data=JSON.parse(fs.readFileSync(p,"utf8"));const keys=["TURSO_DATABASE_URL","TURSO_READONLY_TOKEN","R2_ACCOUNT_ID","R2_READER_ACCESS_KEY_ID","R2_READER_SECRET_ACCESS_KEY","R2_BUCKET","RAW_CAP_KEY"];if(fs.statSync(p).mode&0o077||keys.some(k=>!data[k]))process.exit(1)' "$1"
}
