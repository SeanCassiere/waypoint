<!--
The PR title becomes the squash-merge commit that release-please reads:
`type(scope): subject`, for example `fix(reader): return 404 for an expired pinned link`
(`!` after the type or scope for a breaking change). See CONTRIBUTING.md.
-->

## What and why

<!-- What this changes, and the problem it solves. Link the issue if there is one. -->

## How it was tested

<!-- Tests added or changed, and anything checked by hand (browser, a local writer, upgrade.sh). -->

## Checklist

- [ ] Docs in `docs/` (and `AGENTS.md`, `deploy/README.md`) match the new behaviour; a design decision is recorded in `docs/decisions.md`
- [ ] Access, credentials, share links or content serving changed: `docs/trust-model.md` is updated (or nothing there changed)
- [ ] Schema changes are additive only (or there are none)
- [ ] Renderer output is unchanged, or `RENDERER_VERSION` is bumped
- [ ] The MCP launcher is unchanged, or `LAUNCHER_API` stays compatible
- [ ] No secrets, and no instance-specific hostnames, domains or account IDs
