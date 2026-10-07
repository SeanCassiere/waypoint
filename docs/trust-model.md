# Trust model

This is the single source of truth for **who can do what** in Waypoint and **why**. Other docs link here instead of restating it. If you change anything listed here, update this page in the same PR and record the reason in [decisions.md](decisions.md).

## Zones

| Zone | Who is in it | Can read | Can write | Authenticated by |
|---|---|---|---|---|
| **Tailnet** | Any device on the owner's Tailscale network: agent-1, the MacBook Air, future machines, and the agents running on them | Everything, including deleted, pending, and failed items | Everything: create, revise, edit titles, delete, purge, create or revoke share links | Tailnet membership only. The writer has no login (D2). |
| **Public** | Anyone on the internet | Only what a valid, unrevoked, unexpired share link allows | **Nothing, ever** (D3) | Possession of a share token or derived revision capability |
| **Cloud providers** | Turso (metadata) and Cloudflare R2 (file contents) | Everything, at rest | Only through Waypoint's credentials | Provider accounts |

The tailnet is the trust boundary, not the home LAN. The writer is **not reachable from the plain LAN** (D37): LANs contain guests and IoT devices, and the writer has no auth.

## The core rules

1. **IDs identify; they never authorize** (D4). Collection and revision IDs and public IDs end up in logs, screenshots, and chat. Knowing one never grants public access.
2. **Stored is not exposed** (D5). Turso and R2 hold *everything*, private content included. Public access exists only through share links.
3. **Deny by default in public.** The reader answers **404** for anything not explicitly allowed by a valid share link, with one fixed page that is byte-identical for every reason. It never returns 403, so it never confirms that something exists. The other non-denial URLs are the bare root `/` (a fixed 200 with no data, which has nothing to confirm) and the operational endpoints `/healthz`, `/healthz/deep` and `/robots.txt`. `/healthz/deep` counts toward the per-IP limiter, since it queries Turso and R2.
4. **The reader can't write, structurally:**
   - **Metadata:** its Turso token is created `--read-only`; writes return `BLOCKED`.
   - **Blobs:** it reads R2 over the S3 API with an **Object Read only** token scoped to one bucket. It has no R2 binding (D38).
   - **Code:** the Worker build contains no write routes.
   - **Logs:** access events go to Workers Analytics Engine, never the main DB (D26).
5. **The writer is the only path to the cloud** (D21 + phase-1 design). No machine writes to Turso or R2 directly.
6. **Agents can't destroy.** The MCP server exposes no delete, purge, title or metadata edit, or share-link creation. Those are owner actions in the writer UI or API. An agent may publish and revise, but publishing to the public is a human decision.

## Credentials: who holds what

| Credential | Power | Held by | Stored at |
|---|---|---|---|
| Turso full-access token (`waypoint-<env>`) | Read/write metadata | Writer | `~/.config/waypoint/<env>.env` on agent-1 |
| R2 `waypoint-writer-<env>` | Read/write/delete objects in one bucket | Writer | same |
| Turso read-only token | Read metadata | Reader Worker | `reader-<env>.env` on agent-1, then uploaded as a Worker secret |
| R2 `waypoint-reader-<env>` | Read and list one bucket | Reader Worker | same |
| Prod read-only reader values (the two rows above, prod only) | Same as above | PR Worker Previews of `waypoint-reader` | `reader-prod.env`, uploaded with each preview deployment by the Preview workflow on the self-hosted runner |
| Cloudflare `waypoint-reader-deploy` | Deploy Workers; edit DNS and routes on `pingstash.com` | Deploy pipeline (self-hosted runner) | `cloudflare.env` on agent-1. **Never** a GitHub secret. |
| Tailscale auth key (`tag:waypoint`) | Join the tailnet as the sidecar, once | Sidecar | `ts.env` on agent-1; single-use and already consumed |
| Share tokens (`wps_…`) | Read one collection (or one revision) publicly | Whoever the owner shares the URL with | Only `sha256(token)` is stored, so a leaked database doesn't leak working links |

All secrets on agent-1 are in `~/.config/waypoint/` (directory mode 700, files 600). They're passed to processes at runtime and never committed or baked into images. How to create or rotate them: [provisioning.md](provisioning.md).

## Share links

