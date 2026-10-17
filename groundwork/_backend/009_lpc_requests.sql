-- ============================================================
-- Lost Pines — service requests from the app and portals (2026-10-17)
--
-- One "Request a service" inbox for both brands. A signed-in customer files a
-- request; the app/portal then calls the `lpc-request-notify` Edge Function to
-- email the studio. The row is the record — a failed email never loses it, and
-- it shows on the /admin hub either way.
--
-- A DeSmit Designs *new project* still goes through dd_projects (status
-- 'requested') so the DeSmit admin flow is unchanged; this table covers
-- everything else (Groundwork changes, support, new services).
-- ============================================================

create table if not exists public.lpc_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  service     text not null check (service in ('groundwork', 'desmit')),
  kind        text not null check (kind in ('new_service', 'change', 'support', 'other')),
  client_id   uuid references public.gw_clients(id) on delete set null,  -- Groundwork business it's about
  body        text not null check (length(btrim(body)) between 1 and 4000),
  status      text not null default 'new' check (status in ('new', 'in_progress', 'done', 'declined')),
  notified_at timestamptz,             -- set by lpc-request-notify; makes the email send once
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint lpc_requests_client_is_groundwork check (client_id is null or service = 'groundwork')
);
alter table public.lpc_requests enable row level security;
create index if not exists lpc_requests_user_idx on public.lpc_requests(user_id, created_at desc);
create index if not exists lpc_requests_status_idx on public.lpc_requests(status, created_at desc);
drop trigger if exists lpc_requests_touch on public.lpc_requests;
create trigger lpc_requests_touch before update on public.lpc_requests
  for each row execute function public.dd_touch_updated_at();

-- A customer files requests as themselves, only about a business they own, and
-- only as 'new'. They read their own; admin manages all.
drop policy if exists lpc_requests_insert_own on public.lpc_requests;
create policy lpc_requests_insert_own on public.lpc_requests
  for insert with check (
    user_id = auth.uid() and status = 'new' and notified_at is null
    and (client_id is null or public.gw_owns_client(client_id))
  );
drop policy if exists lpc_requests_select_own on public.lpc_requests;
create policy lpc_requests_select_own on public.lpc_requests
  for select using (user_id = auth.uid() or public.dd_is_admin());
drop policy if exists lpc_requests_admin_write on public.lpc_requests;
create policy lpc_requests_admin_write on public.lpc_requests
  for update using (public.dd_is_admin()) with check (public.dd_is_admin());
drop policy if exists lpc_requests_admin_delete on public.lpc_requests;
create policy lpc_requests_admin_delete on public.lpc_requests
  for delete using (public.dd_is_admin());
