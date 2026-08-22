-- ============================================================
-- Agent Build Standard v1.2 remediation — DB side (2026-08-22).
-- Applied live as migration `agent_standard_killswitch_retention`.
-- Pairs with the rebuilt gw-assistant / ai-receptionist edge functions.
--
--  DEP-05  runtime kill switch: public.ai_config.enabled per function, checked
--          each request. Flip it (admin) to take an agent offline with no deploy.
--  PRIV-02 retention: nightly pg_cron job purges the rate-log after 2 days and
--          strips stored conversation transcripts from inquiry rows after 180 days.
-- ============================================================

create table if not exists public.ai_config (
  fn         text primary key,
  enabled    boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.ai_config enable row level security;
drop policy if exists ai_config_admin_all on public.ai_config;
create policy ai_config_admin_all on public.ai_config
  for all using (public.dd_is_admin()) with check (public.dd_is_admin());
insert into public.ai_config (fn, enabled) values ('gw-assistant', true), ('dd-assistant', true)
  on conflict (fn) do nothing;

-- To take an agent offline (admin, SQL editor or the /ops style dashboard):
--   update public.ai_config set enabled = false where fn = 'gw-assistant';

create extension if not exists pg_cron;

create or replace function public.ai_retention_purge()
returns void language sql security definer set search_path='' as $$
  delete from public.ai_call_log where created_at < now() - interval '2 days';
  update public.gw_inquiries set meta = meta - 'transcript'
    where created_at < now() - interval '180 days' and meta ? 'transcript';
  update public.dd_inquiries set meta = meta - 'transcript'
    where created_at < now() - interval '180 days' and meta ? 'transcript';
$$;
revoke execute on function public.ai_retention_purge() from anon, authenticated, public;

select cron.schedule('ai_retention_purge', '19 3 * * *', $$select public.ai_retention_purge()$$);
