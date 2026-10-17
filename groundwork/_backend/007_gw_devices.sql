-- ============================================================
-- Groundwork — Text-Back Android app: paired phones (2026-10-17)
--
-- Backs the `gw-device` Edge Function. A client's own Android phone texts
-- missed callers from the owner's number and reports each missed call here.
--
--   gw_pairing_codes  6-digit, single-use, 10-minute codes an admin generates
--                     (gw_create_pairing_code). Only the SHA-256 is stored.
--   gw_devices        one row per paired phone. The app holds a long-lived
--                     token; only its SHA-256 is stored. revoked_at set =
--                     the phone stops texting on its next call (D9).
--
-- Admin-only RLS on both tables; the Edge Function uses the service role.
-- Requires 006 (gw_messages.external_id) — events upsert on it.
-- ============================================================

create table if not exists public.gw_devices (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.gw_clients(id) on delete cascade,
  label        text,                       -- "Daniel's Pixel"; set by the app at pairing
  token_hash   text not null unique,       -- hex SHA-256 of the device token
  app_version  text,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
alter table public.gw_devices enable row level security;
create index if not exists gw_devices_client_idx on public.gw_devices(client_id);

drop policy if exists gw_devices_admin_all on public.gw_devices;
create policy gw_devices_admin_all on public.gw_devices
  for all using (public.dd_is_admin()) with check (public.dd_is_admin());

create table if not exists public.gw_pairing_codes (
  id         uuid primary key default gen_random_uuid(),
  code_hash  text not null,                -- hex SHA-256 of the 6 digits
  client_id  uuid not null references public.gw_clients(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '10 minutes',
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
alter table public.gw_pairing_codes enable row level security;
-- At most one live code per value, so a code always names exactly one client.
create unique index if not exists gw_pairing_codes_open_key
  on public.gw_pairing_codes(code_hash) where used_at is null;

drop policy if exists gw_pairing_codes_admin_all on public.gw_pairing_codes;
create policy gw_pairing_codes_admin_all on public.gw_pairing_codes
  for all using (public.dd_is_admin()) with check (public.dd_is_admin());

-- Admin "Pair a phone": returns the plaintext code once; only the hash is kept.
-- Replaces any earlier unused code for the client and sweeps expired ones.
create or replace function public.gw_create_pairing_code(p_client uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_code text;
begin
  if not public.dd_is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  delete from public.gw_pairing_codes
    where used_at is null and (client_id = p_client or expires_at < now());
  for i in 1..10 loop
    -- gen_random_uuid() is a CSPRNG; 32 bits mod 1e6 has negligible bias.
    v_code := lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint)
      % 1000000)::text, 6, '0');
    begin
      insert into public.gw_pairing_codes (code_hash, client_id)
        values (encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), p_client);
      return v_code;
    exception when unique_violation then
      -- another client holds this code right now; draw again
    end;
  end loop;
  raise exception 'could not allocate a pairing code';
end; $$;
revoke execute on function public.gw_create_pairing_code(uuid) from anon, public;
grant execute on function public.gw_create_pairing_code(uuid) to authenticated;

