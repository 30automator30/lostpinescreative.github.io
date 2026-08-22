-- ============================================================
-- Security remediation from the Fable red-team review (2026-08-22).
-- Cross-cutting: DeSmit (dd_*) + Groundwork (gw_*) + the shared AI endpoints.
-- Applied live to project ekogelnbhggyrychfrta as migration
-- `security_remediation_redteam` + edge-function rate limiting.
--
-- Findings closed:
--  CRITICAL  unverified-email account takeover  -> link ownership on email
--            CONFIRMATION, not raw signup INSERT. (Keep "Confirm email" ON.)
--  MEDIUM    project member could re-share       -> owner/admin only.
--  LOW       griefing/lockout of pending clients -> same link-on-confirm fix.
--  HIGH      AI endpoints gated only on forgeable Origin -> per-IP/global rate
--            limits in the edge functions, backed by public.ai_call_log below.
-- ============================================================

-- (1) Auto-link ownership only once mailbox control is proven (email confirmed).
create or replace function public.dd_handle_new_user()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.dd_profiles (id, email, full_name)
  values (new.id, new.email, nullif(new.raw_user_meta_data->>'full_name',''))
  on conflict (id) do update set email = excluded.email;

  -- Under Confirm-email ON, email_confirmed_at is null at signup: nothing links here.
  if new.email_confirmed_at is not null then
    update public.dd_project_shares set user_id = new.id
      where user_id is null and lower(email) = lower(new.email);
    update public.gw_clients set owner_id = new.id
      where owner_id is null and lower(owner_email) = lower(new.email);
  end if;
  return new;
end; $$;

-- Fires when a user's email transitions to confirmed -> do the ownership link then.
create or replace function public.dd_handle_user_confirmed()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.email_confirmed_at is not null and old.email_confirmed_at is null then
    update public.dd_project_shares set user_id = new.id
      where user_id is null and lower(email) = lower(new.email);
    update public.gw_clients set owner_id = new.id
      where owner_id is null and lower(owner_email) = lower(new.email);
  end if;
  return new;
end; $$;

drop trigger if exists dd_on_auth_user_confirmed on auth.users;
create trigger dd_on_auth_user_confirmed
  after update of email_confirmed_at on auth.users
  for each row execute function public.dd_handle_user_confirmed();

-- (2) Share = owner or admin only (dropped the dd_is_project_member re-share clause).
--     Bind user_id only to a CONFIRMED account; otherwise it links on confirmation.
create or replace function public.dd_share_project(p_project uuid, p_email text)
returns void language plpgsql security definer set search_path='' as $$
declare v_email text := lower(trim(p_email)); v_uid uuid;
begin
  if not (public.dd_owns_project(p_project) or public.dd_is_admin()) then
    raise exception 'not allowed to share this project';
  end if;
  if v_email = '' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'please enter a valid email';
  end if;
  select id into v_uid from auth.users
    where lower(email) = v_email and email_confirmed_at is not null;
  insert into public.dd_project_shares (project_id, email, user_id, invited_by)
  values (p_project, v_email, v_uid, auth.uid())
  on conflict (project_id, email)
    do update set user_id = coalesce(excluded.user_id, public.dd_project_shares.user_id);
end; $$;

-- (3) Rate-limit ledger for the public AI endpoints (gw-assistant / ai-receptionist).
--     Written/read only by the edge functions via the service-role key.
create table if not exists public.ai_call_log (
  id         bigint generated always as identity primary key,
  fn         text not null,
  ip         text,
  created_at timestamptz not null default now()
);
create index if not exists ai_call_log_fn_ip_time on public.ai_call_log (fn, ip, created_at desc);
create index if not exists ai_call_log_fn_time    on public.ai_call_log (fn, created_at desc);
alter table public.ai_call_log enable row level security;
-- No policies: anon/authenticated get deny; edge functions use the service-role key.
