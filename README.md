# jobs-ai

An AI job concierge for the frum community, built on the jobs database that is scraped daily from six
community weekly papers and five job websites. A person signs up, uploads a resume, says what they want,
and a Claude agent searches the live listings and returns a tiered shortlist, then keeps working with them
in chat. Pay as you go: credit packs from $5, every reply shows its cost.

- `docs/PLAN.md` — the full design and build plan (read this first).
- `supabase/migrations/` — SQL applied to the Supabase project `jobs-ai` (`xrbnekghcswgotsauxok`).
- `web/` — the Next.js 16 app (App Router, TypeScript, Tailwind).

## Run it locally

```bash
cd web
cp .env.example .env.local   # then fill in the blanks below
pnpm install
pnpm dev
```

Fill in `web/.env.local`:

| Variable | Where it comes from |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Project Settings → API keys. Server only. |
| `ANTHROPIC_API_KEY` | console.anthropic.com. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard. Leave empty to run without payments (the Buy buttons disable themselves). |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` locally, your public origin in production. |

The Supabase URL and publishable key are already filled in. Optional knobs (`AGENT_MODEL`, `AGENT_EFFORT`,
`CREDIT_MARKUP`, `WELCOME_CREDIT_CENTS`, `CREDIT_TURN_RESERVE_MICROS`) are documented in `.env.example`.

Supabase Auth: in the dashboard add `http://localhost:3000/auth/callback` (and the production equivalent) to
Authentication → URL Configuration → Redirect URLs.

Stripe webhook: point an endpoint at `/api/stripe/webhook` for `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and
`checkout.session.expired`. Locally: `stripe listen --forward-to localhost:3000/api/stripe/webhook`.

Giving yourself credits without Stripe (SQL editor, service role):

```sql
select public.grant_credits('<auth user uuid>', 5000000, 'adjustment', null, 'manual test credit'); -- $5.00
```

## Checks

```bash
cd web
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint
pnpm smoke       # exercises the agent's search tools against the live database (needs network to *.supabase.co, no API key)
pnpm build
```

## Billing switch (free testing)

`BILLING_ENABLED` is `false` by default. In that mode anyone signed in can use the app without limit,
nobody is charged and the Buy buttons are hidden. Every reply is still metered: the Usage page lists the
tokens per turn and what it would have cost. Set `BILLING_ENABLED=true` (and configure Stripe) to start
charging; nothing else changes.

## Deploy on Netlify

`netlify.toml` at the repo root already sets the base directory (`web`), the build command and Node 22.
Netlify detects Next.js and applies its adapter automatically.

1. Netlify → Add new site → Import from GitHub → `MyDira/jobs-ai`. Pick the branch to deploy
   (`claude/gallant-noether-2q9tpa` until it is merged, then `main`). Leave the build settings as read from
   `netlify.toml`.
2. Site configuration → Environment variables. Required:
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (values in `web/.env.example`),
   `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`. Optional: `BILLING_ENABLED` (default `false`),
   `AGENT_EFFORT`, `AGENT_REQUEST_BUDGET_MS`. Leave `NEXT_PUBLIC_SITE_URL` empty; the site URL is detected.
   The `NEXT_PUBLIC_` values are baked in at build time, so redeploy after changing them.
3. Supabase → Authentication → URL Configuration: set Site URL to `https://<your-site>.netlify.app` and add
   `https://<your-site>.netlify.app/auth/callback` to Redirect URLs (add
   `https://*--<your-site>.netlify.app/**` if you want deploy previews to sign in too).
4. Deploy, then sign up on the site.

**Function time limit.** Netlify stops a server function after a fixed time (60 seconds on current plans
per recent sources; older Netlify docs say 10, extendable to 26 on paid plans; check your plan). One chat
answer can need several model calls, so the server stops starting new calls after
`AGENT_REQUEST_BUDGET_MS` (35 s) and the browser continues the answer with a follow-up request
automatically. If a request is still cut off, the work so far is saved and the chat shows a Continue
button. If you see that often, set `AGENT_EFFORT=low` (faster calls) or lower the budget. Hosts without a
short limit (Vercel Pro, Render, Railway, a VPS) can raise the budget to 240000.

Stripe, when you turn billing on: point a webhook at `https://<your-site>.netlify.app/api/stripe/webhook`.
