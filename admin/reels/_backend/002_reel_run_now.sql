-- "Do it now": the owner asks the PC to act on a decided card right away instead of waiting for the nightly run.
-- A watcher on the owner's PC (Task Scheduler, every 10 minutes) starts a run for cards with run_now. The agent
-- clears the flag when it picks the card up (reel-agent items.put).

alter table public.reel_items add column if not exists run_now boolean not null default false;

create or replace function public.reel_run_now(p_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.dd_is_admin() then raise exception 'not authorized'; end if;
  update public.reel_items set run_now = true, updated_at = now()
   where id = p_id and status in ('approved', 'revise', 'regenerate');
  if not found then raise exception 'reel is not waiting for a run'; end if;
end $$;

revoke all on function public.reel_run_now(text) from public, anon;
grant execute on function public.reel_run_now(text) to authenticated;
