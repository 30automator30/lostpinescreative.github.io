-- ============================================================
-- Groundwork — AI receptionist + missed-call text-back (2026-10-17)
--
-- Backs the `gw-reception` Edge Function (Vapi server URL). One function serves
-- every client: the Vapi phone number a call arrives on picks the client.
--
--   gw_reception_lines  admin-only wiring per client (which Vapi number, which
--                       Cal.com event type, owner alert number, on/off). NOT
--                       client-editable — it controls spend and where texts go.
--   gw_settings.knowledge  client-editable "what the receptionist should know"
--                       (services, service area, FAQs, pricing ranges).
--   gw_messages.external_id  idempotency key so a Vapi retry never double-writes
--                       a call or double-sends a text-back.
-- ============================================================

create table if not exists public.gw_reception_lines (
  client_id            uuid primary key references public.gw_clients(id) on delete cascade,
  vapi_phone_number_id text unique,          -- Vapi phone-number id the call arrives on
  ai_number            text not null unique, -- the same number in E.164 (+15125550123); SMS replies route on it
  owner_alert_number   text,                 -- where lead alerts are texted (defaults to gw_settings.forward_number)
  cal_event_type_id    integer,              -- Cal.com event type to book; null = take messages only
  booking_url          text,                 -- public booking link included in text-backs
  timezone             text not null default 'America/Chicago',
  voice_id             text,                 -- Vapi voice id; null = default
  enabled              boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
alter table public.gw_reception_lines enable row level security;
drop trigger if exists gw_reception_lines_touch on public.gw_reception_lines;
create trigger gw_reception_lines_touch before update on public.gw_reception_lines
  for each row execute function public.dd_touch_updated_at();

-- admin only; the Edge Function uses the service role.
drop policy if exists gw_reception_lines_admin_all on public.gw_reception_lines;
create policy gw_reception_lines_admin_all on public.gw_reception_lines
  for all using (public.dd_is_admin()) with check (public.dd_is_admin());

alter table public.gw_settings add column if not exists knowledge text;

alter table public.gw_messages add column if not exists external_id text;
create unique index if not exists gw_messages_external_id_key
  on public.gw_messages(external_id);

-- DEP-05 kill switch row for the new function.
insert into public.ai_config (fn, enabled) values ('gw-reception', true)
  on conflict (fn) do nothing;
-- To take the receptionist offline (calls still get a text-back):
--   update public.ai_config set enabled = false where fn = 'gw-reception';

-- PRIV-02: strip call transcripts + recording links after 180 days (summary stays in body).
create or replace function public.ai_retention_purge()
returns void language sql security definer set search_path='' as $$
  delete from public.ai_call_log where created_at < now() - interval '2 days';
  update public.gw_inquiries set meta = meta - 'transcript'
    where created_at < now() - interval '180 days' and meta ? 'transcript';
  update public.dd_inquiries set meta = meta - 'transcript'
    where created_at < now() - interval '180 days' and meta ? 'transcript';
  update public.gw_messages set meta = meta - 'transcript' - 'recording_url'
    where created_at < now() - interval '180 days'
      and (meta ? 'transcript' or meta ? 'recording_url');
$$;
revoke execute on function public.ai_retention_purge() from anon, authenticated, public;
