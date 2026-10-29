# Jobs AI — Plan

An AI job concierge on top of the scraped jobs database. A person signs up, uploads a resume, says
what they want (kind of work, location, hours, pay), and a Claude agent searches the live jobs table
and hands back a ranked, tiered shortlist, then keeps working with them like a normal chatbot.
Pay as you go: credits bought in packs from $5, every model call metered and shown.

This document is the handoff. It states the decisions, the data model, the agent design, the
billing model and the build order so another engineer (or model) can continue without re-deriving.

## 1. What exists today

Supabase project **jobs-ai** (`xrbnekghcswgotsauxok`, us-east-1, Postgres 17):

| Object | Rows | Notes |
|---|---|---|
| `jobs` | 1,769 | One row per listing. Public read. `tags text[]` in `family:value` form, `fts` tsvector, `salary_annual_est`, `region`, `schedule`, `gender_pref`, contacts. |
| `sources` | 11 | 6 weekly papers, 5 websites. |
| `runs` | 67 | Scrape log. RLS on, no policy (server only). |
| `active_jobs`, `active_jobs_dedup` | views | Seen in the last 14 days; dedup collapses the same ad across papers by `content_hash`. |
| `user_profiles` | 0 | Per-user name, notes, `filters jsonb`. RLS: own rows. |
| `user_job_status` | 0 | Per-user tracking: interested / applied / interviewing / rejected / hidden, notes, rating. RLS: own rows. |
| `search_jobs(...)` | function | Free text + categories + tag include/exclude + regions + gender + sources + found_since + min_pay + exclude_contacts, dedup, paging, hides the caller's hidden/rejected jobs via `auth.uid()`. |

Taxonomy (from the scraping sheet): `cat:` (35 categories), `sched:` (full-time, part-time,
flexible-hours, mornings, afternoons, evenings, weekends, kollel-hours, temp-seasonal), `mode:`
(remote, hybrid), `gender:` (women, men), `lang:` (yiddish, hebrew, russian, spanish), `frum:`
(shomer-shabbos, heimish-environment, yeshiva-school), `level:` (entry-level, experienced, senior),
`req:` (degree, license-cert, car-license, computer-skills), `perk:` (benefits, commission-bonus,
great-pay, growth), `region:` (lakewood, brooklyn, nyc-other, long-island, rockland, nj-other,
remote, other, unknown), `src:` (print, web), `kw:` (free keywords).

Active listings today: Brooklyn 736, Lakewood 563, Rockland 200, other/unknown 135, NYC-other 52,
remote 38, NJ-other 25, Long Island 20. About a third state pay. Data refreshes weekday mornings
from the local master database; this app only reads `jobs`.

The repo `mydira/jobs-ai` was empty apart from a README.

## 2. Decisions

| Area | Decision | Why |
|---|---|---|
| Framework | Next.js 16 (App Router, TypeScript, Tailwind) in `web/` | One deployable, server routes for the agent and webhooks, streams well. |
| Auth | Supabase Auth, email + password and magic link, `@supabase/ssr` cookies | Already the data store; RLS gives per-user isolation for free. |
| Model | `claude-opus-5-5`, adaptive thinking, `effort: medium` by default | Best match quality per dollar; medium is the documented starting point on this model. Haiku 5.5 is the lever if cost per turn must fall. |
| Agent style | Manual tool loop with streaming, server-side in a route handler | Full control over metering, credit cut-off mid-turn, and SSE to the UI. |
| Results shape | A `present_jobs` tool the model calls with tiers | The UI renders cards from structured tool input instead of parsing prose; the tier hierarchy is guaranteed. |
| Interview | Per-conversation mode, off by default | The user asked for it as an option, not the default. Toggled by an append-only system message so the cache and thinking blocks stay valid. |
| Credits | Balance in micro-dollars; every API call priced from a rate table × a configurable markup; one ledger row per assistant turn, per-call detail kept | Full transparency: users see tokens and dollars per answer. |
| Payments | Stripe Checkout, packs $5 / $10 / $20 / $50, webhook grants credits idempotently | Minimum $5 as requested; Checkout avoids handling card data. |
| Resume | Private Storage bucket, text extracted server-side, raw text goes into the conversation context | No extra extraction call to pay for; the model reads the resume itself and records a structured profile through a tool. |
| Conversation history | Stored as the exact Anthropic content blocks, append-only | Required for prompt caching and for Claude 5.5's preserved-thinking check (history edits can 400 on newer accounts). |

## 3. Architecture

