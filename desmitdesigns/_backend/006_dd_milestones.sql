-- ============================================================
-- DeSmit Designs — project milestones (studio-managed checklist)
-- A per-project checklist the studio adds and checks off; the client sees it
-- read-only. Checking milestones can auto-drive the project's progress bar,
-- with a per-project manual override.
--
--   dd_milestones                — the checklist rows (admin write, member read)
--   dd_projects.progress_auto    — when true, progress_percent is derived from
--                                  the done/total milestone ratio; when false,
--                                  the studio's manual percent wins.
--
-- Existing projects are set progress_auto=false so their current manual percent
-- is preserved; new projects default to auto.
-- ============================================================

-- ---------- progress mode flag on projects ----------
alter table public.dd_projects
  add column if not exists progress_auto boolean not null default true;
-- Preserve manual progress on projects that already exist (don't retro-zero them).
update public.dd_projects set progress_auto = false where progress_auto is true;

-- ---------- milestones ----------
create table if not exists public.dd_milestones (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.dd_projects(id) on delete cascade,
  title      text not null,
  done       boolean not null default false,
  done_at    timestamptz,
  position   int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.dd_milestones enable row level security;
create index if not exists dd_milestones_project_idx on public.dd_milestones(project_id);

-- Client (and shared members) may READ milestones on projects they can access;
-- only the studio (admin) may add / toggle / remove them.
drop policy if exists dd_milestones_select on public.dd_milestones;
create policy dd_milestones_select on public.dd_milestones
  for select using (public.dd_is_admin() or public.dd_can_access_project(project_id));

drop policy if exists dd_milestones_admin_write on public.dd_milestones;
create policy dd_milestones_admin_write on public.dd_milestones
  for all using (public.dd_is_admin()) with check (public.dd_is_admin());

-- Stamp done_at when a milestone flips done, clear it when reopened.
create or replace function public.dd_milestone_touch()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.done and (tg_op = 'INSERT' or not old.done) then
    new.done_at := now();
  elsif not new.done then
    new.done_at := null;
  end if;
  return new;
end; $$;
drop trigger if exists dd_milestones_touch on public.dd_milestones;
create trigger dd_milestones_touch before insert or update on public.dd_milestones
  for each row execute function public.dd_milestone_touch();

-- Recompute a project's progress from its milestones, but only when the project
-- is in auto mode and actually has milestones.
create or replace function public.dd_recalc_progress(p_project uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare t int; d int;
begin
  select count(*), count(*) filter (where done) into t, d
    from public.dd_milestones where project_id = p_project;
  if t > 0 then
    update public.dd_projects
      set progress_percent = round(d::numeric / t * 100)
      where id = p_project and progress_auto;
  end if;
end; $$;

create or replace function public.dd_milestones_after()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.dd_recalc_progress(coalesce(new.project_id, old.project_id));
  return null;
end; $$;
drop trigger if exists dd_milestones_after on public.dd_milestones;
create trigger dd_milestones_after after insert or update or delete on public.dd_milestones
  for each row execute function public.dd_milestones_after();

-- ---------- realtime ----------
do $$ begin
  alter publication supabase_realtime add table public.dd_milestones;
exception when duplicate_object then null; end $$;

-- ---------- hardening (trigger/helper fns off the public API) ----------
revoke execute on function public.dd_milestone_touch() from public, anon, authenticated;
revoke execute on function public.dd_recalc_progress(uuid) from public, anon, authenticated;
revoke execute on function public.dd_milestones_after() from public, anon, authenticated;
