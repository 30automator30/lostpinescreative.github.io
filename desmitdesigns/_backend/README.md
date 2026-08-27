# DeSmit Designs — Client Portal + Admin + AI Assistant (backend)

A real, working system on a **dedicated Supabase project**:

- **Customer portal** (`/desmitdesigns/portal/`) — magic-link sign-in, live project
  tracking, progress timeline, quote review + one-click approval, service requests.
- **Admin console** (`/desmitdesigns/admin/`) — triage inbox, quote & update
  projects, post progress (customer-visible or internal), all live.
- **AI assistant** — floating chat on the public site + portal, backed by Claude
  via the `dd-assistant` Edge Function; captures leads into `dd_inquiries`.

Everything is built. The steps below are the parts only the account owner can do.
Once done, the portal is live — no further code changes needed.

---

## 1. Create the dedicated Supabase project
supabase.com → **New project** (e.g. `desmit-designs`). Note the **Project URL**
and **anon/publishable key** (Project Settings ▸ API).

## 2. Apply the schema
Run **`001_dd_portal.sql`** against the new project — either:
- **Dashboard:** SQL Editor → paste the file → Run, **or**
- **CLI:** `supabase db push` (as a migration), **or**
- **Claude + MCP:** reconnect the Supabase MCP to this project ref, then ask
  Claude to apply it with `apply_migration`.

This creates `dd_profiles`, `dd_projects`, `dd_project_updates`, `dd_inquiries`,
all Row-Level Security policies, the signup trigger, the `dd_approve_quote` RPC,
and turns on Realtime.

## 3. Deploy the AI assistant Edge Function
Deploy **`dd-assistant/index.ts`** as a function named `dd-assistant`:
- **Dashboard:** Edge Functions → Create → name `dd-assistant` → paste the file →
  **Deploy with "Verify JWT" OFF** (visitors may be signed out).
- **CLI:** put the file at `supabase/functions/dd-assistant/index.ts` →
  `supabase functions deploy dd-assistant --no-verify-jwt`.

Then set the secret (Project Settings ▸ Edge Functions ▸ Secrets, or CLI):
```
ANTHROPIC_API_KEY = sk-ant-...            # required
ALLOWED_ORIGINS   = https://lostpinescreative.com,https://www.lostpinescreative.com
```
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## 4. Configure Auth (magic link)
Authentication ▸ **URL Configuration**:
- **Site URL:** `https://lostpinescreative.com`
- **Redirect URLs:** add
  `https://lostpinescreative.com/desmitdesigns/portal/`
  and `https://lostpinescreative.com/desmitdesigns/admin/`

Email is on by default (Supabase's built-in sender is rate-limited — fine for low
volume; wire a custom SMTP later if needed). Magic-link (OTP) is enabled by
default; no password setup required.

## 5. Fill in the front-end config
Edit **`../portal/config.js`** (one file, three values):
```js
SUPABASE_URL:      "https://<ref>.supabase.co",
SUPABASE_ANON_KEY: "<anon or sb_publishable_ key>",
ASSISTANT_FN:      "https://<ref>.supabase.co/functions/v1/dd-assistant",
```
(The anon key is safe to ship — RLS guards all data.)

## 6. One-time: make yourself admin
Sign in **once** at `/desmitdesigns/portal/` with `desmitdesignz@gmail.com` so your
account exists, then run in the SQL Editor:
```sql
update public.dd_profiles set is_admin = true
where id = (select id from auth.users where email = 'desmitdesignz@gmail.com');
```
Now `/desmitdesigns/admin/` unlocks for you.

## 7. Commit & deploy the site
Commit the `desmitdesigns/` changes and push `main` — GitHub Pages serves the
portal, admin, and assistant. (First load after deploy may be one version stale
via the service worker; reload once.)

---

### How the pieces connect
- Front-end talks to Supabase directly with the **anon key**; every table is
  protected by **RLS** (customers see only their own projects; admin sees all).
- The only privileged path is the `dd-assistant` function, which uses the
  service-role key server-side to save leads — the key never reaches the browser.
- **Realtime** pushes project + update changes so the customer's screen and the
  admin console stay in sync without refreshing.

### Data model (quick reference)
| table | purpose |
|-------|---------|
| `dd_profiles` | one row/user; `is_admin` flag; auto-created on signup |
| `dd_projects` | title, service_type, status, quote_amount, progress_percent |
| `dd_project_updates` | progress timeline + two-way notes (`customer_visible`) |
| `dd_project_files` | photo/file attachments per project (files in Storage) |
| `dd_milestones` | studio-managed per-project checklist (client reads) |
| `dd_inquiries` | public leads captured by the AI assistant |

### Milestones (migration `006_dd_milestones.sql`)
A per-project checklist the **studio** adds and checks off; the client sees it
read-only. RLS: admin writes, project members read. New column
`dd_projects.progress_auto` — when **true**, the progress bar is derived from the
done/total milestone ratio (a trigger recomputes it on every milestone change);
when **false**, the studio's manual percent wins. Existing projects were set
`progress_auto=false` to preserve their manual percent; new projects default to
auto. In the admin editor, an "auto from milestones" checkbox toggles the mode
(and typing a percent into a progress update flips it back to manual).

### Attachments (migration `005_dd_attachments.sql`)
Adds photo/file uploads to projects. Files live in the private **`dd-attachments`**
Storage bucket (25 MB cap); `dd_project_files` holds metadata. Both the client
(and shared members) and the admin can upload; the admin can mark a file
**internal-only** (`customer_visible=false`). Access is keyed on **project
membership** via `dd_can_access_project()` + `customer_visible` — not on uploader
identity — so the customer can download admin-posted files and vice-versa. Images
render inline; everything else is signed with `{ download }` (served as an
attachment, never rendered on the Supabase origin). The bucket + policies are
created by the migration itself — no dashboard steps. Reviewed via adversarial
design review before build (2026-08-27).

Project status flow: `requested → quoted → approved → in_progress → review → complete`
(`cancelled` any time). Customers move `quoted → approved` via **Approve quote**;
everything else is admin-driven.
