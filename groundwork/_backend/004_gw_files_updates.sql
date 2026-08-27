-- ============================================================
-- Groundwork — client files + activity timeline
-- Mirrors the DeSmit portal pattern, keyed on gw_owns_client instead of
-- project access.
--   gw_files    — shared file/photo attachments per client (client uploads too)
--   gw_updates  — studio-posted activity/progress notes (client reads)
-- Storage bucket: gw-attachments (private). Access = admin OR gw_owns_client.
-- ============================================================

-- ---------- files ----------
create table if not exists public.gw_files (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.gw_clients(id) on delete cascade,
  uploaded_by    uuid references auth.users(id) on delete set null,
  storage_path   text not null unique,
  filename       text,
  mime           text,
  size_bytes     bigint,
  client_visible boolean not null default true,
  created_at     timestamptz not null default now()
);
alter table public.gw_files enable row level security;
create index if not exists gw_files_client_idx on public.gw_files(client_id);

create or replace function public.gw_guard_file_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then
    new.uploaded_by := auth.uid();
    if not public.dd_is_admin() then
      if not public.gw_owns_client(new.client_id) then
        raise exception 'not your account';
      end if;
      new.client_visible := true;
    end if;
  end if;
  if new.storage_path is null
     or new.storage_path not like new.client_id::text || '/%' then
    raise exception 'invalid storage path for client';
  end if;
  return new;
end; $$;
drop trigger if exists gw_files_guard_insert on public.gw_files;
create trigger gw_files_guard_insert before insert on public.gw_files
  for each row execute function public.gw_guard_file_insert();

drop policy if exists gw_files_select on public.gw_files;
create policy gw_files_select on public.gw_files
  for select using (public.dd_is_admin() or (client_visible and public.gw_owns_client(client_id)));
drop policy if exists gw_files_insert on public.gw_files;
create policy gw_files_insert on public.gw_files
  for insert with check (public.dd_is_admin() or public.gw_owns_client(client_id));
drop policy if exists gw_files_update on public.gw_files;
create policy gw_files_update on public.gw_files
  for update using (public.dd_is_admin()) with check (public.dd_is_admin());
drop policy if exists gw_files_delete on public.gw_files;
create policy gw_files_delete on public.gw_files
  for delete using (public.dd_is_admin() or (uploaded_by = auth.uid() and public.gw_owns_client(client_id)));

-- ---------- storage bucket + policies (names gwobj_* — distinct from dd_/onb_) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gw-attachments', 'gw-attachments', false, 26214400, null)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists gwobj_select on storage.objects;
create policy gwobj_select on storage.objects
  for select using (
    bucket_id = 'gw-attachments'
    and (public.dd_is_admin() or exists (
      select 1 from public.gw_files f
      where f.storage_path = storage.objects.name
        and f.client_visible and public.gw_owns_client(f.client_id)))
  );
drop policy if exists gwobj_insert on storage.objects;
create policy gwobj_insert on storage.objects
  for insert with check (
    bucket_id = 'gw-attachments'
    and (public.dd_is_admin() or public.gw_owns_client(
      case when (storage.foldername(name))[1] ~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           then ((storage.foldername(name))[1])::uuid end))
  );
drop policy if exists gwobj_delete on storage.objects;
create policy gwobj_delete on storage.objects
  for delete using (
    bucket_id = 'gw-attachments'
    and (public.dd_is_admin() or exists (
      select 1 from public.gw_files f
      where f.storage_path = storage.objects.name
        and f.uploaded_by = auth.uid() and public.gw_owns_client(f.client_id)))
  );

-- ---------- activity timeline (studio posts, client reads) ----------
create table if not exists public.gw_updates (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.gw_clients(id) on delete cascade,
  author_id      uuid references auth.users(id) on delete set null,
  body           text not null,
  client_visible boolean not null default true,
  created_at     timestamptz not null default now()
);
alter table public.gw_updates enable row level security;
create index if not exists gw_updates_client_idx on public.gw_updates(client_id);

drop policy if exists gw_updates_select on public.gw_updates;
create policy gw_updates_select on public.gw_updates
  for select using (public.dd_is_admin() or (client_visible and public.gw_owns_client(client_id)));
drop policy if exists gw_updates_admin_write on public.gw_updates;
create policy gw_updates_admin_write on public.gw_updates
  for all using (public.dd_is_admin()) with check (public.dd_is_admin());

-- ---------- realtime + hardening ----------
do $$ begin alter publication supabase_realtime add table public.gw_files; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.gw_updates; exception when duplicate_object then null; end $$;
revoke execute on function public.gw_guard_file_insert() from public, anon, authenticated;