- **Format:** `https://waypoint.pingstash.com/s/<token>/c/<collection public id>/…`. The token is `wps_` plus 32 random bytes, base64url-encoded. The prefix makes leaked tokens easy for secret scanners to spot.
- **Scope:** one collection. A link either **follows the latest** revision or is **pinned** to one revision (D20). Viewers of a following link never see older revisions, since an older revision may contain something later removed.
- **Lifecycle:** created and revoked only on the tailnet. They can carry an expiry. Revocation takes effect within about 60 s (the reader's lookup cache plus the writer's push).
- **Tombstones win:** deleting a collection makes every link to it return 404. Undeleting reactivates links that were not revoked or expired; accepting a purge immediately revokes all its links.
- **Properties of a capability URL**, which the owner should understand:
  - Anyone holding the URL can view the content until it's revoked or expires.
  - URLs can end up in browser history, chat logs, and screenshots. Mitigations:
    - `Referrer-Policy: no-referrer` stops the token leaking to other sites.
    - `X-Robots-Tag: noindex` and a disallow-all `robots.txt` keep it out of search engines.
    - `Cache-Control: private` keeps shared caches from serving it after revocation.
    - Only denied protected requests count toward rate limiting. Once an IP exceeds 30 denials per 60 seconds, that reader isolate blocks it for 60 seconds before any DB or R2 access. Even valid links from that IP receive the same generic 404 during the block; this is acceptable because the block follows more than 30 denials. Blocked and ordinary denials have identical status, body, and headers.

## Untrusted content

Content is written by agents, so treat it as **untrusted HTML** wherever someone other than the owner might view it.

- **On the tailnet** (D23): agent HTML and markdown renditions are served from the writer's own origin without sandboxing. The owner trusts their own agents, and the convenience is worth it. Consequence: a malicious document opened in the tailnet viewer could call the writer API. The writer's CSRF checks (`Origin`/`Sec-Fetch-Site`, JSON-only) stop *other* websites, but not same-origin content. Revisit this if untrusted parties ever get tailnet access.
- **In public**, content is sandboxed so a shared document can't act as the reader's origin:
  - Raw content responses carry `Content-Security-Policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms`, **without** `allow-same-origin`, so they run in an opaque origin.
  - The reader shell embeds content in `<iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox">`.
  - The shell itself has a strict, hash-only CSP and runs no agent-supplied code. Its iframe URL contains a derived capability for only the resolved revision, never the full share token. Scripts in agent HTML can still read and exfiltrate the revision content they are shown, and may disclose that revision capability while it remains valid.
  - The shell's one script listens for the rendition's `waypoint:location` message. A document (or any page it navigates the frame to) can post anything, so the shell accepts only messages from the frame's own window, and only uses them to highlight a file it already links to and to replace its URL with that link's own href. The shell sends `Cross-Origin-Opener-Policy: same-origin`, so a popup a document opens (allowed to escape the sandbox) has no opener to navigate the shell with.
