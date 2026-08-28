-- ============================================================
-- Groundwork — harden gw_owns_client (red-team HIGH, 2026-08-28)
--
-- The email-fallback ownership branch previously trusted the mutable JWT
-- `email` claim (`auth.jwt() ->> 'email'`), so multi-tenant isolation for the
-- ENTIRE Groundwork model (gw_files, gw_updates, gw_reports, gw_messages,
-- gw_settings, gw_integrations, gw-attachments storage) depended solely on the
-- Supabase "Confirm email" / "Secure email change" auth toggles staying ON.
--
-- Re-key the fallback to auth.users.email_confirmed_at (authoritative) so an
-- unconfirmed account can never claim a client by email even if those toggles
-- were ever disabled. Normal access is unchanged: once a user confirms their
-- email, dd_handle_user_confirmed sets gw_clients.owner_id and the owner_id
-- branch takes over. All existing users are confirmed, so nothing loses access.
-- ============================================================
create or replace function public.gw_owns_client(p_client uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from public.gw_clients c
    where c.id = p_client and (
      c.owner_id = auth.uid()
      or (c.owner_id is null and exists (
            select 1 from auth.users u
            where u.id = auth.uid()
              and u.email_confirmed_at is not null
              and lower(u.email) = lower(nullif(c.owner_email, ''))))
    )
  );
$$;
-- grants are preserved by CREATE OR REPLACE (anon + authenticated keep EXECUTE,
-- which the RLS policies require).
