-- ============================================================
-- DeSmit / Groundwork — canonical auth-linking (source of truth)
--
-- Captures the LIVE, confirmation-gated account-linking logic that had drifted
-- from the numbered migrations. `dd_handle_new_user` was redefined (without the
-- gw_clients link and without confirmation-gating) in 001_dd_portal.sql and
-- 002_dd_project_sharing.sql; the live version below supersedes those. Keep this
-- as the highest-numbered definition so a full rebuild ends on the correct one.
--
-- Design (see portal-security-posture): ownership is linked only AFTER the user
-- confirms their email — never at raw signup — which is why "Confirm email" must
-- stay ON. Signup creates the profile; the confirmation trigger does the linking.
-- ============================================================

-- Runs at signup (AFTER INSERT). Creates the profile; links only if the row is
-- already confirmed (e.g. admin-created / imported users), otherwise waits for
-- the confirmation trigger.
create or replace function public.dd_handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.dd_profiles (id, email, full_name)
  values (new.id, new.email, nullif(new.raw_user_meta_data->>'full_name',''))
  on conflict (id) do update set email = excluded.email;

  -- Under Confirm-email ON, email_confirmed_at is null at signup, so nothing links here.
  if new.email_confirmed_at is not null then
    update public.dd_project_shares set user_id = new.id
      where user_id is null and lower(email) = lower(new.email);
    update public.gw_clients set owner_id = new.id
      where owner_id is null and lower(owner_email) = lower(new.email);
  end if;
  return new;
end; $$;

-- Runs when a user confirms their email (AFTER UPDATE OF email_confirmed_at).
-- This is where email-linked project shares and gw_clients get their owner set.
create or replace function public.dd_handle_user_confirmed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.email_confirmed_at is not null and old.email_confirmed_at is null then
    update public.dd_project_shares set user_id = new.id
      where user_id is null and lower(email) = lower(new.email);
    update public.gw_clients set owner_id = new.id
      where owner_id is null and lower(owner_email) = lower(new.email);
  end if;
  return new;
end; $$;

drop trigger if exists dd_on_auth_user_created on auth.users;
create trigger dd_on_auth_user_created
  after insert on auth.users
  for each row execute function public.dd_handle_new_user();

drop trigger if exists dd_on_auth_user_confirmed on auth.users;
create trigger dd_on_auth_user_confirmed
  after update of email_confirmed_at on auth.users
  for each row execute function public.dd_handle_user_confirmed();

-- Trigger functions fire regardless of EXECUTE grants; revoking keeps them off
-- the exposed REST API and clears the "public can execute SECURITY DEFINER"
-- advisor. dd_handle_user_confirmed was hotfixed live without this revoke.
revoke execute on function public.dd_handle_new_user() from public, anon, authenticated;
revoke execute on function public.dd_handle_user_confirmed() from public, anon, authenticated;
