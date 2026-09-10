# Async Decision Facilitator

A small team makes an asynchronous decision. Everyone commits privately, then
discusses openly. A neutral AI facilitator helps the team surface conflicting
assumptions — it does not make the decision, recommend an option, or coach
participants.

> **Implementation status: M1 (application spine).**
> The deployment path is in place (M0), and a decision can now be framed,
> opened through a participant link, and read from SQLite-backed Durable Object
> state in the browser. The lifecycle itself — submit, reveal, discussion, the
> facilitator — is built in M2–M8; the full documentation required by M8
> replaces this file's later sections.

## Architecture (as configured)

| Component | Role |
|---|---|
| Worker (`src/server/index.ts`) | Thin. Resolves participant links into sessions, serves the SPA, routes Agents SDK traffic. Holds no state. |
| `DecisionAgent` (SQLite Durable Object) | Transactional authority for one active decision. |
| `TeamAgent` (SQLite Durable Object) | Closed decision history only. |
| `FacilitatorWorkflow` (Workflow) | Durable AI execution: model invocation, retry, output validation. Not a system of record. |
| Workers AI (`AI` binding) | Model runtime. The specific model is chosen in M4, after the required model evaluation. |
| Static assets | React 19 client (Vite, Tailwind CSS v4), SPA fallback. |

Everything above is declared in `wrangler.jsonc` and provisioned by
`wrangler deploy`. There are no manual dashboard steps and no REST
provisioning.

## Framing a decision and opening it

Until the seeded scenario arrives (M7), frame a decision over HTTP. There are
no accounts, so this is unauthenticated — it only hands back links to the
decision you just created:

```bash
curl -X POST http://localhost:5173/d/new \
  -H 'Content-Type: application/json' \
  -d '{"question":"Ship in February or slip to March?",
       "context":"Two weeks of runway left.",
       "options":["Ship in February","Slip to March"],
       "participants":["Ada","Grace"]}'
```

It returns one participant link per person — the first is the owner — and the
application adds the **Other** option itself. The links are shown **once**:
only their hashes are stored.

Opening a link:

```text
GET /d/:decisionId/p/:credential   Decision Agent validates the credential,
                                   mints a session, sets an HttpOnly cookie
      ↓ 303
GET /d/:decisionId                 SPA shell; the credential is out of the URL
      ↓
WS  /agents/decision-agent/:id     Decision Agent authenticates the cookie,
                                   then serves getBootstrap() from SQLite
```

The credential stays reusable: opening the same link again — another browser,
another device, later — mints another session for the same participant. A
connection without a valid session is closed, not served.

## Prerequisites

- Node.js ≥ 22.18 (the scripts are TypeScript run directly by Node's built-in
  type stripping — there is no `tsx`/`ts-node` dependency)
- A Cloudflare account, an API token, and the Account ID

## Setup

```bash
npm install
cp .env.example .env    # add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
npm run setup
```

`npm run setup` validates the credentials, generates Worker types, builds,
deploys, seeds the demonstration scenario (from M7) and prints the application
URL.

## Cloudflare API token permissions

Create the token at **My Profile → API Tokens → Create Token**. Start from the
**Edit Cloudflare Workers** template, then adjust to the three scopes below.

| Scope | Permission | Why this project needs it |
|---|---|---|
| Account → Workers Scripts | **Edit** | Uploading the Worker. Also covers **Durable Objects, the SQLite migration, Workflows, static assets and the observability setting** — none of those have a permission group of their own; they are all managed through the Workers Scripts API. |
| Account → Account Settings | **Read** | `wrangler whoami`, which `npm run setup` uses to validate credentials, needs this to list accounts. Cloudflare's own auto-generated Workers deploy token includes it. |
| Account → Workers AI | **Read** | The `AI` binding. Needed by `npm run dev` (the binding is remote) and by facilitator inference from M4. Every `/accounts/{id}/ai/*` endpoint requires it. |

Set **Account Resources** to the single account you are deploying to. Client IP
filtering and a TTL are optional and safe to add.

### Deliberately excluded

| Scope | Why not |
|---|---|
| Workers KV Storage → Edit | Ships with the *Edit Cloudflare Workers* template, but this project uses no KV. Remove it. |
| User → User Details → Read | Only lets `wrangler whoami` print your email address; without it Wrangler warns but authentication still works. Add it if `npm run setup` fails at the credential check. |
| Workers Tail → Read | Only for `wrangler tail` live logs. Add later if you want them. |
| Workers Observability | No such permission group exists. `observability.enabled` is Worker configuration, applied under Workers Scripts: Edit. |

### Verified against a live deploy

A single **Account API Token** on one account deployed the whole stack in one
`npm run setup`: Worker, static assets, **both SQLite Durable Objects including
the `new_sqlite_classes` migration**, the **Workflow** (`facilitator-workflow`,
provisioned automatically), the Workers AI binding, and `observability.enabled`.

This confirms the key finding: **Durable Objects, Workflows and observability
need no permission of their own.** They are provisioned entirely under
Workers Scripts: Edit. No dashboard step was required for any resource.

`wrangler whoami` also succeeded, so the token carries Account Settings: Read.

Still unproven: whether Workers AI **Read** is enough to *run inference*, as
opposed to merely attaching the binding at deploy time. The binding attached
fine, but no model has been invoked yet. If inference 403s in M4, raise it to
**Edit**.

## Local development

```bash
npm run dev
```

`.env` holds Cloudflare **CLI credentials only.** Wrangler would otherwise also
load `.env` into the *Worker's* `env` — writing the API token into
`dist/.../.dev.vars` and typing it into `Env`. `wrangler.jsonc` declares
`"secrets": { "required": [] }` to stop that. Add a name to that array if the
Worker ever genuinely needs a secret.

Local dev **also requires Cloudflare credentials.** There is no local Workers AI
emulator, so the `AI` binding is declared `remote: true` and Miniflare proxies
it to the real account; it connects eagerly at startup and fails without a
token.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Local dev server (Vite + Miniflare) |
| `npm run build` | Build client and Worker |
| `npm run deploy` | Build and deploy |
| `npm run setup` | Validate → types → build → deploy → seed → print URLs |
| `npm run seed` | Seed the demonstration scenario (M7) |
| `npm test` | Tests |
| `npm run eval` | Facilitator model evaluation (M4) |
| `npm run types` | Regenerate `env.d.ts` from `wrangler.jsonc` |
| `npm run check` | Typecheck |

## Security limitation (intentional, MVP)

Participant identity is a decision-scoped bearer link. **Anyone who possesses a
participant's link can act as that participant.** Links do not expire, are not
single-use, and work from any browser or device. There are no user accounts and
**no account recovery.** These credentials are not appropriate for highly
sensitive information.

What the implementation does do: only SHA-256 hashes of credentials and
sessions are persisted, so the stored state yields no working links; the
credential is exchanged once for an `HttpOnly` session cookie and then leaves
the address bar; and the cookie is scoped per decision, so one browser can hold
sessions for several decisions — as a different participant in each.
