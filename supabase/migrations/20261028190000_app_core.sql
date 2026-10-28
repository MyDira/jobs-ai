-- Jobs AI app core: credits, conversations, messages, resumes, agent metering, facets.
-- Applied to project xrbnekghcswgotsauxok on 2026-10-28.

-- 0. Advisor fix: the auto-RLS event trigger function must not be callable over the API.
revoke execute on function public.rls_auto_enable() from anon, authenticated, public;

-- 1. user_profiles: one row per user, structured preferences for the agent.
alter table public.user_profiles alter column name set default '';
alter table public.user_profiles
  add column if not exists preferences jsonb not null default '{}'::jsonb,
  add column if not exists interview_insights text,
  add column if not exists updated_at timestamptz not null default now();
create unique index if not exists user_profiles_user_id_key on public.user_profiles (user_id);

-- 2. Credits
create table public.credit_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  balance_micros bigint not null default 0,
  lifetime_purchased_micros bigint not null default 0,
  lifetime_spent_micros bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.credit_accounts enable row level security;
create policy "own credit account" on public.credit_accounts
  for select to authenticated using ((select auth.uid()) = user_id);

create table public.credit_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('purchase','usage','adjustment','refund','welcome')),
  amount_micros bigint not null,
  balance_after_micros bigint not null,
  conversation_id uuid,
  message_id uuid,
  model text,
  input_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  output_tokens integer not null default 0,
  calls integer not null default 0,
  ref text,
  note text,
  created_at timestamptz not null default now()
);
create index credit_ledger_user_created_idx on public.credit_ledger (user_id, created_at desc);
alter table public.credit_ledger enable row level security;
create policy "own ledger" on public.credit_ledger
  for select to authenticated using ((select auth.uid()) = user_id);

