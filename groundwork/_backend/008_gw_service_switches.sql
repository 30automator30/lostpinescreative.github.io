-- ============================================================
-- Groundwork — customer on/off switches (2026-10-17)
--
-- Lets a client owner (Lost Pines app or web portal) switch two things
-- themselves, without seeing or touching the admin-only phone wiring:
--
--   textback_app  -> gw_settings.textback_app_enabled (007): the phone app stops
--                    texting missed callers; missed calls are still logged.
--   receptionist  -> gw_reception_lines.ai_enabled (new): the AI stops answering;
--                    callers hear the short "we'll text you" message and still
--                    get the text-back. The whole line (enabled) stays admin-only,
--                    because a line that's fully off sends nothing at all.
--
-- gw_my_services(client) is the owner-readable view of those switches; owners
-- still cannot select gw_reception_lines (numbers, ids, alert destinations).
-- Requires 006 and 007.
-- ============================================================

alter table public.gw_reception_lines add column if not exists ai_enabled boolean not null default true;

create or replace function public.gw_my_services(p_client uuid)
returns table (has_line boolean, ai_enabled boolean, textback_app_enabled boolean)
language sql stable security definer set search_path = '' as $$
  select
    l.client_id is not null,
    coalesce(l.ai_enabled, false),
    coalesce(s.textback_app_enabled, true)          -- no settings row yet = on
  from public.gw_clients c
  left join public.gw_reception_lines l on l.client_id = c.id
  left join public.gw_settings s on s.client_id = c.id
  where c.id = p_client and (public.gw_owns_client(p_client) or public.dd_is_admin());
$$;
revoke execute on function public.gw_my_services(uuid) from anon, public;
grant execute on function public.gw_my_services(uuid) to authenticated;

create or replace function public.gw_set_service_enabled(p_client uuid, p_service text, p_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_on is null then
    raise exception 'p_on is required' using errcode = '22004';
  end if;
  if not (public.gw_owns_client(p_client) or public.dd_is_admin()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_service = 'textback_app' then
    insert into public.gw_settings (client_id, textback_app_enabled) values (p_client, p_on)
      on conflict (client_id) do update set textback_app_enabled = excluded.textback_app_enabled;
  elsif p_service = 'receptionist' then
    update public.gw_reception_lines set ai_enabled = p_on where client_id = p_client;
    if not found then
      raise exception 'no receptionist line for this business' using errcode = 'P0002';
    end if;
  else
    raise exception 'unknown service %', p_service using errcode = '22023';
  end if;
end; $$;
revoke execute on function public.gw_set_service_enabled(uuid, text, boolean) from anon, public;
grant execute on function public.gw_set_service_enabled(uuid, text, boolean) to authenticated;
