-- ============================================================
-- Groundwork — "Your plan" and invoices for the owner (2026-10-19)
--
-- The app's Account screen shows what the owner signed up for and where the
-- money stands:
--   • package, care plan + billing cycle, contract signed (and the exact text),
--     payment status — from the onboarding intake (onb_intakes, 010/011);
--   • project total and paid so far — two numbers the studio keeps current in
--     the Groundwork admin (the deposit is 50% of the floor; the rest is settled
--     against the real quote, so only the studio knows the true balance);
--   • invoices and "Manage billing" come live from Stripe via lpc-billing.
--
-- Read-only for the owner (SECURITY DEFINER + gw_owns_client); only the admin
-- can change the amounts (gw_clients_admin_write).
-- Requires 001, 005, 011_onboarding_bridge.
-- ============================================================

alter table public.gw_clients add column if not exists project_total numeric(10,2)
  check (project_total is null or project_total >= 0);
alter table public.gw_clients add column if not exists paid_to_date numeric(10,2)
  check (paid_to_date is null or paid_to_date >= 0);

-- One row for the owner's business; nothing for anyone else.
create or replace function public.gw_my_plan(p_client uuid)
returns table (
  package text, care_plan text, billing_cycle text, deposit_amount numeric,
  pay_status text, sign_status text, signed_at timestamptz, signed_name text,
  has_agreement boolean, project_total numeric, paid_to_date numeric, has_billing boolean
) language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.gw_owns_client(p_client) then return; end if;
  return query
    select i.package,
           coalesce(nullif(c.care_plan, ''), i.care_plan),
           i.billing_cycle,
           i.deposit_amount,
           coalesce(c.pay_status, i.pay_status::text),
           i.sign_status::text, i.signed_at, i.signed_name,
           i.agreement_snapshot is not null,
           c.project_total, c.paid_to_date,
           c.stripe_customer_id is not null
      from public.gw_clients c
      left join public.onb_intakes i on i.id = c.intake_id
     where c.id = p_client;
end;
$$;
revoke all on function public.gw_my_plan(uuid) from public, anon;
grant execute on function public.gw_my_plan(uuid) to authenticated;

-- The exact agreement text the owner signed (shown in the app, read-only).
create or replace function public.gw_my_agreement(p_client uuid)
returns table (agreement text, version text, signed_name text, signed_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.gw_owns_client(p_client) then return; end if;
  return query
    select i.agreement_snapshot, i.agreement_version, i.signed_name, i.signed_at
      from public.gw_clients c
      join public.onb_intakes i on i.id = c.intake_id
     where c.id = p_client and i.agreement_snapshot is not null;
end;
$$;
revoke all on function public.gw_my_agreement(uuid) from public, anon;
grant execute on function public.gw_my_agreement(uuid) to authenticated;
