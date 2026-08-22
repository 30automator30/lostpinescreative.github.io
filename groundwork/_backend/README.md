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

RLS: a client owner sees only their own client + children; the client can edit
their `gw_settings` and mark messages handled (via `gw_set_message_status`).
Admin (Daniel) sees and manages everything.
