# Phase 0 spike runners

These are throwaway Node 24 experiments. All local sync servers use `tursodb` 0.8.2 and temporary databases under `/tmp`; the scripts remove those databases after each run. S2 alone contacts the **dev** cloud database and creates a new `spike_s2_<random>` table. It never drops or renames a cloud table. The scripts print no credentials.

## Setup

Run from the repository root:

```bash
pnpm --dir spikes --store-dir /tmp/waypoint-pnpm-store install
mkdir -p spikes/.tools
curl -fLsS https://github.com/tursodatabase/turso/releases/download/v0.8.2/turso_cli-x86_64-unknown-linux-gnu.tar.xz -o spikes/.tools/turso_cli.tar.xz
tar -xJf spikes/.tools/turso_cli.tar.xz -C spikes/.tools
```

If Node is not on `PATH`, run `eval "$(fnm env)"` first. `spikes/.tools/` is ignored by Git.

## Run

Each spike has one command, run from the repository root:

```bash
node spikes/s1-sync/run.mjs
node spikes/s4-migration-harness/run.mjs
set -a; . /home/agent-1/.config/waypoint/dev.env; set +a; node spikes/s2-platform/run.mjs
```

S1 runs independent two-replica scenarios against a fresh local sync server per scenario. S4 rehearses a migration against two replicas. S2 requires the dev credentials in the same shell command. It checks Node, sync, serverless, and local-only databases. Example output from this run is in each spike's `output.txt`; results and limitations are in `RESULTS.md`.
