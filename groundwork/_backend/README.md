# Groundwork — client portal + admin + AI assistant (backend)

Shares the **DeSmit Designs Supabase project** (`ekogelnbhggyrychfrta`). Reuses
that project's `dd_profiles` + `dd_is_admin()` for shared users/admin, so **no
new admin bootstrap is needed** — Daniel's existing admin flag governs
Groundwork admin too.

## What it adds
- **Client portal** (`/groundwork/portal/`) — magic-link sign-in; a client sees
  their care plan, the integrations/tools we've set up, monthly reports, their
  messages inbox (voicemails / missed calls / leads), and can edit their
  reception/voicemail setup.
- **Admin** (`/groundwork/admin/`) — manage clients, integrations, reports,
  messages, and setup; triage assistant leads.
- **AI assistant** — `gw-assistant` Edge Function, Groundwork-grounded, captures
  leads into `gw_inquiries`.
- **AI receptionist + missed-call text-back** — `gw-reception` Edge Function
  (Vapi + Twilio + Cal.com), one function for every client's phone line, writes
  calls to `gw_messages`. Setup runbook: [`gw-reception/README.md`](gw-reception/README.md).
- **Text-Back backend** (`gw-device`) for the Lost Pines app's Android
  direct build. The owner signs into the app; the phone registers itself
  (`/register`, owner's session — admin accounts are refused), then texts
  missed callers from the owner's own number and reports each missed call to
  the inbox. Admin sees and revokes phones on the client's **Phones** card.
  Only missed-call events leave the phone.
  - Apply `007_gw_devices.sql` then `008_gw_service_switches.sql` (after `006`).
  - Deploy `gw-device/index.ts` as `gw-device`, **Verify JWT OFF** (phones
    authenticate with their own device token; `/register` checks the owner's
    session itself). No new secrets.
  - The phone stops texting (but stays registered) while the client is paused
    or cancelled, while the owner has switched Text-Back off, or while their
    Twilio receptionist line is on — one text per missed caller. Revoke on the
    Phones card kills that phone's token; the owner can sign in again to
    register a new one.
  - **Verify JWT must stay OFF on every redeploy.** With it on, the gateway
    answers phones with its own 401; the app ignores that (it unpairs only on
    the function's `code: "device_revoked"`), so phones keep texting from
    cache, but nothing syncs and nobody can register until it's fixed.
  - Tests: `deno test -A groundwork/_backend/gw-device/index.test.ts`

- **Service requests** — `lpc_requests` (`009`) + `lpc-request-notify`
  (**Verify JWT ON**, uses the existing `RESEND_API_KEY`; optional
  `STUDIO_NOTIFY_EMAIL`, default ddesmit@lostpinescreative.com). The app or a
  portal inserts the request, then calls the function, which emails the studio
  once. Both brands; a DeSmit *new project* still goes to `dd_projects`.

- **Account deletion** — `lpc-delete-account` (**Verify JWT ON**) + `010`.
  In-app "Delete my account" (Apple 5.1.1(v)) and the web page. Groundwork
  businesses are **detached, not deleted** (owner login removed, phones
  revoked, record/line/inbox kept, studio emailed); the user's own DeSmit
  projects and their files are deleted; onboarding intakes/assets (signed
  agreement, Stripe ids, brand files) are detached and kept, and the studio
  email names any live Stripe subscription to cancel by hand; service requests
  are kept with the requester's email. Admin accounts are refused. A failed
  run returns 503 and is finished by running it again; files Storage refused
  stay in `lpc_storage_purge`.

## Deploy (owner steps)
Because the Supabase MCP must point at `ekogelnbhggyrychfrta`:

1. **Point the MCP at the DeSmit project** (already done in `~/.claude.json`:
   `--project-ref=ekogelnbhggyrychfrta`) and **restart Claude Code**.
2. **Apply** `001_gw_portal.sql` — via the MCP `apply_migration`, the SQL editor,
   or the CLI. Creates `gw_clients`, `gw_integrations`, `gw_reports`,
   `gw_messages`, `gw_settings`, `gw_inquiries` + RLS + the `gw_set_message_status`
   RPC + Realtime.
3. **Deploy** `gw-assistant/index.ts` as a function named `gw-assistant`
   (**Verify JWT OFF**). Secrets already on the project: `ANTHROPIC_API_KEY`,
   `ALLOWED_ORIGINS` (reused from the DeSmit functions).
4. **Auth redirect URLs** — Authentication ▸ URL Configuration already allows
   `https://lostpinescreative.com/...`; add `.../groundwork/portal/` and
   `.../groundwork/admin/` to the redirect list.

Front-end config (`groundwork/portal/config.js`) already holds the project URL +
anon key (same project) and the `gw-assistant` endpoint — nothing to fill.

## Email links — one-time dashboard change (needed before the Lost Pines app)
Both portals and the app share these templates, so switch them together and
then re-test sign-in on **both** portals in the same sitting.

1. **Authentication ▸ URL Configuration:** Site URL `https://lostpinescreative.com`;
   add `lostpines://auth` to Redirect URLs (keep the portal URLs).
2. **Authentication ▸ Email Templates** — replace the link in each template:

   | Template | Link |
   |---|---|
   | Confirm signup | `{{ .SiteURL }}/auth/confirm.html?token_hash={{ .TokenHash }}&type=signup&next={{ .RedirectTo }}` |
   | Invite user | `{{ .SiteURL }}/auth/confirm.html?token_hash={{ .TokenHash }}&type=invite&next={{ .RedirectTo }}` |
   | Magic Link | `{{ .SiteURL }}/auth/confirm.html?token_hash={{ .TokenHash }}&type=magiclink&next={{ .RedirectTo }}` |
   | Reset Password | `{{ .SiteURL }}/auth/confirm.html?token_hash={{ .TokenHash }}&type=recovery&next={{ .RedirectTo }}` |
   | Change Email Address | `{{ .SiteURL }}/auth/confirm.html?token_hash={{ .TokenHash }}&type=email_change&next={{ .RedirectTo }}` |
3. **Regression check** (both `/groundwork/portal/` and `/desmitdesigns/portal/`):
   new sign-up confirms and lands signed in; "Forgot password" email opens
   "Set a new password" and the new password works; an old/used link shows
   "expired" with a way back. `/auth/confirm.html` only ever sends people to
   lostpinescreative.com or the app.

## Data model
| table | purpose |
|-------|---------|
| `gw_clients` | one business per row (owner_id → auth user), care plan, status |
| `gw_integrations` | tools set up for the client (status: planned→live) |
| `gw_reports` | monthly reports (summary + metrics jsonb) |
| `gw_messages` | voicemail / missed-call / lead inbox |
| `gw_settings` | reception/voicemail setup (1:1 with client, client-editable) |
| `gw_inquiries` | public leads captured by the gw-assistant |
| `gw_reception_lines` | admin-only phone wiring per client (Vapi number, Cal.com event type, on/off) — `006` |
| `gw_reception_lines.ai_enabled` / `gw_settings.textback_app_enabled` | the owner's own switches, read via `gw_my_services()` and set via `gw_set_service_enabled()` — `008` |
| `lpc_requests` | service requests from the app/portals, both brands (customer files own, admin manages) — `009` |
| `lpc_storage_purge` | Storage objects queued for removal after an account deletion (service role only) — `010` |
| `gw_devices` | registered Text-Back phones (token hash only, who registered, last seen, revoked_at) — admin-only, `007` |

RLS: a client owner sees only their own client + children; the client can edit
their `gw_settings` and mark messages handled (via `gw_set_message_status`).
Admin (Daniel) sees and manages everything.