create table public.credit_purchases (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  stripe_checkout_session_id text unique,
  stripe_payment_intent text,
  amount_cents integer not null,
  credits_micros bigint not null,
  status text not null default 'pending' check (status in ('pending','paid','failed','refunded')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index credit_purchases_user_idx on public.credit_purchases (user_id, created_at desc);
alter table public.credit_purchases enable row level security;
create policy "own purchases" on public.credit_purchases
  for select to authenticated using ((select auth.uid()) = user_id);

-- 3. Conversations and messages (Anthropic content blocks stored verbatim, append-only)
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'New conversation',
  mode text not null default 'chat' check (mode in ('chat','interview')),
  running boolean not null default false,
  archived boolean not null default false,
  context_version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_user_idx on public.conversations (user_id, updated_at desc);
alter table public.conversations enable row level security;
create policy "own conversations" on public.conversations
  for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  seq integer not null,
  role text not null check (role in ('user','assistant','system')),
  kind text not null check (kind in ('user','assistant','tool_result','system')),
  content jsonb not null,
  ui jsonb,
  cost_micros bigint not null default 0,
  usage jsonb,
  created_at timestamptz not null default now(),
  unique (conversation_id, seq)
);
alter table public.messages enable row level security;
create policy "own messages" on public.messages
  for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create table public.agent_calls (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  message_id uuid,
  call_index integer not null,
  model text not null,
  effort text,
  input_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_micros bigint not null default 0,
  stop_reason text,
  duration_ms integer,
  created_at timestamptz not null default now()
);
create index agent_calls_user_idx on public.agent_calls (user_id, created_at desc);
alter table public.agent_calls enable row level security;
create policy "own agent calls" on public.agent_calls
  for select to authenticated using ((select auth.uid()) = user_id);

-- 4. Resumes
create table public.resumes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  storage_path text,
  filename text not null,
  mime text,
  bytes integer,
  text text not null,
  is_current boolean not null default true,
  created_at timestamptz not null default now()
);
create index resumes_user_idx on public.resumes (user_id, created_at desc);
alter table public.resumes enable row level security;
create policy "own resumes" on public.resumes
  for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('resumes', 'resumes', false, 10485760,
        array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain','text/markdown'])
on conflict (id) do nothing;
create policy "own resume files read" on storage.objects for select to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own resume files write" on storage.objects for insert to authenticated
  with check (bucket_id = 'resumes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own resume files delete" on storage.objects for delete to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- 5. Credit functions (security definer; the only write path into accounts and ledger)
create or replace function public.ensure_credit_account(p_user uuid, p_welcome_micros bigint default 0)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_balance bigint;
begin
  insert into public.credit_accounts (user_id) values (p_user) on conflict (user_id) do nothing;
  if found and p_welcome_micros > 0 then
    update public.credit_accounts set balance_micros = balance_micros + p_welcome_micros, updated_at = now()
      where user_id = p_user returning balance_micros into v_balance;
    insert into public.credit_ledger (user_id, kind, amount_micros, balance_after_micros, note)
      values (p_user, 'welcome', p_welcome_micros, v_balance, 'Welcome credit');
  end if;
  select balance_micros into v_balance from public.credit_accounts where user_id = p_user;
  return v_balance;
end $$;
revoke execute on function public.ensure_credit_account(uuid, bigint) from anon, public;

create or replace function public.grant_credits(p_user uuid, p_amount_micros bigint, p_kind text, p_ref text default null, p_note text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_balance bigint;
begin
  if p_amount_micros <= 0 then raise exception 'amount must be positive'; end if;
  if p_kind not in ('purchase','adjustment','refund','welcome') then raise exception 'bad kind %', p_kind; end if;
  insert into public.credit_accounts (user_id) values (p_user) on conflict (user_id) do nothing;
  update public.credit_accounts
    set balance_micros = balance_micros + p_amount_micros,
        lifetime_purchased_micros = lifetime_purchased_micros + case when p_kind = 'purchase' then p_amount_micros else 0 end,
        updated_at = now()
    where user_id = p_user returning balance_micros into v_balance;
  insert into public.credit_ledger (user_id, kind, amount_micros, balance_after_micros, ref, note)
    values (p_user, p_kind, p_amount_micros, v_balance, p_ref, p_note);
  return v_balance;
end $$;
revoke execute on function public.grant_credits(uuid, bigint, text, text, text) from anon, authenticated, public;

create or replace function public.debit_credits(p_user uuid, p_amount_micros bigint, p_meta jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_balance bigint;
begin
  if p_amount_micros < 0 then raise exception 'amount must be non-negative'; end if;
  insert into public.credit_accounts (user_id) values (p_user) on conflict (user_id) do nothing;
  update public.credit_accounts
    set balance_micros = balance_micros - p_amount_micros,
        lifetime_spent_micros = lifetime_spent_micros + p_amount_micros,
        updated_at = now()
    where user_id = p_user returning balance_micros into v_balance;
  insert into public.credit_ledger (user_id, kind, amount_micros, balance_after_micros, conversation_id, message_id, model,
                                    input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, calls, note)
    values (p_user, 'usage', -p_amount_micros, v_balance,
            nullif(p_meta->>'conversation_id','')::uuid, nullif(p_meta->>'message_id','')::uuid, p_meta->>'model',
            coalesce((p_meta->>'input_tokens')::int,0), coalesce((p_meta->>'cache_read_tokens')::int,0),
            coalesce((p_meta->>'cache_write_tokens')::int,0), coalesce((p_meta->>'output_tokens')::int,0),
            coalesce((p_meta->>'calls')::int,0), p_meta->>'note');
  return v_balance;
end $$;
revoke execute on function public.debit_credits(uuid, bigint, jsonb) from anon, authenticated, public;

-- 6. Market facets for the agent: counts of active, de-duplicated jobs under filters.
create or replace function public.job_facets(
  q text default null, regions text[] default null, categories text[] default null,
  any_tags text[] default null, gender text default null, min_pay numeric default null)
returns jsonb language sql stable set search_path = '' as $$
  with base as (
    select distinct on (coalesce(j.content_hash, j.uid)) j.*
    from public.jobs j
    where j.last_seen >= current_date - 14
      and (categories is null or j.tags && array(
            select case when c like 'cat:%' then c else 'cat:' || c end from unnest(categories) c))
      and (any_tags is null or j.tags && any_tags)
      and (regions is null or j.region = any (regions))
      and (gender is null or coalesce(j.gender_pref, 'any') <>
            case gender when 'women' then 'men' when 'men' then 'women' else '' end)
      and (min_pay is null or j.salary_annual_est >= min_pay)
      and (q is null or j.fts @@ websearch_to_tsquery('english', q))
    order by coalesce(j.content_hash, j.uid), j.found_date desc, j.id
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'with_stated_pay', (select count(*) from base where salary_annual_est is not null),
    'regions', (select coalesce(jsonb_agg(jsonb_build_object('key', k, 'n', n) order by n desc), '[]'::jsonb)
                from (select coalesce(region,'unknown') k, count(*) n from base group by 1) r),
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('key', k, 'n', n) order by n desc), '[]'::jsonb)
                   from (select coalesce(category,'cat:other') k, count(*) n from base group by 1) r),
    'schedules', (select coalesce(jsonb_agg(jsonb_build_object('key', k, 'n', n) order by n desc), '[]'::jsonb)
                  from (select t k, count(*) n from base, unnest(tags) t where t like 'sched:%' group by 1) r),
    'work_modes', (select coalesce(jsonb_agg(jsonb_build_object('key', k, 'n', n) order by n desc), '[]'::jsonb)
                   from (select coalesce(work_mode,'onsite') k, count(*) n from base group by 1) r)
  );
$$;