- **Markdown renditions** pass raw HTML through (they're agent content), so the same rules apply to them.

## Writer request safety (tailnet)

The writer trusts any client on the tailnet, but defends against *websites* attacking it through a tailnet user's browser:
- JSON endpoints require `Content-Type: application/json` (415 otherwise).
- Mutating requests from another origin are rejected with 403. The check is `Sec-Fetch-Site: cross-site`/`same-site`, or an `Origin` header that doesn't match the writer.
- Requests without browser headers (MCP, curl) pass.
- Viewer HTML pages send `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so another site can't frame them and trick a click on Revoke or Share. `/raw` (framed by the viewer itself) and the JSON API don't.
- GETs have no side effects but can be triggered cross-site (`<img src=…>`), so costly ones are bounded: diffs and Changes-page Markdown run under time budgets in a worker thread (D47).

## Code that runs on agent machines

The MCP launcher fetches `/mcp/server.mjs` from the writer and **executes it** (D36). The trust root is the writer, reached over **tailnet HTTPS**, and the bundle is checked against `X-Waypoint-Content-SHA256`. That check guards against truncation, not tampering: the writer itself is trusted. The launcher warns on stderr when `WAYPOINT_URL` is plain HTTP to a host other than loopback or `*.ts.net`.

## Deploy pipeline

- CI on pull requests runs on GitHub-hosted runners and receives no secrets.
- Deploys run only on the **self-hosted runner on agent-1**, triggered by successful CI on `main`. The runner runs as the `agent-1` user, so it can read `~/.config/waypoint/`. Merging to `main` is therefore equivalent to running code with production credentials.
  - The repository is private, and only the owner can merge.
  - Never add a workflow that runs untrusted code (for example from forks) on the `waypoint-deploy` runner.
- **PR previews run unreviewed PR code on the same runner** (D49). The Preview workflow ([preview.yml](../.github/workflows/preview.yml)) checks out each PR's head commit on the `waypoint-deploy` runner, uploads it as a Worker Preview of the prod reader with the prod **read-only** reader credentials, and deletes it when the PR closes. GitHub runs a `pull_request` workflow **from the PR's own branch**, so whoever can push a branch to this repository can change the workflow in that branch and run anything on the runner, with everything in `~/.config/waypoint/`, before any review.
  - **That's acceptable only because only the owner can push branches.** If anyone else ever gets write access (a collaborator, a deploy key, or an app or bot that can push branches), remove the Preview workflow or move previews off the self-hosted runner first.
  - **Fork PRs never reach the runner because fork-PR workflows are off.** The repository is private, and its Actions setting "Run workflows from fork pull requests" is off (`run_workflows_from_fork_pull_requests: false`, checked 2026-10-08). **It must stay off.** A fork PR would run the fork's own copy of `preview.yml`, so the workflow's `if: head.repo.full_name == github.repository` conditions can't stop forks; they only prevent mistakes.
  - **A guard job runs first, on a GitHub-hosted runner.** It fails unless the head repo is this repo and both `github.actor` and `github.triggering_actor` are on its allow list (only `SeanCassiere`; bots only after review). The self-hosted jobs `need` it.
  - The self-hosted jobs' own `if:` conditions repeat the same checks, because re-running only `up` reuses the guard's earlier success.
  - The guard is defense in depth against mistakes, not against a malicious branch, which could edit the guard too. The real control is who can push.
  - **Never use `pull_request_target`.** It would run with this repo's permissions for fork PRs.
  - The preview jobs get a read-only `GITHUB_TOKEN`. Only the comment job, on a GitHub-hosted runner with no checkout, can write PR comments.
- **Previews are owner-only.** Cloudflare Access (app `fb19dcb4-9f87-47dc-a038-1b41cef93d0f`, one Allow policy for the owner) covers `waypoint-reader.seancassiere.workers.dev` and `*-waypoint-reader.seancassiere.workers.dev`. Those are the prod Worker's `workers.dev` route, its version URLs and every preview.
  - The preview script fails closed. Once it has started uploading, anything short of both URLs answering 302 to the Access login deletes the preview: an upload error, unexpected output, another redirect, an error status, no response, a timeout or a cancelled run.
  - Every prod reader deploy also requires `waypoint-reader.seancassiere.workers.dev` to redirect to Access, and rolls back if it doesn't.
  - Previews are never enabled on `waypoint.pingstash.com`, which stays public, production only, and without Access. Its route pins `previews_enabled: false`.
  - A preview can read everything the prod reader can (all prod metadata and blobs, not just shared ones), and it can't write.
- Dependencies: Dependabot alerts are triaged. Lockfiles are frozen in CI. pnpm's `minimumReleaseAge` delays brand-new package versions.

## What's out of scope (accepted risks)

| Risk | Why it's accepted |
|---|---|
| A compromised tailnet device can read and modify everything | The tailnet is the trust boundary by design (D2). Protect it with Tailscale device approval and key expiry if that ever matters. |
| A leaked share URL grants access until revoked or expired | Capability-URL model. Revoke it in the writer; it takes effect within about 60 s. Passwords and audience grants are planned to narrow this. |
| Malicious agent HTML in the tailnet viewer can call the writer API | D23. The agents are the owner's own. |
| Turso or Cloudflare can read stored content | Accepted provider trust. There's no client-side encryption. |
| A pushed branch can run any code on the deploy runner before review | The Preview workflow runs the PR branch's own workflow file there (D49). It's accepted only because only the owner can push, and that "owner" includes every agent, token and tool that pushes as `SeanCassiere`. Such code can reach far more than the reader credentials. The runner runs as `agent-1`, which is in the `docker`, `lxd` and `sudo` groups, so it is effectively root on agent-1. That includes every secret in `~/.config/waypoint/` (writer, Turso, R2 and Cloudflare), T3 Code and the other agent workloads, and the host's `gh` and git credentials. The runner is persistent: a job could leave behind files, Docker images or tool caches that a later deploy picks up. |
| Losing the R2 bucket loses content | The bucket is the durability floor; see [write-path-and-sync.md](write-path-and-sync.md#restore--disaster-recovery). |

## Related decisions

D1–D6, D20, D21, D23, D24, D26, D36, D37, D38, D40, D41, D49. See [decisions.md](decisions.md).
