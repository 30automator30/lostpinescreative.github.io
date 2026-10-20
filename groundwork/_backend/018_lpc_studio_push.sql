-- ============================================================
-- Lost Pines app — studio alerts for leads, requests and briefs (2026-10-20)
--
-- Studio admins who turned on alerts in the app (lpc_push_tokens, 015) get a
-- push for what used to arrive by email only:
--   • a new website lead (gw_inquiries / dd_inquiries)  → opens Leads
--   • a customer service request (lpc_requests)        → opens Leads
--   • a new DeSmit project request (dd_projects "requested", filed by a
--     customer — not one the studio creates)             → opens that project
--   • an onboarding brief becoming "submitted"         → opens that brief
-- (Calls come from gw-reception, 015 / its studio alert.)
--
-- Sent straight to the Expo push API with pg_net, after the row is saved: async,
-- best effort, and it can never fail or slow the insert. Rows the studio
-- itself makes send nothing. At most 20 alerts per kind per hour, so a burst of
-- spam leads cannot flood the phone (the rows are still saved and on the hub).
-- Lock-screen text is short: the kind, a name, and the first words.
--
-- Requires 001, 009, 010 (onboarding), 015 and the pg_net extension
-- (Dashboard ▸ Database ▸ Extensions ▸ pg_net). Without pg_net nothing is
-- sent. If Expo "enhanced push security" is on, put the access token in Vault
-- as expo_access_token.
--
-- No apostrophes in comments: the dashboard SQL editor splits statements
-- itself and an unmatched quote in a comment cuts a function body short.
-- ============================================================

create or replace function public.lpc_push_studio(p_title text, p_body text, p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_msgs jsonb;
  v_headers jsonb := jsonb_build_object('Content-Type', 'application/json', 'Accept', 'application/json');
  v_token text;
begin
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return; end if;
  select jsonb_agg(jsonb_build_object(
           'to', t.token, 'title', left(p_title, 80), 'body', left(coalesce(p_body, ''), 140),
           'sound', 'default', 'priority', 'high', 'channelId', 'calls', 'data', p_data))
    into v_msgs
    from (select t.token from public.lpc_push_tokens t
            join public.dd_profiles p on p.id = t.user_id and p.is_admin
           limit 20) t;
  if v_msgs is null then return; end if;
  begin
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
      into v_token using 'expo_access_token';
  exception when others then v_token := null; -- no Vault: send without it
  end;
  if v_token is not null then v_headers := v_headers || jsonb_build_object('Authorization', 'Bearer ' || v_token); end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3)'
    using 'https://exp.host/--/api/v2/push/send', v_msgs, v_headers;
exception when others then
  raise warning 'studio push skipped: %', sqlerrm; -- the row is saved either way
end;
$$;
revoke all on function public.lpc_push_studio(text, text, jsonb) from public, anon, authenticated;

-- One line of a message for the lock screen.
create or replace function public.lpc_one_line(p text, n int)
returns text language sql immutable set search_path = '' as $$
  select left(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g'), n)
$$;

create or replace function public.lpc_studio_alert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_recent int;
begin
  -- Rows made by a studio admin (including test rows) are not news.
  if public.dd_is_admin() then return new; end if;

  if tg_table_name = 'onb_intakes' then
    if new.status::text <> 'submitted'
       or (tg_op = 'UPDATE' and old.status::text = 'submitted') then return new; end if;
  elsif tg_table_name = 'dd_projects' then
    if new.status::text <> 'requested' then return new; end if;
  end if;

  execute format('select count(*) from public.%I where created_at > now() - interval ''1 hour''', tg_table_name)
    into v_recent;
  if v_recent > 20 then return new; end if;

  if tg_table_name = 'gw_inquiries' then
    perform public.lpc_push_studio(
      'New Groundwork lead: ' || public.lpc_one_line(coalesce(new.name, new.business_name, 'website visitor'), 40),
      public.lpc_one_line(new.message, 140), jsonb_build_object('url', '/leads'));
  elsif tg_table_name = 'dd_inquiries' then
    perform public.lpc_push_studio(
      'New DeSmit lead: ' || public.lpc_one_line(coalesce(new.name, 'website visitor'), 40),
      public.lpc_one_line(new.message, 140), jsonb_build_object('url', '/leads'));
  elsif tg_table_name = 'lpc_requests' then
    perform public.lpc_push_studio(
      'New request: ' || case new.service when 'groundwork' then 'Groundwork' else 'DeSmit Designs' end,
      public.lpc_one_line(new.body, 140), jsonb_build_object('url', '/leads'));
  elsif tg_table_name = 'dd_projects' then
    perform public.lpc_push_studio(
      'New project request: ' || public.lpc_one_line(new.title, 50),
      'Needs a quote', jsonb_build_object('url', '/studio/project', 'id', new.id));
  elsif tg_table_name = 'onb_intakes' then
    perform public.lpc_push_studio(
      'Onboarding brief submitted',
      public.lpc_one_line(coalesce(new.business_name, 'A new client'), 60) || ' · ' ||
        case new.product::text when 'groundwork' then 'Groundwork' else 'DeSmit Designs' end,
      jsonb_build_object('url', '/studio/onboarding', 'id', new.id));
  end if;
  return new;
exception when others then
  raise warning 'studio alert skipped: %', sqlerrm;
  return new;
end;
$$;
revoke all on function public.lpc_studio_alert() from public, anon, authenticated;

drop trigger if exists lpc_studio_alert on public.gw_inquiries;
create trigger lpc_studio_alert after insert on public.gw_inquiries
  for each row execute function public.lpc_studio_alert();
drop trigger if exists lpc_studio_alert on public.dd_inquiries;
create trigger lpc_studio_alert after insert on public.dd_inquiries
  for each row execute function public.lpc_studio_alert();
drop trigger if exists lpc_studio_alert on public.lpc_requests;
create trigger lpc_studio_alert after insert on public.lpc_requests
  for each row execute function public.lpc_studio_alert();
drop trigger if exists lpc_studio_alert on public.dd_projects;
create trigger lpc_studio_alert after insert on public.dd_projects
  for each row execute function public.lpc_studio_alert();
drop trigger if exists lpc_studio_alert on public.onb_intakes;
create trigger lpc_studio_alert after insert or update of status on public.onb_intakes
  for each row execute function public.lpc_studio_alert();
