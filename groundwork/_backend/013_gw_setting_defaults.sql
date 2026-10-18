-- ============================================================
-- Groundwork — pre-filled reception & text-back setup (2026-10-18)
--
-- A new client used to open "Reception & text-back" to a wall of empty boxes.
-- gw_fill_setting_defaults(client) fills only the EMPTY fields of the client's
-- gw_settings row from what we already know — never overwrites anything the
-- owner (or the studio) typed:
--
--   greeting          "Thanks for calling {business}! … AI assistant … may be recorded."
--   forward_number    the business phone (gw_clients.phone, else the intake's)
--   hours             the Google Business hours captured during onboarding
--   after_hours       a friendly default naming the business
--   textback_message  a friendly default naming the business (+ booking link if set)
--   knowledge         business name / type, description, address, website from the intake
--
-- Runs for every new client (trigger) and once now for existing clients.
-- Requires 001, 006 and the onboarding bridge (011_onboarding_bridge.sql).
-- ============================================================

create or replace function public.gw_fill_setting_defaults(p_client uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_biz text; v_phone text; v_intake uuid;
  i_phone text; i_about jsonb; i_desc text; i_industry text;
  v_booking text; v_knowledge text;
begin
  select nullif(trim(business_name), ''), nullif(trim(phone), ''), intake_id
    into v_biz, v_phone, v_intake
    from public.gw_clients where id = p_client;
  if not found then return; end if;

  if v_intake is not null then
    select nullif(trim(contact_phone), ''), coalesce(about, '{}'::jsonb),
           nullif(trim(business_description), ''), nullif(trim(industry), '')
      into i_phone, i_about, i_desc, i_industry
      from public.onb_intakes where id = v_intake;
  end if;
  i_about := coalesce(i_about, '{}'::jsonb);

  select nullif(trim(booking_url), '') into v_booking
    from public.gw_reception_lines where client_id = p_client;

  v_biz := coalesce(v_biz, 'us');
  v_knowledge := nullif(concat_ws(E'\n',
    case when i_industry is not null then v_biz || ' — ' || i_industry || '.' end,
    i_desc,
    case when nullif(trim(i_about->>'address'), '') is not null then 'Address: ' || trim(i_about->>'address') end,
    case when nullif(trim(i_about->>'current_web'), '') is not null then 'Website: ' || trim(i_about->>'current_web') end
  ), '');

  insert into public.gw_settings (client_id) values (p_client) on conflict (client_id) do nothing;

  update public.gw_settings s set
    greeting = coalesce(nullif(trim(s.greeting), ''),
      'Thanks for calling ' || v_biz || '! Sorry we couldn''t pick up — I''m the AI assistant, and this call may be recorded. How can I help?'),
    forward_number = coalesce(nullif(trim(s.forward_number), ''), v_phone, i_phone),
    hours = case
      when nullif(trim(s.hours->>'text'), '') is null and nullif(trim(i_about->>'hours'), '') is not null
        then jsonb_build_object('text', trim(i_about->>'hours'))
      else s.hours end,
    after_hours = coalesce(nullif(trim(s.after_hours), ''),
      'You''ve reached ' || v_biz || ' after hours. Leave a message and we''ll get back to you next business day.'),
    textback_message = coalesce(nullif(trim(s.textback_message), ''),
      'Sorry we missed your call at ' || v_biz || '! Reply here with what you need' ||
      case when v_booking is not null then ' or grab a time: ' || v_booking else '' end || '.'),
    knowledge = coalesce(nullif(trim(s.knowledge), ''), v_knowledge)
  where s.client_id = p_client;
end;
$$;
revoke all on function public.gw_fill_setting_defaults(uuid) from public, anon, authenticated;

-- New clients (admin "New client" or onboarding provisioning) start pre-filled.
create or replace function public.gw_clients_fill_defaults()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.gw_fill_setting_defaults(new.id);
  return new;
end;
$$;
drop trigger if exists gw_clients_fill_defaults on public.gw_clients;
create trigger gw_clients_fill_defaults after insert on public.gw_clients
  for each row execute function public.gw_clients_fill_defaults();

-- Existing clients: fill their empty fields once.
select public.gw_fill_setting_defaults(id) from public.gw_clients;
