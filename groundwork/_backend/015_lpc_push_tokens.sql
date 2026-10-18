-- ============================================================
-- Lost Pines app — push notification tokens (2026-10-18)
--
-- When a signed-in owner taps "Turn on call alerts", the app stores its Expo
-- push token here. gw-reception (service role) reads the tokens of the
-- business owner when a call ends and sends one notification per call
-- (gw_messages.meta.pushed); tokens Expo reports as DeviceNotRegistered are
-- deleted. Signing out deletes the phone's token.
--
-- A token belongs to one phone; if someone else signs in on that phone the
-- row moves to them (upsert by token), so alerts follow the person signed in.
-- ============================================================

create table if not exists public.lpc_push_tokens (
  token        text primary key check (token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$'),
  user_id      uuid not null references auth.users(id) on delete cascade,
  platform     text not null check (platform in ('ios', 'android')),
  app_version  text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists lpc_push_tokens_user_idx on public.lpc_push_tokens(user_id);
alter table public.lpc_push_tokens enable row level security;

-- Owners manage only their own phone's token. Reads by others (the receptionist)
-- go through the service role.
drop policy if exists lpc_push_tokens_own on public.lpc_push_tokens;
create policy lpc_push_tokens_own on public.lpc_push_tokens
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Register (or re-claim) this phone's token for the signed-in user. SECURITY
-- DEFINER so a phone that changed hands can move a token row it no longer owns.
create or replace function public.lpc_register_push(p_token text, p_platform text, p_app_version text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.lpc_push_tokens (token, user_id, platform, app_version)
  values (p_token, auth.uid(), p_platform, left(p_app_version, 40))
  on conflict (token) do update
    set user_id = auth.uid(), platform = excluded.platform,
        app_version = excluded.app_version, last_seen_at = now();
end;
$$;
revoke all on function public.lpc_register_push(text, text, text) from public, anon;
grant execute on function public.lpc_register_push(text, text, text) to authenticated;
