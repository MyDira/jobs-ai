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

## Deploy

Vercel (or any Node host). Set the same environment variables. The chat route streams and declares
`maxDuration = 300`; on Vercel that needs a plan that allows it (Pro / Fluid compute). Point the Stripe
webhook and the Supabase redirect URL at the production origin.
