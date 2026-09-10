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

> **Not yet empirically verified.** M0 was implemented without live Cloudflare
> credentials, so the deployment chain was validated up to
> `wrangler deploy --dry-run`. The minimum permission set below is the
> best-known requirement and must be confirmed against a real deploy, then
> narrowed to the actual minimum.

Create the token from the **Edit Cloudflare Workers** template, then add
Workers AI:

| Scope | Permission | Needed for |
|---|---|---|
| Account → Workers Scripts | Edit | Worker upload, Durable Object namespaces, Workflows, static assets |
| Account → Workers AI | Read | The `AI` binding, including the remote binding used by `npm run dev` |
| Account → Account Settings | Read | `wrangler whoami` credential validation |

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
