-- ============================================================
-- Onboarding → in-service BRIDGE
--
-- Connects an accepted onboarding intake (onb_intakes) to a Groundwork
-- in-service client record (gw_clients) so the studio never re-keys the client
-- and nothing captured at onboarding is stranded.
--
-- Adds billing/link columns to gw_clients, then a single admin-only RPC that,
-- on accept, provisions the gw_clients record + seeds gw_integrations from the
-- chosen spec + creates an empty settings row + links the intake forward.
--
-- Depends on: 010_onboarding.sql (onb_*) and 001/002 gw_portal (gw_*), all in
-- the same project (ekogelnbhggyrychfrta). Idempotent; safe to re-run.
-- ============================================================

-- ---------- link + billing columns on the in-service client ----------
alter table public.gw_clients add column if not exists intake_id uuid
  references public.onb_intakes(id) on delete set null;
alter table public.gw_clients add column if not exists stripe_customer_id text;
alter table public.gw_clients add column if not exists stripe_subscription_id text;
alter table public.gw_clients add column if not exists pay_status text;  -- mirrors onb_intakes.pay_status
-- One in-service client per intake — UNIQUE so a concurrent double-provision (or
-- any future writer) can never create duplicate client rows for one intake.
create unique index if not exists gw_clients_intake_uniq
  on public.gw_clients(intake_id) where intake_id is not null;

-- If an in-service client is deleted, clear the intake's back-link so it can be
-- re-provisioned and the admin's "created" banner/link doesn't dangle.
create or replace function public.gw_clear_intake_link()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.onb_intakes set project_id = null where project_id = old.id;
  return old;
end; $$;
drop trigger if exists gw_clients_clear_link on public.gw_clients;
create trigger gw_clients_clear_link after delete on public.gw_clients
  for each row execute function public.gw_clear_intake_link();

-- onb_intakes.project_id holds the linked gw_clients.id for a Groundwork intake
-- (the column already exists from 010; this is just documentation).
comment on column public.onb_intakes.project_id is
  'Linked in-service record: gw_clients.id for a Groundwork intake.';

-- ---------- accept + provision RPC (admin only) ----------
-- Sets the deposit (optional) + accepts the intake, then creates and links the
-- Groundwork client, seeds its integrations from the spec, and adds an empty
-- reception-settings row. Idempotent: if already provisioned, returns the
-- existing gw_clients id without duplicating anything.
create or replace function public.onb_accept_and_provision(
  p_intake  uuid,
  p_deposit numeric default null
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_intake public.onb_intakes;
  v_client uuid;
  v_owner_email text;
  r record;
begin
  if not public.dd_is_admin() then raise exception 'not authorized'; end if;

  -- Lock the intake row. A concurrent second call blocks here, then re-reads the
  -- COMMITTED row (seeing project_id set) and returns idempotently — no duplicate
  -- clients. Belt-and-suspenders: gw_clients_intake_uniq also forbids duplicates.
  select * into v_intake from public.onb_intakes where id = p_intake for update;
  if not found then raise exception 'intake not found'; end if;

  -- Only a reviewed brief may be accepted + provisioned via this action (never a
  -- draft the client is still editing, never a declined one).
  if v_intake.status not in ('submitted', 'in_review', 'accepted') then
    raise exception 'cannot provision an intake in status %', v_intake.status;
  end if;

  -- set deposit (blank/null keeps the current value) + accept
  update public.onb_intakes
     set deposit_amount = coalesce(p_deposit, deposit_amount),
         status = 'accepted'
   where id = p_intake;

  -- already provisioned AND the client still exists → idempotent return
  if v_intake.project_id is not null
     and exists (select 1 from public.gw_clients where id = v_intake.project_id) then
    return v_intake.project_id;
  end if;

  -- non-Groundwork intakes are accepted but have no gw_clients record
  if v_intake.product <> 'groundwork' then
    insert into public.onb_events (intake_id, actor_id, kind, detail)
      values (p_intake, auth.uid(), 'accepted', '{}'::jsonb);
    return null;
  end if;

  -- Use the owner's real auth email for the ownership-bearing column, not the
  -- client-typed contact_email (which is inert while owner_id is set, but must
  -- never seed an email-match ownership hole if owner_id is later nulled).
  select email into v_owner_email from auth.users where id = v_intake.owner_id;
  v_owner_email := coalesce(v_owner_email, v_intake.contact_email);

  insert into public.gw_clients (
    owner_id, owner_email, business_name, contact_email, phone,
    care_plan, status, stripe_customer_id, stripe_subscription_id, pay_status, intake_id
  ) values (
    v_intake.owner_id, v_owner_email,
    coalesce(nullif(v_intake.business_name, ''), 'New client'),
    v_intake.contact_email, v_intake.contact_phone,
    v_intake.care_plan, 'onboarding',
    v_intake.stripe_customer_id, v_intake.stripe_subscription_id, v_intake.pay_status, p_intake
  ) returning id into v_client;

  -- every Groundwork build includes these
  insert into public.gw_integrations (client_id, kind, label, status, sort) values
    (v_client, 'website', 'Website', 'planned', 0),
    (v_client, 'google',  'Google Business Profile', 'planned', 1);

  -- seed the integrations the client asked for (include OR "let dev decide").
  -- Compare jsonb text with '=' (never casts) so a malformed client-supplied
  -- spec value can't raise 22P02 and abort the whole provisioning.
  for r in
    select * from (values
      ('contact_form',    'website',         'Contact form',          10),
      ('online_booking',  'booking',         'Online booking',        11),
      ('payments',        'payments',        'Online payments',       12),
      ('reviews',         'reviews',         'Review requests',       13),
      ('newsletter',      'automations',     'Newsletter signup',     14),
      ('ai_receptionist', 'ai_receptionist', 'AI receptionist',       15),
      ('maps',            'website',         'Map / directions',      16),
      ('social',          'website',         'Social links',          17),
      ('analytics',       'website',         'Analytics',             18)
    ) as m(ky, knd, lbl, srt)
  loop
    if (v_intake.spec->'integrations'->r.ky->>'include') = 'true'
       or (v_intake.spec->'integrations'->r.ky->>'dev_decides') = 'true' then
      insert into public.gw_integrations (client_id, kind, label, status, sort)
      values (v_client, r.knd, r.lbl, 'planned', r.srt);
    end if;
  end loop;

  -- AI receptionist chosen (or left to us) → also track missed-call text-back
  if (v_intake.spec->'integrations'->'ai_receptionist'->>'include') = 'true'
     or (v_intake.spec->'integrations'->'ai_receptionist'->>'dev_decides') = 'true' then
    insert into public.gw_integrations (client_id, kind, label, status, sort)
    values (v_client, 'missed_call', 'Missed-call text-back', 'planned', 19);
  end if;

  -- empty settings row so the client can edit their reception setup
  insert into public.gw_settings (client_id) values (v_client)
    on conflict (client_id) do nothing;

  -- link the intake forward + audit
  update public.onb_intakes set project_id = v_client where id = p_intake;
  insert into public.onb_events (intake_id, actor_id, kind, detail)
    values (p_intake, auth.uid(), 'provisioned_client', jsonb_build_object('gw_client', v_client));

  return v_client;
end;
$$;
revoke all on function public.onb_accept_and_provision(uuid, numeric) from public;
grant execute on function public.onb_accept_and_provision(uuid, numeric) to authenticated;
