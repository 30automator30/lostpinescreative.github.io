-- ============================================================
-- Groundwork — automatic monthly reports, as drafts (2026-10-19)
--
-- On the 1st of each month (pg_cron, 8am Central) every ACTIVE client gets
-- last month's report, counted the same way as the admin's "Fill from this
-- month": calls (leads + missed calls + voicemails), leads, and missed callers
-- actually texted back (Twilio accepted it, or the owner's phone sent it).
--
--   • Saved as a DRAFT (visible = false): the customer sees nothing until you
--     add reviews / a note in the admin and press Publish.
--   • Never touches a month that already has a report (hand-made or automatic),
--     so re-running is safe.
--   • Emails the studio "N monthly reports ready" when Resend's key is in Vault
--     (name: resend_api_key) and pg_net is on; otherwise just builds them.
--
-- Run by hand any time:  select public.gw_build_monthly_reports('2026-09');
-- Requires 001, 011 (email alerts), 014 (lpc_setting) and the pg_cron extension
-- (Dashboard ▸ Integrations ▸ Cron) for the schedule; pg_net for the email.
-- ============================================================

alter table public.gw_reports add column if not exists auto_generated boolean not null default false;

-- Builds the drafts for one period ('YYYY-MM'; default = last month, Central time).
-- Returns the business names that got a new draft.
create or replace function public.gw_build_monthly_reports(p_period text default null)
returns text[] language plpgsql security definer set search_path = '' as $$
declare
  v_period text;
  v_from timestamptz; v_to timestamptz;
  v_month text;
  c record;
  v_calls int; v_leads int; v_saved int;
  v_made text[] := '{}';
begin
  -- Caller must be the scheduler (no JWT) or a studio admin.
  if auth.uid() is not null and not public.dd_is_admin() then
    raise exception 'admins only' using errcode = '42501';
  end if;

  v_period := coalesce(nullif(trim(p_period), ''),
    to_char((date_trunc('month', now() at time zone 'America/Chicago') - interval '1 month'), 'YYYY-MM'));
  if v_period !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'period must be YYYY-MM' using errcode = '22023';
  end if;
  v_from := (to_date(v_period || '-01', 'YYYY-MM-DD')::timestamp) at time zone 'America/Chicago';
  v_to   := ((to_date(v_period || '-01', 'YYYY-MM-DD') + interval '1 month')::timestamp) at time zone 'America/Chicago';
  v_month := trim(to_char(to_date(v_period || '-01', 'YYYY-MM-DD'), 'FMMonth YYYY'));

  -- One run at a time (cron + a manual run can't double up).
  perform pg_advisory_xact_lock(hashtext('gw_build_monthly_reports'));

  for c in
    select g.id, g.business_name from public.gw_clients g
     where g.status = 'active'
       and not exists (select 1 from public.gw_reports r where r.client_id = g.id and r.period = v_period)
     order by g.business_name
  loop
    select count(*) filter (where m.kind in ('lead', 'missed_call', 'voicemail')),
           count(*) filter (where m.kind = 'lead'),
           count(*) filter (where m.kind = 'textback'
                             and (m.meta->>'sent' = 'true' or m.meta->>'via' = 'gw-device'))
      into v_calls, v_leads, v_saved
      from public.gw_messages m
     where m.client_id = c.id and m.created_at >= v_from and m.created_at < v_to;

    insert into public.gw_reports (client_id, period, title, summary, metrics, visible, auto_generated)
    values (c.id, v_period, v_month || ' report',
      v_calls || case when v_calls = 1 then ' call' else ' calls' end || ' handled, ' ||
      v_leads || case when v_leads = 1 then ' lead' else ' leads' end || ', ' ||
      v_saved || ' missed ' || case when v_saved = 1 then 'caller' else 'callers' end || ' texted back.',
      jsonb_build_object('calls', v_calls, 'missed→saved', v_saved, 'leads', v_leads),
      false, true);
    v_made := v_made || c.business_name;
  end loop;
  return v_made;
end;
$$;
revoke all on function public.gw_build_monthly_reports(text) from public, anon;
grant execute on function public.gw_build_monthly_reports(text) to authenticated; -- admins (checked inside)

-- The scheduled job: build last month's drafts, then email the studio (best effort).
create or replace function public.gw_monthly_reports_job()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_made text[];
  v_key text;
  v_to text := coalesce(public.lpc_setting('contact_email'), 'ddesmit@lostpinescreative.com');
  v_list text;
begin
  v_made := public.gw_build_monthly_reports(null);
  if coalesce(array_length(v_made, 1), 0) = 0 then return; end if;
  begin
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
      into v_key using 'resend_api_key';
    if v_key is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return; end if;
    select string_agg('<li>' || replace(replace(replace(n, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</li>', '')
      into v_list from unnest(v_made) n;
    execute 'select net.http_post(url := $1, headers := $2, body := $3)'
      using 'https://api.resend.com/emails',
            jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
            jsonb_build_object(
              'from', 'Lost Pines Creative <noreply@lostpinescreative.com>',
              'to', jsonb_build_array(v_to),
              'subject', array_length(v_made, 1) || ' monthly ' ||
                         case when array_length(v_made, 1) = 1 then 'report' else 'reports' end || ' ready to review',
              'html', '<p>Last month''s Groundwork reports are drafted (customers can''t see them yet):</p><ul>' ||
                      v_list || '</ul><p>Add reviews or a note, then press <b>Publish</b> on each one: ' ||
                      '<a href="https://lostpinescreative.com/groundwork/admin/">Groundwork admin</a>.</p>');
  exception when others then
    raise warning 'monthly report email skipped: %', sqlerrm; -- the drafts are already saved
  end;
end;
$$;
revoke all on function public.gw_monthly_reports_job() from public, anon, authenticated;

-- Schedule: 13:00 UTC on the 1st = 8am CDT / 7am CST. Skipped (with a notice)
-- until the pg_cron extension is enabled; re-run this file after enabling it.
do $$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron is not enabled: enable it (Integrations ▸ Cron), then run this file again';
    return;
  end if;
  -- Scheduling by name replaces an existing job of the same name.
  perform cron.schedule('gw-monthly-reports', '0 13 1 * *', 'select public.gw_monthly_reports_job()');
end;
$$;
