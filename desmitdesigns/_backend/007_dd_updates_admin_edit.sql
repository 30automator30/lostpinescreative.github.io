-- ============================================================
-- DeSmit Designs — let the studio edit & delete progress updates
-- dd_project_updates previously had only INSERT + SELECT policies, so posted
-- updates couldn't be changed. Add admin-only UPDATE + DELETE. Clients still
-- can't edit/delete (no client policy for those commands).
-- ============================================================
drop policy if exists dd_updates_admin_update on public.dd_project_updates;
create policy dd_updates_admin_update on public.dd_project_updates
  for update using (public.dd_is_admin()) with check (public.dd_is_admin());

drop policy if exists dd_updates_admin_delete on public.dd_project_updates;
create policy dd_updates_admin_delete on public.dd_project_updates
  for delete using (public.dd_is_admin());
