#!/usr/bin/env bash
set -euo pipefail
mkdir -p .tools
archive=.tools/turso_cli-v0.8.3-linux-x64.tar.xz
curl -fL --retry 3 https://github.com/tursodatabase/turso/releases/download/v0.8.3/turso_cli-x86_64-unknown-linux-gnu.tar.xz -o "$archive"
printf '%s  %s\n' 4475c4df29f744fb3b2fdeef622d9297bbb80698039eec57d1b3ba7e048b5e31 "$archive" | sha256sum -c -
tar -xJf "$archive" -C .tools
chmod +x .tools/turso_cli-x86_64-unknown-linux-gnu/tursodb
