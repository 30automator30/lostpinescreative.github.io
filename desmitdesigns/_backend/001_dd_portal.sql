-- ============================================================
-- DeSmit Designs — customer portal + admin schema
-- Target: a DEDICATED Supabase project (not shared with Blue Plumeria).
-- All objects are namespaced dd_ so this is safe even if ever co-located.
--
-- Apply once via the Supabase MCP apply_migration, the CLI, or the
-- dashboard SQL editor. Idempotent where practical.
-- ============================================================

-- ---------- enums ----------
do $$ begin
  create type public.dd_project_status as enum
    ('requested','quoted','approved','in_progress','review','complete','cancelled');
exception when duplicate_object then null; end $$;

-- ---------- profiles (one row per auth user) ----------
create table if not exists public.dd_profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  phone      text,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.dd_profiles add column if not exists email text;
alter table public.dd_profiles enable row level security;

-- Admin check as SECURITY DEFINER so RLS policies on other tables can call it
-- without recursing into dd_profiles' own policies.
create or replace function public.dd_is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists(
    select 1 from public.dd_profiles p
    where p.id = auth.uid() and p.is_admin
  );
$$;

-- Create a profile automatically when a user signs up.
create or replace function public.dd_handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.dd_profiles (id, email, full_name)
  values (new.id, new.email, nullif(new.raw_user_meta_data->>'full_name',''))
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;
drop trigger if exists dd_on_auth_user_created on auth.users;
create trigger dd_on_auth_user_created
  after insert on auth.users
  for each row execute function public.dd_handle_new_user();

-- Stop a non-admin from granting themselves admin via an update.
create or replace function public.dd_guard_profile()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  -- Block only a logged-in NON-admin from flipping the flag. A null auth.uid()
  -- means service-role / SQL editor (the one-time bootstrap) — allow that.
  if new.is_admin is distinct from old.is_admin
     and auth.uid() is not null
     and not public.dd_is_admin() then
    raise exception 'not authorized to change admin status';
  end if;
  return new;
end;
$$;
drop trigger if exists dd_guard_profile_update on public.dd_profiles;
create trigger dd_guard_profile_update
  before update on public.dd_profiles
  for each row execute function public.dd_guard_profile();

drop policy if exists dd_profiles_select_own on public.dd_profiles;
create policy dd_profiles_select_own on public.dd_profiles
  for select using (id = auth.uid() or public.dd_is_admin());

drop policy if exists dd_profiles_update_own on public.dd_profiles;
create policy dd_profiles_update_own on public.dd_profiles
  for update using (id = auth.uid() or public.dd_is_admin())
  with check (id = auth.uid() or public.dd_is_admin());

