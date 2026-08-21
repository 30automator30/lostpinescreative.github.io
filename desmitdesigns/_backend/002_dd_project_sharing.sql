-- ============================================================
-- DeSmit Designs — project sharing
-- Let a customer share a project/quote with other people (e.g. a partner).
-- Shared users sign in with their own email and see the SAME project in
-- their portal: view status/quote, approve, and comment. Sharing works even
-- before the invitee has an account — the share attaches on their first
-- sign-in (by email).
-- ============================================================

-- ---------- who-can-see helpers (SECURITY DEFINER to avoid RLS recursion) ----------
create table if not exists public.dd_project_shares (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.dd_projects(id) on delete cascade,
  email      text not null,
  user_id    uuid references auth.users(id) on delete set null,
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (project_id, email)
);
alter table public.dd_project_shares enable row level security;
create index if not exists dd_shares_user_idx on public.dd_project_shares(user_id);
create index if not exists dd_shares_project_idx on public.dd_project_shares(project_id);

create or replace function public.dd_is_project_member(p_project uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from public.dd_project_shares s
    where s.project_id = p_project and s.user_id = auth.uid()
  );
$$;

create or replace function public.dd_owns_project(p_project uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from public.dd_projects p
    where p.id = p_project and p.customer_id = auth.uid()
  );
$$;

create or replace function public.dd_can_access_project(p_project uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.dd_owns_project(p_project) or public.dd_is_project_member(p_project);
$$;

-- These are evaluated inside RLS policies as anon/authenticated, so they must
-- stay executable by those roles.
grant execute on function public.dd_is_project_member(uuid)  to anon, authenticated;
grant execute on function public.dd_owns_project(uuid)       to anon, authenticated;
grant execute on function public.dd_can_access_project(uuid) to anon, authenticated;

-- ---------- widen project + update visibility to include shared members ----------
drop policy if exists dd_projects_select on public.dd_projects;
create policy dd_projects_select on public.dd_projects
  for select using (
    customer_id = auth.uid()
    or public.dd_is_admin()
    or public.dd_is_project_member(id)
  );

drop policy if exists dd_updates_select on public.dd_project_updates;
create policy dd_updates_select on public.dd_project_updates
  for select using (
    public.dd_is_admin()
    or (customer_visible and public.dd_can_access_project(project_id))
  );

drop policy if exists dd_updates_insert on public.dd_project_updates;
create policy dd_updates_insert on public.dd_project_updates
  for insert with check (
    public.dd_is_admin() or public.dd_can_access_project(project_id)
  );

-- Members (not just the owner) may post notes; still can't set percent or hide.
create or replace function public.dd_guard_update_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.author_id := auth.uid();
  if not public.dd_is_admin() then
    if not public.dd_can_access_project(new.project_id) then
      raise exception 'not your project';
    end if;
    new.percent := null;
    new.customer_visible := true;
  end if;
  return new;
end;
$$;

-- Owner OR a shared member may approve the quote.
create or replace function public.dd_approve_quote(p_project uuid)
returns public.dd_projects language plpgsql security definer set search_path = '' as $$
declare proj public.dd_projects;
begin
  select * into proj from public.dd_projects
  where id = p_project and (customer_id = auth.uid() or public.dd_is_project_member(id))
  for update;
  if not found then raise exception 'project not found'; end if;
  if proj.status <> 'quoted' then raise exception 'project is not awaiting approval'; end if;

  update public.dd_projects set status = 'approved' where id = p_project returning * into proj;
  insert into public.dd_project_updates (project_id, author_id, body, customer_visible)
  values (p_project, auth.uid(), 'Quote approved.', true);
  return proj;
end;
$$;
grant execute on function public.dd_approve_quote(uuid) to authenticated;

-- Attach any pending shares (invited by email before they had an account) when
-- the invitee signs in for the first time.
create or replace function public.dd_handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.dd_profiles (id, email, full_name)
  values (new.id, new.email, nullif(new.raw_user_meta_data->>'full_name',''))
  on conflict (id) do update set email = excluded.email;

  update public.dd_project_shares
    set user_id = new.id
    where user_id is null and lower(email) = lower(new.email);
  return new;
end;
$$;

-- ---------- RLS on the shares table ----------
-- Owner, admin, or the invited user themselves can see a share row. All writes
-- go through the SECURITY DEFINER RPCs below (which bypass RLS), so no client
-- insert/update policy is needed.
drop policy if exists dd_shares_select on public.dd_project_shares;
create policy dd_shares_select on public.dd_project_shares
  for select using (
    public.dd_is_admin()
    or user_id = auth.uid()
    or public.dd_owns_project(project_id)
  );

drop policy if exists dd_shares_admin_all on public.dd_project_shares;
create policy dd_shares_admin_all on public.dd_project_shares
  for all using (public.dd_is_admin()) with check (public.dd_is_admin());

-- ---------- share / unshare RPCs ----------
create or replace function public.dd_share_project(p_project uuid, p_email text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(trim(p_email)); v_uid uuid;
begin
  if not (public.dd_owns_project(p_project) or public.dd_is_admin()
          or public.dd_is_project_member(p_project)) then
    raise exception 'not allowed to share this project';
  end if;
  if v_email = '' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'please enter a valid email';
  end if;
  select id into v_uid from auth.users where lower(email) = v_email;
  insert into public.dd_project_shares (project_id, email, user_id, invited_by)
  values (p_project, v_email, v_uid, auth.uid())
  on conflict (project_id, email)
    do update set user_id = coalesce(excluded.user_id, public.dd_project_shares.user_id);
end;
$$;
grant execute on function public.dd_share_project(uuid, text) to authenticated;

create or replace function public.dd_unshare_project(p_project uuid, p_email text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not (public.dd_owns_project(p_project) or public.dd_is_admin()) then
    raise exception 'not allowed';
  end if;
  delete from public.dd_project_shares
  where project_id = p_project and lower(email) = lower(trim(p_email));
end;
$$;
grant execute on function public.dd_unshare_project(uuid, text) to authenticated;
