-- 003_gw_inquiries_public_insert.sql
-- Let the public Groundwork "free digital audit" form (groundwork.html) write a
-- lead into gw_inquiries with the anon key. The anon key is public, so the policy
-- is deliberately tight: inserts only, forced status/kind, and length caps so the
-- open key can't be turned into an arbitrary-write primitive. Reads/updates stay
-- admin-only (see gw_inquiries_admin_all in 001_gw_portal.sql).
--
-- NOTE: this stops schema abuse, not volume. A determined bot can still POST junk
-- rows. Next hardening step = route the form through the gw-assistant Edge Function
-- with a Cloudflare Turnstile token (SEC-05), then revoke this anon insert grant.

-- Ensure the anon role can reach the table at all (RLS below is the real guard).
grant insert on public.gw_inquiries to anon;

drop policy if exists gw_inquiries_public_insert on public.gw_inquiries;
create policy gw_inquiries_public_insert on public.gw_inquiries
  for insert
  to anon, authenticated
  with check (
    status = 'new'
    and kind = 'audit'
    and char_length(coalesce(name, ''))          between 1 and 120
    and char_length(coalesce(email, ''))         between 3 and 160
    and email like '%_@_%.__%'
    and char_length(coalesce(business_name, '')) <= 160
    and char_length(coalesce(phone, ''))         <= 40
    and char_length(coalesce(message, ''))       <= 2000
  );