```
Browser (Next.js pages)
  │  cookies (Supabase session)
  ▼
Next.js server (web/)
  ├─ /api/chat          POST  → agent loop, SSE stream back        ──► Anthropic API (claude-opus-5-5)
  │     tools run here with the user's Supabase client (RLS)       ──► Supabase: search_jobs, jobs, user_profiles, user_job_status
  │     usage → price → debit_credits() (service role RPC)         ──► Supabase: credit_accounts, credit_ledger, agent_calls
  ├─ /api/resume        POST  → Storage upload + text extraction   ──► Supabase Storage (private bucket "resumes"), resumes table
  ├─ /api/stripe/checkout POST → Stripe Checkout session
  ├─ /api/stripe/webhook  POST → grant_credits() on checkout.session.completed
  └─ /auth/callback     GET   → magic-link code exchange
```

Request path for one chat turn:

1. Route verifies the session, loads the conversation, checks the credit balance is above the
   per-turn reserve (default $0.05). If not, returns `402` with the balance.
2. Builds `messages` from stored rows. First user turn carries the candidate context (profile +
   resume text) as its first text block. Mode changes and profile updates since the last turn are
   appended as `role: "system"` messages after the newest user message (never edited into the past).
3. Streams `claude-opus-5-5` with the fixed tool list. Text deltas, tool activity and job cards are
   forwarded to the browser as SSE events. Each tool call runs against Supabase with the user's
   client. Up to 8 model calls per turn.
4. After each model call: usage → cost; if the balance is now exhausted the loop stops after that
   call and the UI shows an "out of credits" state (the answer so far is kept).
5. At the end: rows for every assistant/tool-result block, one `agent_calls` row per model call,
   one `credit_ledger` usage row for the turn, and the conversation title on its first turn.

## 4. Data model (new, all in `public`, RLS on)

```
credit_accounts   user_id pk → auth.users, balance_micros bigint, lifetime_purchased_micros,
                  lifetime_spent_micros, updated_at
credit_ledger     id, user_id, kind (purchase|usage|adjustment|refund|welcome), amount_micros (signed),
                  balance_after_micros, conversation_id, message_id, model, input_tokens,
                  cache_read_tokens, cache_write_tokens, output_tokens, calls, ref (stripe id), note, created_at
credit_purchases  id, user_id, stripe_checkout_session_id unique, stripe_payment_intent,
                  amount_cents, credits_micros, status (pending|paid|failed|refunded), created_at, paid_at
conversations     id uuid, user_id, title, mode (chat|interview), running bool, archived bool,
                  context_version int, created_at, updated_at
messages          id uuid, conversation_id, user_id, seq int, role (user|assistant), kind
                  (user|assistant|tool_result|system), content jsonb (Anthropic blocks), ui jsonb,
                  cost_micros, usage jsonb, created_at
agent_calls       id, user_id, conversation_id, message_id, call_index, model, effort, input_tokens,
                  cache_read_tokens, cache_write_tokens, output_tokens, cost_micros, stop_reason,
                  duration_ms, created_at
resumes           id, user_id, storage_path, filename, mime, bytes, text, is_current, created_at
user_profiles     + preferences jsonb, interview_insights text, updated_at, unique(user_id)
storage.buckets   resumes (private)
```

Functions:

- `debit_credits(p_user uuid, p_amount_micros bigint, p_meta jsonb) returns bigint` — security definer,
  atomic `update … set balance = balance - amount`, inserts the ledger row, returns the new balance.
  Allows the balance to go negative for the turn that exhausts it (the cost is only known after the
  call); the next turn is refused until a reload.
- `grant_credits(p_user uuid, p_amount_micros bigint, p_kind text, p_ref text, p_note text) returns bigint`
  — security definer; used by the Stripe webhook and for welcome credits / manual adjustments.
- `job_facets(q, regions, categories, any_tags, gender, min_pay) returns jsonb` — counts of active
  de-duplicated jobs by region, category, schedule and work mode under the given filters, so the
  agent can say what the market looks like before it narrows.
- `ensure_credit_account()` — trigger on `auth.users` insert creates the account row (and grants the
  optional welcome credit).

The advisor warning about `rls_auto_enable()` being executable by `anon` is fixed in the same migration
(revoke execute).

## 5. The agent

**Model call:** `claude-opus-5-5`, streaming, `thinking: { type: "adaptive" }` (always on for this
model), `output_config: { effort: "medium" }` (env-overridable), `max_tokens: 16000`, tools
`strict: true`, deterministic tool order, one explicit `cache_control` breakpoint on the system prompt
and automatic caching on the conversation tail. Refusals (`stop_reason: "refusal"`) are surfaced as
a plain message, never retried silently.

**System prompt (frozen, shared by every user so it caches across users):** who it is, the taxonomy
above with exact tag strings, how `search_jobs` behaves (active only, dedup, FTS over title/summary/
description), the tier definitions, honesty rules (every job it names must come from a tool result
in this conversation, cite by id, never invent pay or contacts), search strategy (orient with
`job_facets`, then 1–3 targeted searches, widen when thin), how to treat gender-targeted ads (respect
`gender_pref`; never assume the user's gender, ask or read the profile), community context (kollel
hours, Yiddish, Lakewood/Brooklyn/Monsey geography, papers vs websites, `times_seen` as a hard-to-fill
signal), interview-mode behaviour, and response format.

