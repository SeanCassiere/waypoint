#!/usr/bin/env bash
set -euo pipefail
mkdir -p .tools
archive=.tools/turso_cli-v0.8.2-linux-x64.tar.xz
curl -fL --retry 3 https://github.com/tursodatabase/turso/releases/download/v0.8.2/turso_cli-x86_64-unknown-linux-gnu.tar.xz -o "$archive"
printf '%s  %s\n' 1a12393fdb1fc36ef4c0339609b2652d6a0f7bb4a5f6c08da4afe1d364422d18 "$archive" | sha256sum -c -
tar -xJf "$archive" -C .tools
chmod +x .tools/turso_cli-x86_64-unknown-linux-gnu/tursodb
