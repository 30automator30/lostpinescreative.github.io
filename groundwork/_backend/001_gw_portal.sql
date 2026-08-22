-- ============================================================
-- Groundwork — client portal + admin schema
-- Lives in the SAME Supabase project as DeSmit Designs
-- (ekogelnbhggyrychfrta). Reuses public.dd_profiles + public.dd_is_admin()
-- for shared users/admin. All Groundwork objects are gw_-prefixed.
--
-- Model (Groundwork-tailored): each client is a BUSINESS with a care plan,
-- a set of integrations/tools we set up, monthly reports, a receptionist /
-- voicemail SETTINGS panel, and a messages inbox (voicemails / missed calls
-- / captured leads).
-- ============================================================

-- ---------- clients ----------
create table if not exists public.gw_clients (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  business_name text not null,
  contact_email text,
  phone         text,
  care_plan     text,  -- 'essential' | 'growth' | 'partner' | 'none'
  status        text not null default 'onboarding'
                  check (status in ('onboarding','active','paused','cancelled')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.gw_clients enable row level security;
create index if not exists gw_clients_owner_idx on public.gw_clients(owner_id);

-- owner check as SECURITY DEFINER (avoids RLS recursion on child tables)
create or replace function public.gw_owns_client(p_client uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from public.gw_clients c
    where c.id = p_client and c.owner_id = auth.uid()
  );
$$;
grant execute on function public.gw_owns_client(uuid) to anon, authenticated;

-- keep updated_at fresh (reuse dd_touch_updated_at from the DeSmit migration)
drop trigger if exists gw_clients_touch on public.gw_clients;
create trigger gw_clients_touch before update on public.gw_clients
  for each row execute function public.dd_touch_updated_at();

drop policy if exists gw_clients_select on public.gw_clients;
create policy gw_clients_select on public.gw_clients
  for select using (owner_id = auth.uid() or public.dd_is_admin());
drop policy if exists gw_clients_admin_write on public.gw_clients;
create policy gw_clients_admin_write on public.gw_clients
  for all using (public.dd_is_admin()) with check (public.dd_is_admin());

-- ---------- integrations (tools/services set up for a client) ----------
create table if not exists public.gw_integrations (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.gw_clients(id) on delete cascade,
  kind       text,  -- website|google|payments|invoicing|booking|crm|accounting|reviews|ai_receptionist|missed_call|automations
  label      text not null,
  status     text not null default 'planned'
               check (status in ('planned','in_progress','live','paused')),
  url        text,
  notes      text,
  sort       int not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.gw_integrations enable row level security;
create index if not exists gw_integrations_client_idx on public.gw_integrations(client_id);
drop trigger if exists gw_integrations_touch on public.gw_integrations;
create trigger gw_integrations_touch before update on public.gw_integrations
  for each row execute function public.dd_touch_updated_at();

drop policy if exists gw_integrations_select on public.gw_integrations;
create policy gw_integrations_select on public.gw_integrations
  for select using (public.gw_owns_client(client_id) or public.dd_is_admin());
drop policy if exists gw_integrations_admin_write on public.gw_integrations;
create policy gw_integrations_admin_write on public.gw_integrations
  for all using (public.dd_is_admin()) with check (public.dd_is_admin());

-- ---------- monthly reports ----------
create table if not exists public.gw_reports (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.gw_clients(id) on delete cascade,
  period     text,             -- 'YYYY-MM'
  title      text,
  summary    text,
  metrics    jsonb,            -- {calls, missed, textbacks, leads, reviews, revenue, ...}
  visible    boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.gw_reports enable row level security;
create index if not exists gw_reports_client_idx on public.gw_reports(client_id);

drop policy if exists gw_reports_select on public.gw_reports;
create policy gw_reports_select on public.gw_reports
  for select using (
    public.dd_is_admin() or (visible and public.gw_owns_client(client_id))
  );
drop policy if exists gw_reports_admin_write on public.gw_reports;
create policy gw_reports_admin_write on public.gw_reports
  for all using (public.dd_is_admin()) with check (public.dd_is_admin());

-- ---------- messages inbox (voicemails / missed calls / captured leads) ----------
create table if not exists public.gw_messages (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.gw_clients(id) on delete cascade,
  kind       text not null default 'voicemail'
               check (kind in ('voicemail','missed_call','textback','lead','form')),
  from_name  text,
  from_phone text,
  from_email text,
  body       text,             -- transcript / message
  status     text not null default 'new'
               check (status in ('new','handled','archived')),
  meta       jsonb,
  created_at timestamptz not null default now()
);
alter table public.gw_messages enable row level security;
create index if not exists gw_messages_client_idx on public.gw_messages(client_id);

drop policy if exists gw_messages_select on public.gw_messages;
create policy gw_messages_select on public.gw_messages
  for select using (public.gw_owns_client(client_id) or public.dd_is_admin());
drop policy if exists gw_messages_admin_write on public.gw_messages;
create policy gw_messages_admin_write on public.gw_messages
  for all using (public.dd_is_admin()) with check (public.dd_is_admin());

-- owners can mark their own messages handled/archived via a controlled RPC
create or replace function public.gw_set_message_status(p_msg uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_client uuid;
begin
  if p_status not in ('new','handled','archived') then
    raise exception 'invalid status';
  end if;
  select client_id into v_client from public.gw_messages where id = p_msg;
  if v_client is null then raise exception 'message not found'; end if;
  if not (public.gw_owns_client(v_client) or public.dd_is_admin()) then
    raise exception 'not allowed';
  end if;
  update public.gw_messages set status = p_status where id = p_msg;
end;
$$;
grant execute on function public.gw_set_message_status(uuid, text) to authenticated;

-- ---------- receptionist / voicemail settings (1:1 with client) ----------
create table if not exists public.gw_settings (
  client_id        uuid primary key references public.gw_clients(id) on delete cascade,
  greeting         text,
  after_hours      text,
  forward_number   text,
  textback_message text,
  hours            jsonb,
  updated_at       timestamptz not null default now()
);
alter table public.gw_settings enable row level security;
drop trigger if exists gw_settings_touch on public.gw_settings;
create trigger gw_settings_touch before update on public.gw_settings
  for each row execute function public.dd_touch_updated_at();

-- owner OR admin may read and edit the voicemail/receptionist setup
drop policy if exists gw_settings_select on public.gw_settings;
create policy gw_settings_select on public.gw_settings
  for select using (public.gw_owns_client(client_id) or public.dd_is_admin());
drop policy if exists gw_settings_upsert on public.gw_settings;
create policy gw_settings_upsert on public.gw_settings
  for insert with check (public.gw_owns_client(client_id) or public.dd_is_admin());
drop policy if exists gw_settings_update on public.gw_settings;
create policy gw_settings_update on public.gw_settings
  for update using (public.gw_owns_client(client_id) or public.dd_is_admin())
  with check (public.gw_owns_client(client_id) or public.dd_is_admin());

-- ---------- public inquiries (leads captured by the gw-assistant) ----------
create table if not exists public.gw_inquiries (
  id            uuid primary key default gen_random_uuid(),
  name          text,
  email         text,
  phone         text,
  business_name text,
  message       text,
  kind          text,
  status        text not null default 'new',
  meta          jsonb,
  created_at    timestamptz not null default now()
);
alter table public.gw_inquiries enable row level security;
drop policy if exists gw_inquiries_admin_all on public.gw_inquiries;
create policy gw_inquiries_admin_all on public.gw_inquiries
  for all using (public.dd_is_admin()) with check (public.dd_is_admin());

-- ---------- realtime ----------
do $$ begin alter publication supabase_realtime add table public.gw_clients; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.gw_integrations; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.gw_reports; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.gw_messages; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.gw_settings; exception when duplicate_object then null; end $$;

-- Admin is whoever already has dd_profiles.is_admin = true (Daniel). No extra
-- bootstrap needed — the DeSmit admin flag governs Groundwork admin too.
