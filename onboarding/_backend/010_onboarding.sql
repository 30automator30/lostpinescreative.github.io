-- ============================================================
-- Lost Pines Creative — shared CLIENT ONBOARDING schema
--
-- One onboarding "engine" used by BOTH the DeSmit Designs and Groundwork
-- portals. All objects are namespaced onb_ so they sit safely alongside the
-- existing dd_* and gw_* tables in the SAME Supabase project
-- (ekogelnbhggyrychfrta).
--
-- Apply once via the Supabase MCP apply_migration, the CLI, or the dashboard
-- SQL editor. Idempotent where practical — safe to re-run.
--
-- What it creates:
--   • onb_intakes  — one onboarding record per client project (business info,
--                    brand prefs, the page SPEC json, package + billing choices,
--                    contract e-signature fields, Stripe ids/status).
--   • onb_assets   — metadata for uploaded images (logo / photos / inspiration);
--                    the files themselves live in the private `onboarding` bucket.
--   • onb_events   — append-only audit log (draft saved, signed, paid, …).
--   • Storage bucket `onboarding` + RLS so a user only touches files under
--     their own <uid>/ prefix.
--   • RLS on every table (owner sees own, admin sees all) + autosave RPC.
--
-- Depends on: dd_is_admin() from 001_dd_portal.sql (already applied).
-- ============================================================

