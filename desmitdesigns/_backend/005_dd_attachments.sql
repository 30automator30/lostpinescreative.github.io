-- ============================================================
-- DeSmit Designs — project attachments (photos + files)
-- Adds file/photo uploads to portal projects. Files live in the private
-- Storage bucket `dd-attachments`; `dd_project_files` holds the metadata.
--
-- SECURITY MODEL (differs from onboarding on purpose):
--   onboarding files are single-owner, so its storage RLS keys on
--   foldername[1] = auth.uid(). Project attachments are MULTI-PARTY — the
--   admin uploads files the CUSTOMER must download, projects are shared with
--   multiple members, and some admin files are internal-only. So access keys
--   on PROJECT membership (dd_can_access_project) and honors customer_visible,
--   NOT on uploader identity.
--
-- Reviewed (adversarial DR, 2026-08-27) — folds in: explicit RLS enable;
-- null-uid (service-role) exemption in the guard; CASE-guarded uuid cast in
-- the storage insert policy; dd_obj_* policy names (must not collide with
-- onboarding's onb_obj_*); non-admin delete also requires current access.
--
-- Apply once (idempotent where practical) via apply_migration / SQL editor.
-- ============================================================

-- ---------- metadata table (files themselves live in Storage) ----------
create table if not exists public.dd_project_files (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.dd_projects(id) on delete cascade,
  uploaded_by      uuid references auth.users(id) on delete set null,
  storage_path     text not null unique,          -- <project_id>/<uuid>-name.ext in bucket dd-attachments
  filename         text,
  mime             text,
  size_bytes       bigint,
  customer_visible boolean not null default true,  -- admin may post internal-only files
  created_at       timestamptz not null default now()
);
alter table public.dd_project_files enable row level security;
create index if not exists dd_files_project_idx on public.dd_project_files(project_id);

-- Guard: force uploaded_by, gate non-admins to projects they can access, and
-- bind the metadata claim to the object path the storage INSERT policy already
-- validated. The path prefix + UNIQUE(storage_path) + admin-only UPDATE are the
-- only thing stopping a member from registering ANOTHER project's object as
-- their own visible file — do not remove them or relax UPDATE to non-admins.
create or replace function public.dd_guard_file_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- A null auth.uid() is the service role / SQL editor (backfills, edge fns) —
  -- trusted; leave the row as-is (mirrors dd_guard_profile / onb_guard_asset).
  if auth.uid() is not null then
    new.uploaded_by := auth.uid();
    if not public.dd_is_admin() then
      if not public.dd_can_access_project(new.project_id) then
        raise exception 'not your project';
      end if;
      new.customer_visible := true;  -- clients/members can't post internal files
    end if;
  end if;
  -- The object MUST live under this project's folder. project_id is a uuid, so
  -- it contains no LIKE metacharacters (% or _).
  if new.storage_path is null
     or new.storage_path not like new.project_id::text || '/%' then
    raise exception 'invalid storage path for project';
  end if;
  return new;
end; $$;
drop trigger if exists dd_files_guard_insert on public.dd_project_files;
create trigger dd_files_guard_insert before insert on public.dd_project_files
  for each row execute function public.dd_guard_file_insert();

-- ---------- table RLS ----------
drop policy if exists dd_files_select on public.dd_project_files;
create policy dd_files_select on public.dd_project_files
  for select using (
    public.dd_is_admin()
    or (customer_visible and public.dd_can_access_project(project_id))
  );

drop policy if exists dd_files_insert on public.dd_project_files;
create policy dd_files_insert on public.dd_project_files
  for insert with check (
    public.dd_is_admin() or public.dd_can_access_project(project_id)
  );

-- Only admin may UPDATE (e.g. flip customer_visible). Never open this to
-- non-admins: there is no UPDATE guard trigger, so a client UPDATE could
-- re-point storage_path past the insert-time prefix check (DR finding 3).
drop policy if exists dd_files_update on public.dd_project_files;
create policy dd_files_update on public.dd_project_files
  for update using (public.dd_is_admin()) with check (public.dd_is_admin());

drop policy if exists dd_files_delete on public.dd_project_files;
create policy dd_files_delete on public.dd_project_files
  for delete using (
    public.dd_is_admin()
    or (uploaded_by = auth.uid() and public.dd_can_access_project(project_id))
  );

-- ---------- Storage bucket ----------
-- allowed_mime_types NULL on purpose: STL/STEP/ZIP arrive as
-- application/octet-stream or empty, so an allowlist is cosmetic. Instead the
-- CLIENT renders inline only image/* (except svg) and signs every other file
-- with { download } so it lands as an attachment, never rendered on the
-- Supabase origin (DR finding 6). Private bucket + 25 MB cap + RLS.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dd-attachments', 'dd-attachments', false, 26214400, null)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Storage RLS. Names are dd_obj_* so they never clobber onboarding's onb_obj_*.
-- Every clause keeps bucket_id = 'dd-attachments' because permissive policies on
-- storage.objects OR together across buckets.

-- READ: admin, or a project member for whom a VISIBLE metadata row names this
-- object. Repeating customer_visible here means a member cannot sign a URL for
-- an internal file even if they somehow learn its path.
drop policy if exists dd_obj_select on storage.objects;
create policy dd_obj_select on storage.objects
  for select using (
    bucket_id = 'dd-attachments'
    and (
      public.dd_is_admin()
      or exists (
        select 1 from public.dd_project_files f
        where f.storage_path = storage.objects.name
          and f.customer_visible
          and public.dd_can_access_project(f.project_id)
      )
    )
  );

-- WRITE: path-based (the metadata row does not exist yet). The CASE guards the
-- uuid cast so a non-uuid first segment yields NULL (a clean deny) instead of a
-- 22P02 error — and because SQL OR does not short-circuit, this also keeps
-- admin uploads on utility paths from throwing.
drop policy if exists dd_obj_insert on storage.objects;
create policy dd_obj_insert on storage.objects
  for insert with check (
    bucket_id = 'dd-attachments'
    and (
      public.dd_is_admin()
      or public.dd_can_access_project(
        case when (storage.foldername(name))[1] ~*
             '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             then ((storage.foldername(name))[1])::uuid end
      )
    )
  );

-- DELETE: admin, or the uploader who still has access. Removing the object must
-- happen BEFORE deleting the metadata row (this policy needs the row present).
drop policy if exists dd_obj_delete on storage.objects;
create policy dd_obj_delete on storage.objects
  for delete using (
    bucket_id = 'dd-attachments'
    and (
      public.dd_is_admin()
      or exists (
        select 1 from public.dd_project_files f
        where f.storage_path = storage.objects.name
          and f.uploaded_by = auth.uid()
          and public.dd_can_access_project(f.project_id)
      )
    )
  );

-- ---------- realtime ----------
do $$ begin
  alter publication supabase_realtime add table public.dd_project_files;
exception when duplicate_object then null; end $$;

-- ---------- hardening ----------
-- Trigger fires regardless of EXECUTE grants; revoking removes the advisor
-- warning about a public-executable SECURITY DEFINER function.
revoke execute on function public.dd_guard_file_insert() from public, anon, authenticated;

-- ============================================================
-- ORPHAN / QUOTA NOTE (DR finding 5):
--   storage.objects has no FK to dd_projects, so deleting a project cascades
--   the metadata rows but strands its objects. The admin console's project
--   delete therefore storage.list()s '<project_id>/' and remove()s the objects
--   BEFORE deleting the project. The path-based insert policy also lets a member
--   upload objects without a metadata row (orphans) into a project they access;
--   for this client base that is acceptable — an admin can sweep objects that
--   have no dd_project_files row if it ever matters.
-- ============================================================
