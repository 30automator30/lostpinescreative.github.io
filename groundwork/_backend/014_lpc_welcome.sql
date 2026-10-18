-- ============================================================
-- Lost Pines — automatic welcome note (2026-10-18)
--
-- Every new client gets a welcome explaining what they bought, how to use the
-- portal / app, and how to reach Daniel — written from what we already know.
--
--   Groundwork  a 'welcome' message at the top of the business's inbox (app +
--               portal), from the template + package, care plan and the
--               "Your system" list. Sent when the client is created (at commit,
--               so onboarding's integrations are in it) and once now for
--               existing clients. Admin "Send welcome note" re-sends it (same
--               row, refreshed). Never counted as a call, never emailed.
--   DeSmit      a welcome card at the top of Projects (app + portal) until the
--               customer taps "Got it" (dd_profiles.welcome_seen_at).
--
-- The wording lives in lpc_studio_settings and is edited in the Groundwork admin
-- ("Welcome note" tab). Fill-ins: {first_name} {business} {package} {plan}
-- {services} {purchase} {contact} {email} {phone} {portal_link} {app_link} {sign_off}
-- ({contact} = "Email you@… or call (512) …" — just the email when no phone;
-- {purchase} = the "What you signed up for" block with package + care plan,
-- or nothing at all when neither is known). A line whose
-- fill-in is empty is left out (no "Call me at ." when there's no phone).
-- Requires 001, 006, onboarding 010/011 and DeSmit 001.
-- ============================================================

-- ---------- studio settings (admin-written; read only via the functions below) ----------
create table if not exists public.lpc_studio_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);
alter table public.lpc_studio_settings enable row level security;
drop policy if exists lpc_studio_settings_admin on public.lpc_studio_settings;
create policy lpc_studio_settings_admin on public.lpc_studio_settings
  for all using (public.dd_is_admin()) with check (public.dd_is_admin());

insert into public.lpc_studio_settings (key, value) values
  ('contact_email', 'ddesmit@lostpinescreative.com'),
  ('contact_phone', null),
  ('sign_off', '— Daniel, Lost Pines Creative'),
  ('welcome_groundwork', $t$Hi {first_name} — welcome to Groundwork!

Thanks for trusting Lost Pines Creative with {business}. Here's what you have and how to use it.

{purchase}

What we're setting up for you
{services}

How to use it
• Inbox (here): every call your AI receptionist takes, missed call and web lead lands here — tap Call or Text to reply, then Mark handled. You also get an email the moment a call comes in.
• Setup: your greeting, hours, after-hours message, text-back message and what the receptionist should know. We've pre-filled it — check it and change anything.
• Request: ask for a change, a new service or help — it comes straight to me.
• Get the app on your phone: {app_link}
• Or use the web portal: {portal_link}

Questions? {contact}

{sign_off}$t$),
  ('welcome_desmit', $t$Hi {first_name} — welcome to DeSmit Designs!

Your projects live here: quotes, files and progress updates, all in one place.

• Approve quotes and see status changes as they happen.
• Share photos, sketches or reference files on any project.
• Need something new? Use "Request a service".
• Get the app on your phone: {app_link}

Questions? {contact}

{sign_off}$t$)
on conflict (key) do nothing;

create or replace function public.lpc_setting(p_key text)
returns text language sql stable security definer set search_path = '' as $$
  select nullif(trim(value), '') from public.lpc_studio_settings where key = p_key;
$$;
revoke all on function public.lpc_setting(text) from public, anon, authenticated;

-- "Email x or call y." — or just the email when no phone is set.
create or replace function public.lpc_contact_line()
returns text language sql stable security definer set search_path = '' as $$
  select concat_ws(' or call ',
    'Email ' || coalesce(public.lpc_setting('contact_email'), 'ddesmit@lostpinescreative.com'),
    public.lpc_setting('contact_phone')) || '.';
$$;
revoke all on function public.lpc_contact_line() from public, anon, authenticated;

-- Fill a template; drop any line whose fill-in came out empty.
create or replace function public.lpc_render(p_template text, p_vars jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare v_line text; v_out text[] := '{}'; v_key text; v_val text; v_skip boolean;
begin
  if p_template is null then return null; end if;
  foreach v_line in array string_to_array(replace(p_template, E'\r', ''), E'\n') loop
    v_skip := false;
    for v_key in select (regexp_matches(v_line, '\{([a-z_]+)\}', 'g'))[1] loop
      v_val := nullif(trim(coalesce(p_vars->>v_key, '')), '');
      if v_val is null then v_skip := true; exit; end if;
      v_line := replace(v_line, '{' || v_key || '}', v_val);
    end loop;
    if not v_skip then v_out := v_out || v_line; end if;
  end loop;
  -- collapse the blank lines left behind by dropped ones
  return trim(regexp_replace(array_to_string(v_out, E'\n'), E'\n{3,}', E'\n\n', 'g'));
end;
$$;

-- ---------- Groundwork: welcome message in the inbox ----------
alter table public.gw_messages drop constraint if exists gw_messages_kind_check;
alter table public.gw_messages add constraint gw_messages_kind_check
  check (kind in ('voicemail', 'missed_call', 'textback', 'lead', 'form', 'welcome'));

create or replace function public.gw_welcome_body(p_client uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  c record; v_first text; v_pkg text; v_plan text; v_services text;
begin
  select g.business_name, g.care_plan, g.intake_id, i.contact_name, i.package
    into c
    from public.gw_clients g left join public.onb_intakes i on i.id = g.intake_id
   where g.id = p_client;
  if not found then return null; end if;
  v_first := split_part(trim(coalesce(c.contact_name, '')), ' ', 1);
  v_pkg := case c.package
    when 'starter'    then 'Starter — one-page site, a claimed & optimized Google Business Profile and a review link'
    when 'foundation' then 'Foundation — website, Google profile, online payments, branded invoicing and automatic review requests'
    when 'growth'     then 'Growth — everything in Foundation plus online booking, an AI receptionist with missed-call text-back, accounting sync and the automations that connect it all'
    when 'full_build' then 'Full Build — everything in Growth plus a full CRM / field-service system, custom integrations, data migration and staff training'
    else null end;
  v_plan := case c.care_plan
      when 'essential' then 'Essential — hosting, updates, backups, monitoring, small monthly changes and a plain-English monthly report'
      when 'growth'    then 'Growth — everything in Essential plus AI receptionist & lead-flow tending, review automation, quarterly automation work and priority support'
      when 'partner'   then 'Partner — ongoing integration & automation work, first-call priority and a defined response time'
      else null end;
  select string_agg('• ' || label ||
           case status when 'live' then ' — live' when 'in_progress' then ' — in progress'
                       when 'paused' then ' — paused' else ' — planned' end, E'\n' order by sort, label)
    into v_services
    from public.gw_integrations where client_id = p_client;
  return public.lpc_render(public.lpc_setting('welcome_groundwork'), jsonb_build_object(
    'first_name', coalesce(nullif(v_first, ''), 'there'),
    'business', c.business_name,
    'package', v_pkg,
    'plan', v_plan,
    'purchase', case when v_pkg is not null or v_plan is not null then
      concat_ws(E'\n', 'What you signed up for', '• Package: ' || v_pkg, '• Care plan: ' || v_plan) end,
    'services', coalesce(v_services, '• We''ll list your tools here as we set them up.'),
    'contact', public.lpc_contact_line(),
    'email', public.lpc_setting('contact_email'),
    'phone', public.lpc_setting('contact_phone'),
    'portal_link', 'https://lostpinescreative.com/groundwork/portal/',
    'app_link', 'https://lostpinescreative.com/app/',
    'sign_off', public.lpc_setting('sign_off')));
end;
$$;
revoke all on function public.gw_welcome_body(uuid) from public, anon, authenticated;

-- Insert or refresh the client's one welcome row (external_id 'welcome:<client>').
create or replace function public.gw_put_welcome(p_client uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_body text := public.gw_welcome_body(p_client);
begin
  if v_body is null or v_body = '' then return; end if;
  insert into public.gw_messages (client_id, external_id, kind, from_name, body, status, meta)
  values (p_client, 'welcome:' || p_client, 'welcome', 'Daniel · Lost Pines Creative', v_body, 'new',
          jsonb_build_object('via', 'welcome'))
  on conflict (external_id) do update
    set body = excluded.body, status = 'new', created_at = now();
end;
$$;
revoke all on function public.gw_put_welcome(uuid) from public, anon, authenticated;

-- Admin "Send welcome note" (re-sends with the current wording and services).
create or replace function public.gw_send_welcome(p_client uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.dd_is_admin() then raise exception 'not authorized'; end if;
  perform public.gw_put_welcome(p_client);
end;
$$;
revoke all on function public.gw_send_welcome(uuid) from public, anon;
grant execute on function public.gw_send_welcome(uuid) to authenticated;

-- New client → welcome at COMMIT, so onboarding's integrations (inserted after
-- the client row in the same transaction) are listed.
create or replace function public.gw_clients_welcome()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.gw_put_welcome(new.id);
  return null;
end;
$$;
drop trigger if exists gw_clients_welcome on public.gw_clients;
create constraint trigger gw_clients_welcome after insert on public.gw_clients
  deferrable initially deferred
  for each row execute function public.gw_clients_welcome();

-- Existing clients: one welcome each (never re-sent by re-running this file).
do $$ declare r record; begin
  for r in select id from public.gw_clients g
            where not exists (select 1 from public.gw_messages m where m.external_id = 'welcome:' || g.id) loop
    perform public.gw_put_welcome(r.id);
  end loop;
end $$;

-- ---------- DeSmit: welcome card on Projects ----------
alter table public.dd_profiles add column if not exists welcome_seen_at timestamptz;

-- The signed-in customer's welcome, or null once they've tapped "Got it".
create or replace function public.dd_my_welcome()
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_name text; v_seen timestamptz;
begin
  if auth.uid() is null then return null; end if;
  select full_name, welcome_seen_at into v_name, v_seen from public.dd_profiles where id = auth.uid();
  if v_seen is not null then return null; end if;
  return public.lpc_render(public.lpc_setting('welcome_desmit'), jsonb_build_object(
    'first_name', coalesce(nullif(split_part(trim(coalesce(v_name, '')), ' ', 1), ''), 'there'),
    'contact', public.lpc_contact_line(),
    'email', public.lpc_setting('contact_email'),
    'phone', public.lpc_setting('contact_phone'),
    'portal_link', 'https://lostpinescreative.com/desmitdesigns/portal/',
    'app_link', 'https://lostpinescreative.com/app/',
    'sign_off', public.lpc_setting('sign_off')));
end;
$$;
revoke all on function public.dd_my_welcome() from public, anon;
grant execute on function public.dd_my_welcome() to authenticated;

create or replace function public.dd_dismiss_welcome()
returns void language sql security definer set search_path = '' as $$
  update public.dd_profiles set welcome_seen_at = now() where id = auth.uid();
$$;
revoke all on function public.dd_dismiss_welcome() from public, anon;
grant execute on function public.dd_dismiss_welcome() to authenticated;