**Tiers** (the hierarchy the user asked for), produced through `present_jobs`:

| Tier | Meaning |
|---|---|
| `perfect` | Matches role, location, hours and pay floor; the resume supports it. |
| `strong` | One soft mismatch (commute, hours slightly off, pay unstated). |
| `possible` | A stretch or a pivot: transferable skills, needs a reframed resume or a conversation. |
| `fallback` | Pays the bills now: quick-start roles in the area that fit the constraints if nothing else lands. |

Each entry carries `why` (two sentences max, grounded in the listing and the resume) and
`concerns`. The UI groups cards by tier and shows apply details on expand.

**Tools** (declared on every request from the first one):

| Tool | Reads/writes | Purpose |
|---|---|---|
| `job_facets` | RPC | Counts under filters: "there are 61 part-time office jobs in Lakewood". |
| `search_jobs` | RPC `search_jobs` | Compact rows (~100 tokens each, max 40): id, title, company, place, schedule, mode, pay, summary, tags without `kw:`, source, dates, `times_seen`. |
| `get_job` | `jobs` | Full description, how to apply, contact, URL for one id. |
| `present_jobs` | none (UI) | The tiered shortlist. Returns "rendered" so the model then writes a short narrative. |
| `update_candidate_profile` | `user_profiles.preferences`, `interview_insights` | Merge what it learned: target roles, locations, hours, pay floor, dealbreakers, strengths, insights. |
| `mark_job` | `user_job_status` | interested / applied / hidden / rejected + note, when the user says so. |

**Context injection, append-only:** the first user message of a conversation is
`[candidate context: profile JSON + resume text (≤ 12k chars) + today's date + mode]` followed by the
user's text. When the profile, resume or mode changes later, the route appends
`{ role: "system", content: "Updated candidate context: …" }` after the next user message.
Nothing earlier is ever rewritten.

**Interview mode** (per conversation, user-toggled, off by default): one question at a time, six to
ten questions, probing past the stated target: what they were good at and liked in past roles,
constraints they treat as fixed that may not be, pay floor vs. wish, commute radius, schedule, growth
vs. stability, what they would never do. It records insights with `update_candidate_profile`, then
runs the normal search and presents tiers, naming the options the person did not ask for but should
consider.

**Cost per turn (estimate at list price):** system prompt ≈ 3k tokens (cached after the first call),
context ≈ 2k, one search result ≈ 4k, thinking + answer ≈ 2–3k output. First turn ≈ $0.09, later turns
≈ $0.05–0.12. With a 1.5× markup a $5 pack is roughly 30–60 turns.

## 6. Credits and transparency

- Unit: micro-dollars (`1_000_000 = $1.00`), displayed as dollars with cents, four decimals on the ledger.
- Rate table (per million tokens, Claude Opus 5.5): input 4.00, cache write 5.00, cache read 0.20,
  output 20.00. Haiku 5.5 and Sonnet 5.5 rows included for a later switch.
- `CREDIT_MARKUP` env (default `1.5`) multiplies the list price; the credits page shows the effective
  rates so there is nothing hidden. Stripe's fee on a $5 pack is about $0.45; the markup covers it.
- Packs: $5, $10, $20, $50 → credits equal to the amount paid.
- Every assistant reply shows its cost; the credits page lists every ledger row with model, tokens
  (input / cached / output) and dollars; purchases appear with their Stripe reference.
- Low-balance banner under $1; a `402` from the chat route opens the reload panel with the balance.
- `WELCOME_CREDIT_CENTS` (default 0) lets you give new accounts a trial amount.

## 7. Repository layout

```
docs/PLAN.md                      this file
supabase/migrations/*.sql         every migration applied to the project (also applied live)
web/                              Next.js app
  src/app/(marketing)/page.tsx    landing
  src/app/login, /signup          auth pages
  src/app/auth/callback/route.ts  magic link exchange
  src/app/app/...                 signed-in area: chat, profile, credits
  src/app/api/chat/route.ts       the agent
  src/app/api/resume/route.ts     upload + extraction
  src/app/api/stripe/*            checkout + webhook
  src/lib/supabase/*              browser / server / service clients
  src/lib/agent/*                 prompt, tools, loop, pricing
  src/lib/credits.ts              debit / grant helpers
  src/components/*                chat UI, job cards, credit widgets
  .env.example                    every variable with a comment
```

## 8. Build order

