-- Only the server (service role) may create accounts / grant the welcome credit.
revoke execute on function public.ensure_credit_account(uuid, bigint) from anon, authenticated, public;
