-- ============================================================
-- Lost Pines — in-app account deletion (2026-10-17)
--
-- Backs the `lpc-delete-account` Edge Function (Apple 5.1.1(v): deletion
-- starts and finishes in the app). Deleting an auth user on its own would
-- cascade-delete a client's whole Groundwork setup (gw_clients.owner_id is
-- `on delete cascade`), so the function first calls lpc_delete_account_data(),
-- which in ONE transaction:
--
--   Groundwork  detaches, never destroys: owner_id/owner_email -> null on every
--               business the user owns (or is pending to own by email), and
--               revokes their phones. The business record, line, inbox,
--               reports and files stay for the studio to close out.
--   DeSmit      deletes the user's own projects (updates, milestones, file rows
--               cascade) and removes them from projects shared with them, by
--               user id AND email, so a re-signup with the same email isn't
--               silently re-granted access.
--   Onboarding  (if installed) detaches, never destroys: the signed agreement,
--               payment status and Stripe ids on onb_intakes, and the brand
--               files in onb_assets, are business records. owner_id -> null;
--               the studio email lists any Stripe subscription to close out
--               (nothing is cancelled automatically).
--   Files       queues the deleted projects' storage objects in
--               lpc_storage_purge; the function removes them from storage and
--               clears the queue. Anything left there is retried / visible.
--
-- Then the function deletes the auth user (dd_profiles cascade; lpc_requests
-- keep the requester's email). Email matches only count for a confirmed email,
-- the same rule as gw_owns_client (005).
-- Every step is idempotent, so a failed run is finished by running it again.
-- Studio admin accounts are refused.
-- ============================================================

create table if not exists public.lpc_storage_purge (
  bucket          text not null,
  path            text not null,
  deleted_user_id uuid not null,
  queued_at       timestamptz not null default now(),
  primary key (bucket, path)
);
alter table public.lpc_storage_purge enable row level security;
-- No policies: service role only.

-- Onboarding (onboarding/_backend/010) is optional here: when present, its
-- owner links must be nullable so a deletion can detach instead of cascade.
do $$ begin
  if to_regclass('public.onb_intakes') is not null then
    alter table public.onb_intakes alter column owner_id drop not null;
    alter table public.onb_intakes drop constraint if exists onb_intakes_owner_id_fkey;
    alter table public.onb_intakes add constraint onb_intakes_owner_id_fkey
      foreign key (owner_id) references auth.users(id) on delete set null;
  end if;
  if to_regclass('public.onb_assets') is not null then
    alter table public.onb_assets alter column owner_id drop not null;
    alter table public.onb_assets drop constraint if exists onb_assets_owner_id_fkey;
    alter table public.onb_assets add constraint onb_assets_owner_id_fkey
      foreign key (owner_id) references auth.users(id) on delete set null;
  end if;
end $$;

create or replace function public.lpc_delete_account_data(p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_email text;
  v_clients jsonb;
  v_projects int;
  v_intakes jsonb := '[]'::jsonb;
begin
  if exists (select 1 from public.dd_profiles where id = p_user and is_admin) then
    raise exception 'studio admin accounts cannot be deleted here' using errcode = '42501';
  end if;
  select lower(email) into v_email from auth.users where id = p_user and email_confirmed_at is not null;

  -- Groundwork: revoke phones, then detach the businesses.
  update public.gw_devices d set revoked_at = now()
    where d.revoked_at is null
      and (d.registered_by = p_user or d.client_id in (
        select c.id from public.gw_clients c
        where c.owner_id = p_user or (c.owner_id is null and v_email is not null and lower(c.owner_email) = v_email)));
  with detached as (
    update public.gw_clients c set owner_id = null, owner_email = null
      where c.owner_id = p_user or (c.owner_id is null and v_email is not null and lower(c.owner_email) = v_email)
      returning c.business_name)
  select coalesce(jsonb_agg(business_name order by business_name), '[]'::jsonb) into v_clients from detached;

  -- DeSmit: queue the files, delete own projects, drop shares.
  insert into public.lpc_storage_purge (bucket, path, deleted_user_id)
    select 'dd-attachments', f.storage_path, p_user
    from public.dd_project_files f join public.dd_projects p on p.id = f.project_id
    where p.customer_id = p_user
    on conflict do nothing;
  delete from public.dd_projects where customer_id = p_user;
  get diagnostics v_projects = row_count;
  delete from public.dd_project_shares
    where user_id = p_user or (v_email is not null and lower(email) = v_email);

  -- Onboarding: detach intakes + assets (kept as business records).
  if to_regclass('public.onb_intakes') is not null then
    execute $q$
      with d as (
        update public.onb_intakes set owner_id = null where owner_id = $1
        returning business_name, pay_status::text, stripe_subscription_id)
      select coalesce(jsonb_agg(jsonb_build_object('business_name', business_name,
        'pay_status', pay_status, 'stripe_subscription_id', stripe_subscription_id)), '[]'::jsonb) from d
    $q$ into v_intakes using p_user;
  end if;
  if to_regclass('public.onb_assets') is not null then
    execute 'update public.onb_assets set owner_id = null where owner_id = $1' using p_user;
  end if;

  return jsonb_build_object('detached_clients', v_clients, 'deleted_projects', v_projects,
    'detached_intakes', v_intakes);
end; $$;
revoke execute on function public.lpc_delete_account_data(uuid) from anon, authenticated, public;
grant execute on function public.lpc_delete_account_data(uuid) to service_role;
