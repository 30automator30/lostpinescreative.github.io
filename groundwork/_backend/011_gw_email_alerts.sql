-- ============================================================
-- Groundwork — email alerts for new calls (2026-10-17)
--
-- gw-reception emails the client's contact email (else owner email) when the
-- AI receptionist takes a call: who called, their number, what they need, and
-- a link to the portal inbox. This is the owner's switch for it, on by
-- default; owners already read and edit their gw_settings row (RLS from 001),
-- so the portal toggles it directly.
--
-- Each call is emailed once (gw_messages.meta.emailed), at most RL_EMAIL_DAY
-- (default 50) per line per day. Requires 001 and 006.
-- ============================================================

alter table public.gw_settings add column if not exists email_alerts boolean not null default true;

-- Daily email cap counts this per client.
create index if not exists gw_messages_emailed_idx on public.gw_messages (client_id, created_at)
  where (meta ->> 'emailed') = 'true';