-- ---------- projects ----------
create table if not exists public.dd_projects (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null references auth.users(id) on delete cascade,
  title            text not null,
  service_type     text,
  description      text,
  status           public.dd_project_status not null default 'requested',
  quote_amount     numeric(10,2),
  quote_notes      text,
  progress_percent int not null default 0 check (progress_percent between 0 and 100),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table public.dd_projects enable row level security;
create index if not exists dd_projects_customer_idx on public.dd_projects(customer_id);
create index if not exists dd_projects_status_idx on public.dd_projects(status);

-- keep updated_at fresh
create or replace function public.dd_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists dd_projects_touch on public.dd_projects;
create trigger dd_projects_touch before update on public.dd_projects
  for each row execute function public.dd_touch_updated_at();

-- A customer may only ever CREATE a plain request for themselves: force the
-- safe fields regardless of what the client sends. Admins are unrestricted.
create or replace function public.dd_guard_project_insert()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.dd_is_admin() then
    new.customer_id      := auth.uid();
    new.status           := 'requested';
    new.quote_amount     := null;
    new.quote_notes      := null;
    new.progress_percent := 0;
  end if;
  return new;
end;
$$;
drop trigger if exists dd_projects_guard_insert on public.dd_projects;
create trigger dd_projects_guard_insert before insert on public.dd_projects
  for each row execute function public.dd_guard_project_insert();

drop policy if exists dd_projects_select on public.dd_projects;
create policy dd_projects_select on public.dd_projects
  for select using (customer_id = auth.uid() or public.dd_is_admin());

drop policy if exists dd_projects_insert on public.dd_projects;
create policy dd_projects_insert on public.dd_projects
  for insert with check (customer_id = auth.uid() or public.dd_is_admin());

-- Only admins update/delete projects directly. Customers change state through
-- the dd_approve_quote() RPC below.
drop policy if exists dd_projects_admin_update on public.dd_projects;
create policy dd_projects_admin_update on public.dd_projects
  for update using (public.dd_is_admin()) with check (public.dd_is_admin());

drop policy if exists dd_projects_admin_delete on public.dd_projects;
create policy dd_projects_admin_delete on public.dd_projects
  for delete using (public.dd_is_admin());

-- ---------- progress updates / message thread ----------
create table if not exists public.dd_project_updates (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.dd_projects(id) on delete cascade,
  author_id        uuid references auth.users(id) on delete set null,
  body             text not null,
  percent          int check (percent between 0 and 100),
  customer_visible boolean not null default true,
  created_at       timestamptz not null default now()
);
alter table public.dd_project_updates enable row level security;
create index if not exists dd_updates_project_idx on public.dd_project_updates(project_id);

-- Customers may post notes on their own projects, but cannot set an internal
-- (hidden) flag or a progress percent. Admins are unrestricted.
create or replace function public.dd_guard_update_insert()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.author_id := auth.uid();
  if not public.dd_is_admin() then
    if not exists (
      select 1 from public.dd_projects p
      where p.id = new.project_id and p.customer_id = auth.uid()
    ) then
      raise exception 'not your project';
    end if;
    new.percent := null;
    new.customer_visible := true;
  end if;
  return new;
end;
$$;
drop trigger if exists dd_updates_guard_insert on public.dd_project_updates;
create trigger dd_updates_guard_insert before insert on public.dd_project_updates
  for each row execute function public.dd_guard_update_insert();

drop policy if exists dd_updates_select on public.dd_project_updates;
create policy dd_updates_select on public.dd_project_updates
  for select using (
    public.dd_is_admin()
    or (customer_visible and exists (
      select 1 from public.dd_projects p
      where p.id = project_id and p.customer_id = auth.uid()
    ))
  );

drop policy if exists dd_updates_insert on public.dd_project_updates;
create policy dd_updates_insert on public.dd_project_updates
  for insert with check (
    public.dd_is_admin()
    or exists (
      select 1 from public.dd_projects p
      where p.id = project_id and p.customer_id = auth.uid()
    )
  );

-- ---------- inquiries (public leads captured by the AI assistant) ----------
create table if not exists public.dd_inquiries (
  id           uuid primary key default gen_random_uuid(),
  name         text,
  email        text,
  message      text,
  kind         text,
  service_type text,
  status       text not null default 'new',
  meta         jsonb,
  created_at   timestamptz not null default now()
);
alter table public.dd_inquiries enable row level security;
-- Inserts arrive from the dd-assistant Edge Function using the service-role
-- key, which bypasses RLS. Only admins may read/manage them from the client.
drop policy if exists dd_inquiries_admin_all on public.dd_inquiries;
create policy dd_inquiries_admin_all on public.dd_inquiries
  for all using (public.dd_is_admin()) with check (public.dd_is_admin());

-- ---------- customer-driven state change: approve a quote ----------
create or replace function public.dd_approve_quote(p_project uuid)
returns public.dd_projects
language plpgsql security definer set search_path = ''
as $$
declare
  proj public.dd_projects;
begin
  select * into proj from public.dd_projects
  where id = p_project and customer_id = auth.uid()
  for update;

  if not found then
    raise exception 'project not found';
  end if;
  if proj.status <> 'quoted' then
    raise exception 'project is not awaiting approval';
  end if;

  update public.dd_projects
    set status = 'approved'
    where id = p_project
    returning * into proj;

  insert into public.dd_project_updates (project_id, author_id, body, customer_visible)
  values (p_project, auth.uid(), 'Customer approved the quote.', true);

  return proj;
end;
$$;
grant execute on function public.dd_approve_quote(uuid) to authenticated;

-- ---------- realtime ----------
-- Live updates in the customer portal and admin console.
do $$ begin
  alter publication supabase_realtime add table public.dd_projects;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.dd_project_updates;
exception when duplicate_object then null; end $$;

-- ---------- hardening: keep trigger functions out of the REST API ----------
-- Triggers still fire regardless of EXECUTE grants, so revoking is safe and
-- removes the "public can execute SECURITY DEFINER function" advisor warnings.
-- dd_is_admin() stays executable (RLS policies evaluate it as anon/authenticated)
-- and dd_approve_quote() stays executable by authenticated (quote approval).
revoke execute on function public.dd_touch_updated_at() from public, anon, authenticated;
revoke execute on function public.dd_handle_new_user() from public, anon, authenticated;
revoke execute on function public.dd_guard_profile() from public, anon, authenticated;
revoke execute on function public.dd_guard_project_insert() from public, anon, authenticated;
revoke execute on function public.dd_guard_update_insert() from public, anon, authenticated;

-- ============================================================
-- ONE-TIME ADMIN BOOTSTRAP (run AFTER Daniel signs in once):
--   update public.dd_profiles set is_admin = true
--   where id = (select id from auth.users where email = 'desmitdesignz@gmail.com');
-- ============================================================
