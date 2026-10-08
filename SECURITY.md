# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately**, through GitHub's private vulnerability reporting:
the repository's **Security** tab → **Report a vulnerability**
([direct link](https://github.com/SeanCassiere/waypoint/security/advisories/new)). Don't open a
public issue, discussion or pull request for a vulnerability.

Include what you can of:

- the component (writer, viewer, public reader, MCP launcher or server, `upgrade.sh`, the release
  pipeline) and the version (`/healthz` reports it, or the release tag);
- how the instance was set up, if it matters (local-only, Tailscale, cloud sync, public reader);
- steps to reproduce, and what an attacker gains: which zone of the
  [trust model](docs/trust-model.md) they start in and what they reach.

Waypoint is maintained by one person, on a best-effort basis. You should get an acknowledgement
within a week. Fixes are released as a new version; the advisory is published once a fixed
release is out, crediting you unless you'd rather not be.

## Supported versions

Only the **latest 0.x release** gets security fixes. Upgrading is `upgrade.sh latest`
([docs/self-hosting.md](docs/self-hosting.md#upgrading-and-rolling-back)).

## Scope

The [trust model](docs/trust-model.md) defines what Waypoint protects and what it deliberately
doesn't. In short:

**In scope**, for example:

- anything that lets someone on the public internet read more than a valid share link allows
  (another collection, an older or newer revision than the link permits, a revoked or expired
  link, a tombstoned collection), or tell whether something exists;
- any way to write, delete or change anything through the public reader;
- share-token or raw-capability forgery, leakage of a share token to third parties, and escapes
  from the reader's sandboxing or Content Security Policy;
- cross-site attacks on a writer from a website a writer user visits (CSRF, framing,
  costly GETs);
- the MCP launcher running code that didn't come from the configured writer;
- `upgrade.sh` or the release pipeline: deploying an artifact that wasn't built and attested by
  the release workflow on `main`, or exposing an instance's secrets (in logs, files or process
  arguments);
- the writer's handling of uploads (path traversal, limits) and of its data directory.

**Out of scope**, by design (see the accepted risks in the
[trust model](docs/trust-model.md#whats-out-of-scope-accepted-risks)):

- the writer has **no login**: anyone who can reach it (on its private network, or its loopback
  port) can read and change everything. Exposing a writer to an untrusted network is a
  misconfiguration, not a vulnerability;
- HTML that agents write runs unsandboxed in the writer's own viewer (decision D23), so a
  malicious document opened there can call the writer API;
- a leaked share URL gives access until it's revoked or expires (capability URLs);
- the storage providers (Turso, the S3 or R2 bucket) can read stored content;
- volumetric denial of service against the Cloudflare edge;
- vulnerabilities in dependencies with no exploitable path in Waypoint (report them upstream;
  Dependabot keeps them updated here);
- findings that need a compromised device on the writer's network, or the instance host itself.

If you're unsure whether something is in scope, report it privately anyway.
