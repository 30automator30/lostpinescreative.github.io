-- ============================================================
-- Groundwork patch: create clients by EMAIL (no pre-sign-in required)
-- The admin can create a gw_client for any email. owner_id is filled when
-- that person signs in (or immediately if they already have an account);
-- until then the client is owned/visible by matching the caller's email.
-- ============================================================

alter table public.gw_clients alter column owner_id drop not null;
alter table public.gw_clients add column if not exists owner_email text;

-- ownership now also matches an unlinked client by the caller's email
create or replace function public.gw_owns_client(p_client uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from public.gw_clients c
    where c.id = p_client and (
      c.owner_id = auth.uid()
      or (c.owner_id is null
          and lower(c.owner_email) = lower(nullif(auth.jwt() ->> 'email', '')))
    )
  );
$$;

-- the client can see their own row (linked or matched by email), admin sees all
drop policy if exists gw_clients_select on public.gw_clients;
create policy gw_clients_select on public.gw_clients
  for select using (public.gw_owns_client(id) or public.dd_is_admin());

-- link any email-only clients to the user the first time they sign in
-- (extends the shared signup handler used across DeSmit + Groundwork)
create or replace function public.dd_handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.dd_profiles (id, email, full_name)
  values (new.id, new.email, nullif(new.raw_user_meta_data->>'full_name',''))
  on conflict (id) do update set email = excluded.email;

  update public.dd_project_shares set user_id = new.id
    where user_id is null and lower(email) = lower(new.email);

  update public.gw_clients set owner_id = new.id
    where owner_id is null and lower(owner_email) = lower(new.email);
  return new;
end;
$$;
