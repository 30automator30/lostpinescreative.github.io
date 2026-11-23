-- Reel Studio: the owner reviews NomadCore reels here; the nightly reel run (on the owner's PC) acts on the decisions.
-- Same project and admin flag as the Command Center (dd_is_admin). The nightly run writes only through the
-- reel-agent edge function (service role inside, x-reel-key outside). Owners write only through the two functions below.

create table if not exists public.reel_items (
  id              text primary key,                -- the reel's folder id in Kora video-promos/src/reels/<id>
  series          text not null check (series in ('survival-files', 'how-to')),
  number          int  not null,
  title           text not null,
  hook            text,
  stage           text not null check (stage in ('concept', 'final', 'ready', 'posted')),
  -- working: the nightly run has it. review: waiting on the owner. approved / revise / regenerate: the owner decided.
  status          text not null default 'working' check (status in ('working', 'review', 'approved', 'revise', 'regenerate')),
  pr_url          text,
  storyboard_path text,                            -- in bucket "reels"
  preview_path    text,                            -- in bucket "reels": a small preview, the full kit is on the shared drive
  caption         text,
  reviews         jsonb not null default '{}',     -- {"codex": "...", "grok": "...", "claude": "..."} one-line verdicts
  agent_note      text,                            -- what the nightly run wants the owner to know
  owner_note      text,                            -- the owner's note with revise / regenerate / send back
  posted          jsonb not null default '{}',     -- {"youtube": "2026-11-24T..."}
  updated_at      timestamptz not null default now()
);

alter table public.reel_items enable row level security;
drop policy if exists reel_items_admin_read on public.reel_items;
create policy reel_items_admin_read on public.reel_items for select to authenticated using (public.dd_is_admin());
-- No insert/update/delete policies or grants: owners decide through reel_decide / reel_mark_posted, the agent through reel-agent.
revoke insert, update, delete, truncate on public.reel_items from anon, authenticated;

-- The owner's decision on a card that is waiting for review.
-- concept: approve | revise | regenerate.  final: approve (accept) | revise (send back).
create or replace function public.reel_decide(p_id text, p_decision text, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.reel_items;
begin
  if not public.dd_is_admin() then raise exception 'not authorized'; end if;
  select * into r from public.reel_items where id = p_id for update;
  if not found then raise exception 'no such reel'; end if;
  if r.status <> 'review' or r.stage not in ('concept', 'final') then raise exception 'reel is not waiting for review'; end if;
  if p_decision not in ('approve', 'revise', 'regenerate') then raise exception 'bad decision'; end if;
  if p_decision = 'regenerate' and r.stage <> 'concept' then raise exception 'regenerate is for concepts only'; end if;
  if p_decision = 'revise' and coalesce(btrim(p_note), '') = '' then
    raise exception 'a revise needs a note';
  end if;
  if length(coalesce(p_note, '')) > 2000 then raise exception 'note is over 2,000 characters'; end if;
  update public.reel_items
     set status = case p_decision when 'approve' then 'approved' else p_decision end,
         owner_note = nullif(btrim(coalesce(p_note, '')), ''),
         updated_at = now()
   where id = p_id;
end $$;

-- The owner marks a ready reel as posted on one platform; posting everywhere is up to them.
create or replace function public.reel_mark_posted(p_id text, p_platform text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.dd_is_admin() then raise exception 'not authorized'; end if;
  if p_platform not in ('youtube', 'tiktok', 'facebook', 'instagram', 'x') then raise exception 'bad platform'; end if;
  update public.reel_items
     set posted = posted || jsonb_build_object(p_platform, now()), stage = 'posted', updated_at = now()
   where id = p_id and stage in ('ready', 'posted');
  if not found then raise exception 'reel is not ready to post'; end if;
end $$;

revoke all on function public.reel_decide(text, text, text) from public, anon;
revoke all on function public.reel_mark_posted(text, text) from public, anon;
grant execute on function public.reel_decide(text, text, text) to authenticated;
grant execute on function public.reel_mark_posted(text, text) to authenticated;

-- Private bucket for storyboards and previews. Admins read through signed URLs; only the agent (service role) writes.
insert into storage.buckets (id, name, public) values ('reels', 'reels', false) on conflict (id) do nothing;
drop policy if exists reels_admin_read on storage.objects;
create policy reels_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'reels' and public.dd_is_admin());

do $$ begin
  alter publication supabase_realtime add table public.reel_items;
exception when duplicate_object then null; end $$;
