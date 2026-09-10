# Async Decision Facilitator

A small team makes an asynchronous decision. Everyone commits privately, then
discusses openly. A neutral AI facilitator helps the team surface conflicting
assumptions — it does not make the decision, recommend an option, or coach
participants.

> **Implementation status: M0 (Cloudflare-as-code setup).**
> The deployment path, bindings and `npm` interface are in place. Product
> behaviour is built in M1–M8; the full documentation required by M8 replaces
> this file's later sections.

## Architecture (as configured)

| Component | Role |
|---|---|
| Worker (`src/server/index.ts`) | Thin. Routes Agents SDK traffic; from M1, resolves participant links into sessions. Holds no state. |
| `DecisionAgent` (SQLite Durable Object) | Transactional authority for one active decision. |
| `TeamAgent` (SQLite Durable Object) | Closed decision history only. |
| `FacilitatorWorkflow` (Workflow) | Durable AI execution: model invocation, retry, output validation. Not a system of record. |
| Workers AI (`AI` binding) | Model runtime. The specific model is chosen in M4, after the required model evaluation. |
| Static assets | React 19 client (Vite, Tailwind CSS v4), SPA fallback. |

Everything above is declared in `wrangler.jsonc` and provisioned by
`wrangler deploy`. There are no manual dashboard steps and no REST
provisioning.

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

### Still to confirm on the first real deploy

This set is derived from Cloudflare's documentation, not yet from a live deploy
of this project (M0 was implemented without credentials). Two things to watch:

1. If Workers AI inference returns 403 in M4, raise Workers AI from **Read** to
   **Edit** — the REST API docs are inconsistent about which is required.
2. If `wrangler deploy` fails on the Durable Object migration or the Workflow,
   that would mean those resources need a scope beyond Workers Scripts: Edit,
   which the documentation does not indicate. Report it if so.

## Local development

```bash
npm run dev
```

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