-- ---------- enums ----------
do $$ begin
  create type public.onb_status as enum
    ('draft','submitted','in_review','accepted','declined');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.onb_product as enum ('desmit','groundwork');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.onb_pay_status as enum
    ('unpaid','deposit_paid','active','past_due','canceled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.onb_sign_status as enum ('unsigned','signed');
exception when duplicate_object then null; end $$;

-- ---------- intakes ----------
-- One row per onboarding. The mutable client answers live in jsonb columns so
-- the wizard can evolve without a migration for every new field; the columns
-- that drive server logic (status, billing, contract, stripe) are typed.
create table if not exists public.onb_intakes (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users(id) on delete cascade,
  product            public.onb_product not null default 'desmit',
  status             public.onb_status not null default 'draft',

  -- section 1: about the business (also mirrored into `about` jsonb for extras)
  business_name      text,
  business_description text,
  industry           text,
  contact_name       text,
  contact_email      text,
  contact_phone      text,
  about              jsonb not null default '{}'::jsonb,

  -- section 2: brand / look. colors: ["#4a9e7e", …]; design: {layout:"minimal", …}
  brand              jsonb not null default '{}'::jsonb,

  -- section 3: the page SPECIFICATION. Shape (see spec-template.js):
  --   { sections: { hero: {include:true, dev_decides:false, notes:"…"}, … },
  --     integrations: {...}, goals:"…", must_haves:"…" }
  spec               jsonb not null default '{}'::jsonb,

  -- section 4: package + billing selections
  package            text,                 -- starter | foundation | growth | full_build | custom
  care_plan          text,                 -- none | essential | growth | partner
  billing_cycle      text default 'monthly', -- monthly | annual
  deposit_amount     numeric(10,2),        -- one-time up-front (server-authoritative on checkout)
  billing            jsonb not null default '{}'::jsonb,

  -- section 6: contract e-signature (click-through, ESIGN-style)
  sign_status        public.onb_sign_status not null default 'unsigned',
  agreement_version  text,                 -- e.g. "msa-v1"
  agreement_hash     text,                 -- sha-256 of the exact signed text
  agreement_snapshot text,                 -- the exact agreement text they saw
  signed_name        text,
  signed_at          timestamptz,
  signed_ip          text,
  signed_user_agent  text,

  -- section 7: payment (Stripe). Set by the onb-webhook function.
  pay_status         public.onb_pay_status not null default 'unpaid',
  stripe_customer_id      text,
  stripe_subscription_id  text,
  stripe_checkout_session text,

  -- link to the real project once accepted (dd_projects.id, nullable)
  project_id         uuid,

  submitted_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
alter table public.onb_intakes enable row level security;
create index if not exists onb_intakes_owner_idx on public.onb_intakes(owner_id);
create index if not exists onb_intakes_status_idx on public.onb_intakes(status);
create index if not exists onb_intakes_product_idx on public.onb_intakes(product);

-- keep updated_at fresh
create or replace function public.onb_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists onb_intakes_touch on public.onb_intakes;
create trigger onb_intakes_touch before update on public.onb_intakes
  for each row execute function public.onb_touch_updated_at();

-- Guard: a non-admin client may never set the server-authoritative fields
-- (status beyond submitted, contract proof, stripe ids, pay_status). They can
-- freely edit their own draft content; everything sensitive is forced here.
create or replace function public.onb_guard_intake()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare is_admin boolean := public.dd_is_admin();
begin
  if is_admin or auth.uid() is null then
    return new;  -- admin / service-role (edge functions) are unrestricted
  end if;

  -- on INSERT, force ownership + a clean draft
  if tg_op = 'INSERT' then
    new.owner_id  := auth.uid();
    new.status    := 'draft';
    new.sign_status := 'unsigned';
    new.pay_status  := 'unpaid';
    new.deposit_amount := null;   -- the deposit is the studio's quote, never client-set
    new.agreement_hash := null; new.agreement_snapshot := null;
    new.signed_name := null; new.signed_at := null; new.signed_ip := null;
    new.signed_user_agent := null;
    new.stripe_customer_id := null; new.stripe_subscription_id := null;
    new.stripe_checkout_session := null;
    new.project_id := null; new.submitted_at := null;
    return new;
  end if;

  -- on UPDATE, keep the client from tampering with proof/billing state.
  new.owner_id  := old.owner_id;
  new.sign_status := old.sign_status;
  new.deposit_amount := old.deposit_amount;  -- server-authoritative: only admin/service-role sets it
  new.agreement_hash := old.agreement_hash;
  new.agreement_snapshot := old.agreement_snapshot;
  new.signed_name := old.signed_name;
  new.signed_at := old.signed_at;
  new.signed_ip := old.signed_ip;
  new.signed_user_agent := old.signed_user_agent;
  new.pay_status := old.pay_status;
  new.stripe_customer_id := old.stripe_customer_id;
  new.stripe_subscription_id := old.stripe_subscription_id;
  new.stripe_checkout_session := old.stripe_checkout_session;
  new.project_id := old.project_id;
  -- the client may move draft -> submitted, but no further
  if new.status is distinct from old.status
     and not (old.status = 'draft' and new.status = 'submitted') then
    new.status := old.status;
  end if;
  if new.status = 'submitted' and old.status = 'draft' then
    new.submitted_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists onb_guard_intake_ins on public.onb_intakes;
create trigger onb_guard_intake_ins before insert on public.onb_intakes
  for each row execute function public.onb_guard_intake();
drop trigger if exists onb_guard_intake_upd on public.onb_intakes;
create trigger onb_guard_intake_upd before update on public.onb_intakes
  for each row execute function public.onb_guard_intake();

drop policy if exists onb_intakes_select on public.onb_intakes;
create policy onb_intakes_select on public.onb_intakes
  for select using (owner_id = auth.uid() or public.dd_is_admin());

drop policy if exists onb_intakes_insert on public.onb_intakes;
create policy onb_intakes_insert on public.onb_intakes
  for insert with check (owner_id = auth.uid() or public.dd_is_admin());

drop policy if exists onb_intakes_update on public.onb_intakes;
create policy onb_intakes_update on public.onb_intakes
  for update using (owner_id = auth.uid() or public.dd_is_admin())
  with check (owner_id = auth.uid() or public.dd_is_admin());

drop policy if exists onb_intakes_delete on public.onb_intakes;
create policy onb_intakes_delete on public.onb_intakes
  for delete using (
    public.dd_is_admin()
    or (owner_id = auth.uid() and status = 'draft')  -- clients may bin their own draft
  );

-- ---------- uploaded assets (metadata; files live in Storage) ----------
create table if not exists public.onb_assets (
  id           uuid primary key default gen_random_uuid(),
  intake_id    uuid not null references public.onb_intakes(id) on delete cascade,
  owner_id     uuid not null references auth.users(id) on delete cascade,
  kind         text not null default 'photo',   -- logo | photo | inspiration
  storage_path text not null,                   -- <uid>/<intake>/<uuid>-name.ext in bucket `onboarding`
  filename     text,
  mime         text,
  size_bytes   bigint,
  created_at   timestamptz not null default now()
);
alter table public.onb_assets enable row level security;
create index if not exists onb_assets_intake_idx on public.onb_assets(intake_id);

create or replace function public.onb_guard_asset()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not public.dd_is_admin() and auth.uid() is not null then
    new.owner_id := auth.uid();
    -- an asset may only be attached to an intake the caller actually owns,
    -- otherwise a client could plant rows under another client's intake.
    if not exists (
      select 1 from public.onb_intakes i
      where i.id = new.intake_id and i.owner_id = auth.uid()
    ) then
      raise exception 'intake not found';
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists onb_guard_asset_ins on public.onb_assets;
create trigger onb_guard_asset_ins before insert on public.onb_assets
  for each row execute function public.onb_guard_asset();

drop policy if exists onb_assets_select on public.onb_assets;
create policy onb_assets_select on public.onb_assets
  for select using (owner_id = auth.uid() or public.dd_is_admin());
drop policy if exists onb_assets_insert on public.onb_assets;
create policy onb_assets_insert on public.onb_assets
  for insert with check (owner_id = auth.uid() or public.dd_is_admin());
drop policy if exists onb_assets_delete on public.onb_assets;
create policy onb_assets_delete on public.onb_assets
  for delete using (owner_id = auth.uid() or public.dd_is_admin());

-- ---------- audit events (append-only) ----------
create table if not exists public.onb_events (
  id         bigserial primary key,
  intake_id  uuid references public.onb_intakes(id) on delete cascade,
  actor_id   uuid,
  kind       text not null,             -- draft_saved | submitted | signed | deposit_paid | subscription_active | note
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.onb_events enable row level security;
create index if not exists onb_events_intake_idx on public.onb_events(intake_id);
-- clients can read events on their own intake; only admin/service-role writes.
drop policy if exists onb_events_select on public.onb_events;
create policy onb_events_select on public.onb_events
  for select using (
    public.dd_is_admin()
    or intake_id in (select id from public.onb_intakes where owner_id = auth.uid())
  );
-- Only an admin may write audit events from the browser (the admin console logs
-- deposit/status changes here). Edge functions write via the service-role key,
-- which bypasses RLS. Clients never insert events.
drop policy if exists onb_events_insert on public.onb_events;
create policy onb_events_insert on public.onb_events
  for insert with check (public.dd_is_admin());

-- ---------- Storage bucket for uploads ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('onboarding', 'onboarding', false, 15728640,
        array['image/png','image/jpeg','image/webp','image/gif','image/svg+xml','application/pdf'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- A user may only read/write objects whose path starts with their own uid.
-- storage.foldername(name)[1] is the first path segment (the <uid> prefix).
drop policy if exists onb_obj_select on storage.objects;
create policy onb_obj_select on storage.objects
  for select using (
    bucket_id = 'onboarding'
    and (public.dd_is_admin() or (storage.foldername(name))[1] = auth.uid()::text)
  );
drop policy if exists onb_obj_insert on storage.objects;
create policy onb_obj_insert on storage.objects
  for insert with check (
    bucket_id = 'onboarding'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists onb_obj_delete on storage.objects;
create policy onb_obj_delete on storage.objects
  for delete using (
    bucket_id = 'onboarding'
    and (public.dd_is_admin() or (storage.foldername(name))[1] = auth.uid()::text)
  );

-- ---------- autosave RPC ----------
-- The wizard calls this on every step to upsert the client's draft in one shot.
-- Only ever touches the caller's own intake; the guard trigger still forces the
-- server-authoritative fields, so this is safe with the anon key.
create or replace function public.onb_save_draft(
  p_intake  uuid,
  p_product public.onb_product,
  p_patch   jsonb
) returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare v_id uuid := p_intake;
begin
  if v_id is null then
    insert into public.onb_intakes (owner_id, product) values (auth.uid(), p_product)
    returning id into v_id;
  end if;

  update public.onb_intakes set
    business_name        = coalesce(p_patch->>'business_name', business_name),
    business_description = coalesce(p_patch->>'business_description', business_description),
    industry             = coalesce(p_patch->>'industry', industry),
    contact_name         = coalesce(p_patch->>'contact_name', contact_name),
    contact_email        = coalesce(p_patch->>'contact_email', contact_email),
    contact_phone        = coalesce(p_patch->>'contact_phone', contact_phone),
    about                = coalesce(p_patch->'about', about),
    brand                = coalesce(p_patch->'brand', brand),
    spec                 = coalesce(p_patch->'spec', spec),
    package              = coalesce(p_patch->>'package', package),
    care_plan            = coalesce(p_patch->>'care_plan', care_plan),
    billing_cycle        = coalesce(p_patch->>'billing_cycle', billing_cycle),
    billing              = coalesce(p_patch->'billing', billing)
  where id = v_id and owner_id = auth.uid();

  return v_id;
end;
$$;
revoke all on function public.onb_save_draft(uuid, public.onb_product, jsonb) from public;
grant execute on function public.onb_save_draft(uuid, public.onb_product, jsonb) to authenticated;

-- ---------- realtime ----------
do $$ begin
  alter publication supabase_realtime add table public.onb_intakes;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.onb_events;
exception when duplicate_object then null; end $$;
