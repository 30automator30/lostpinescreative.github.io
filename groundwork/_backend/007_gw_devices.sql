-- ============================================================
-- Groundwork — Text-Back (Lost Pines app, Android direct build): phones (2026-10-17)
--
-- Backs the `gw-device` Edge Function. A client's own Android phone texts
-- missed callers from the owner's number and reports each missed call here.
--
--   gw_devices        one row per registered phone. The owner signs into the
--                     app and the phone registers itself (gw-device /register);
--                     the app's background worker holds a long-lived token and
--                     only its SHA-256 is stored. revoked_at set = that token
--                     is dead and the phone stops texting on its next call (D9).
--   gw_settings.textback_app_enabled  the owner's on/off switch for texting
--                     from the phone (absent row = on).
--
-- Admin-only RLS; the Edge Function uses the service role.
-- Requires 006 (gw_messages.external_id) — events upsert on it.
-- Safe to re-run, and safe over an earlier draft of this file that created
-- pairing codes (they are dropped — sign-in replaced them).
-- ============================================================

create table if not exists public.gw_devices (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.gw_clients(id) on delete cascade,
  registered_by uuid references auth.users(id) on delete set null, -- the owner who signed in
  label        text,                       -- "Daniel's Pixel"; set by the app at registration
  token_hash   text not null unique,       -- hex SHA-256 of the device token
  app_version  text,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
alter table public.gw_devices add column if not exists registered_by uuid references auth.users(id) on delete set null;
alter table public.gw_devices enable row level security;
create index if not exists gw_devices_client_idx on public.gw_devices(client_id);

drop policy if exists gw_devices_admin_all on public.gw_devices;
create policy gw_devices_admin_all on public.gw_devices
  for all using (public.dd_is_admin()) with check (public.dd_is_admin());

alter table public.gw_settings add column if not exists textback_app_enabled boolean not null default true;

-- Pairing codes were replaced by signing in to the app.
drop function if exists public.gw_create_pairing_code(uuid);
drop table if exists public.gw_pairing_codes;
