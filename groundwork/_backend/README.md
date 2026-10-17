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
| `gw_devices` | registered Text-Back phones (token hash only, who registered, last seen, revoked_at) — admin-only, `007` |

RLS: a client owner sees only their own client + children; the client can edit
their `gw_settings` and mark messages handled (via `gw_set_message_status`).
Admin (Daniel) sees and manages everything.
