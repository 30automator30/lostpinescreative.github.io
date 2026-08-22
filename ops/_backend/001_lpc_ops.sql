-- ============================================================
-- Lost Pines Creative — internal Ops / Asset register (admin-only)
-- Lives in the shared Supabase project (ekogelnbhggyrychfrta). Reuses
-- dd_is_admin() + dd_touch_updated_at(). Only the admin (Daniel) can read/write.
-- ============================================================

create table if not exists public.lpc_assets (
  id         uuid primary key default gen_random_uuid(),
  category   text not null default 'service'
               check (category in ('domain','service','repo','account','app_store','analytics','other')),
  name       text not null,
  provider   text,
  url        text,
  cost       numeric(10,2),
  cadence    text not null default 'monthly'
               check (cadence in ('monthly','yearly','one_time','usage','free')),
  renews_at  date,
  status     text not null default 'active'
               check (status in ('active','lapsing','cancelled')),
  notes      text,
  sort       int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.lpc_assets enable row level security;

drop trigger if exists lpc_assets_touch on public.lpc_assets;
create trigger lpc_assets_touch before update on public.lpc_assets
  for each row execute function public.dd_touch_updated_at();

drop policy if exists lpc_assets_admin_all on public.lpc_assets;
create policy lpc_assets_admin_all on public.lpc_assets
  for all using (public.dd_is_admin()) with check (public.dd_is_admin());

do $$ begin
  alter publication supabase_realtime add table public.lpc_assets;
exception when duplicate_object then null; end $$;

-- ---------- seed from the register (only if empty) ----------
do $$
begin
  if not exists (select 1 from public.lpc_assets) then
    insert into public.lpc_assets (category, name, provider, url, cost, cadence, status, notes, sort) values
    -- domains
    ('domain','lostpinescreative.com','Squarespace','https://lostpinescreative.com', 20, 'yearly','active','DNS via Squarespace → GitHub Pages. Confirm fee/renewal.', 10),
    ('domain','blue-plumeria.com','(confirm registrar)','https://blue-plumeria.com', 15, 'yearly','active','GitHub Pages. Confirm registrar + renewal.', 11),
    ('domain','rememberwho.app','(not purchased)', null, 18, 'yearly','lapsing','Not yet purchased.', 12),
    -- hosting / infra
    ('service','GitHub Pages','GitHub',null, 0,'free','active','Hosts all static sites.', 20),
    ('service','Supabase — Blue Plumeria','Supabase', null, null,'usage','active','Project ktjxrxchrxtmyvlfsyof. Confirm free/Pro.', 21),
    ('service','Supabase — DeSmit + Groundwork','Supabase', null, null,'usage','active','Project ekogelnbhggyrychfrta. Confirm free/Pro.', 22),
    ('service','Resend (email)','Resend', null, 0,'free','active','Auth + invite emails on lostpinescreative.com. Free 3k/mo — confirm.', 23),
    ('service','Anthropic API (Claude)','Anthropic', null, null,'usage','active','AI assistants + dev. Set a budget alert.', 24),
    -- app stores / commerce
    ('app_store','Apple Developer Program','Apple', null, 99,'yearly','active','iOS publishing.', 30),
    ('app_store','Google Play Console','Google', null, 25,'one_time','active','Android publishing (one-time).', 31),
    ('service','Snipcart','Snipcart', null, null,'usage','active','Blue Plumeria checkout (per-txn).', 32),
    ('service','RevenueCat','RevenueCat', null, 0,'free','active','Remember Who IAP. Free under ~$2.5k/mo.', 33),
    -- analytics
    ('analytics','GA4 — LPC','Google', null, 0,'free','active','G-80VW0JE7HW (lostpinescreative.com).', 40),
    ('analytics','GA4 — Blue Plumeria','Google', null, 0,'free','active','G-3TWSTSRBSR (blue-plumeria.com).', 41),
    -- accounts
    ('account','Mercury (banking)','Mercury', null, 0,'free','active','Checking …6224. Details in legal/.', 50),
    ('account','EIN / D-U-N-S','IRS / D&B', null, 0,'free','active','legal/ folder.', 51),
    ('account','USPS mailbox','USPS', null, null,'yearly','active','legal/USPS COP… confirm fee/renewal.', 52),
    -- repos (reference)
    ('repo','lostpinescreative.github.io','GitHub','https://github.com/30automator30/lostpinescreative.github.io', 0,'free','active','PUBLIC. LPC + Groundwork + DeSmit + portals.', 60),
    ('repo','BluePlumeria','GitHub','https://github.com/30automator30/BluePlumeria', 0,'free','active','PUBLIC — review for sensitive data.', 61),
    ('repo','LostPinesCreative','GitHub','https://github.com/30automator30/LostPinesCreative', 0,'free','active','PRIVATE command center.', 62),
    ('repo','RememberWho','GitHub','https://github.com/30automator30/RememberWho', 0,'free','active','PRIVATE app.', 63),
    ('repo','Kora (NomadCore)','GitHub','https://github.com/30automator30/Kora', 0,'free','active','PRIVATE app.', 64);
  end if;
end $$;