| Phase | Deliverable | Status |
|---|---|---|
| 0 | This plan | done |
| 1 | Migrations: credits, conversations, messages, resumes, agent_calls, RPCs, bucket, advisor fix | done, applied live (`supabase/migrations/20261028190000_app_core.sql`) |
| 2 | Next.js scaffold, Supabase auth (password + magic link), protected shell, profile page | done |
| 3 | Agent: prompt, tools, streaming loop, metering, chat UI with tiered cards and cost chips | done |
| 4 | Resume upload and extraction (PDF, DOCX, TXT, paste) | done |
| 5 | Credits: Stripe Checkout, webhook, balance header, ledger page, out-of-credits flow | done |
| 6 | Typecheck, build, smoke test against the live DB, README with setup, push | typecheck, lint and build pass; see Verification status |

## 8a. Verification status (2026-10-28)

Done in the build environment:

- `pnpm typecheck`, `pnpm lint`, `pnpm build` all pass (Next 16.4.3, Anthropic SDK 1.3.0, Supabase SSR 0.12).
- `job_facets`, `search_jobs`, the credit RPCs and the storage bucket were exercised with SQL against the live
  project (facets for Lakewood office jobs: 83; a bookkeeper search: 29 rows).

Not yet run end to end, because the build sandbox's network policy blocks `*.supabase.co` and `api.stripe.com`
and holds no Anthropic key. First run on a normal machine should do, in order:

1. `pnpm smoke` (needs only network): confirms the PostgREST argument names for `search_jobs` / `job_facets`.
2. Sign up, upload a resume, send one message with interview mode off; check the ledger row, the `agent_calls`
   rows and that `cache_read_input_tokens` is non-zero from the second call onward.
3. Toggle interview mode on in the same conversation and send a message; the context note should be appended
   (a `system` row in `messages`) and the model should start asking questions.
4. Buy a $5 pack with a Stripe test card; the webhook should flip the purchase to `paid` and add the ledger row.
5. Spend the balance down to confirm the 402 path and the mid-turn stop.

## 8b. Testing phase changes (2026-10-29)

- **Free testing.** `BILLING_ENABLED` (default `false`) turns charging off: no balance check, no debit,
  checkout disabled, UI shows "Free testing". Usage is still metered: `agent_calls` rows as before, and each
  request writes a zero-amount `usage` ledger row whose note carries what it would have cost. Turning billing
  on is only the env change plus Stripe.
- **Resumable turns.** Hosts like Netlify stop a function after a fixed time. `runTurn` now stops starting
  new model calls once `AGENT_REQUEST_BUDGET_MS` (35 s) has passed and ends the stream with
  `needsContinue: true`; the browser posts `{ continue: true }` and the loop resumes from the stored messages
  (up to 6 follow-ups per message, `AGENT_MAX_CALLS` still caps model calls per message). The assistant row
  and its tool results are inserted together, so a killed request never leaves an unanswered `tool_use`.
  A conversation whose last row is not an assistant reply has an unfinished turn; the page shows Continue.
  The conversation lock is treated as abandoned after budget + 90 s.
- **Origin.** Email and Checkout links use `NEXT_PUBLIC_SITE_URL`, else Netlify's `URL`, else the request host.
- **Netlify.** `netlify.toml` at the repo root (base `web`, `pnpm build`, Node 22). If turns are cut off too
  often on Netlify, the next step is to run the agent loop in a Netlify Background Function (15 min) that
  writes events to a table the browser reads; the stored-message design already supports it.

## 9. Setup the owner must do (cannot be done from this environment)

1. **Anthropic key** → `ANTHROPIC_API_KEY`.
2. **Supabase service role key** → `SUPABASE_SERVICE_ROLE_KEY` (Dashboard → Settings → API). URL and
   publishable key are already in `.env.example`.
3. **Supabase Auth**: add the site URL and `https://<host>/auth/callback` to Redirect URLs; keep email
   confirmations on. Optional: customise the magic-link template.
4. **Stripe**: create the account, set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and point a webhook
   at `/api/stripe/webhook` for `checkout.session.completed`. Test with `stripe listen --forward-to`.
5. **Deploy** on Netlify per the README (`netlify.toml` is in the repo). Long turns stream and continue
   across requests, so the client sees progress within a second.

## 10. Later (not in this build)

- Daily "new matches" email after the 8 AM sync, using the saved profile (pg_cron + edge function or a
  Vercel cron).
- Semantic search with pgvector embeddings over `summary + description` next to the FTS.
- A cheaper pre-ranking stage (Haiku 5.5 scoring 200 candidates to 40) if turn cost needs to fall.
- Admin page: users, spend, top searches, zero-result queries (to feed the scraper/taxonomy).
- Evals: a fixed set of resume + request pairs with expected top jobs to measure prompt changes.
- Hide contact details behind sign-in or behind a paid tier (noted in the sheet as a possibility).
