# gw-reception — AI receptionist + missed-call text-back

One Supabase Edge Function answers phones for **every** Groundwork client. DeSmit
Designs is line #1 (dogfood); each new client is just new rows, not new code.

```
Caller ─▶ owner's cell ──(no answer / busy / off)──▶ carrier forwards ─▶ Twilio number
                                                                          (imported into Vapi)
Vapi ── assistant-request ──▶ gw-reception  builds the receptionist from gw_settings
     ── tool-calls ─────────▶ gw-reception  take_message · check_availability · book_appointment (Cal.com)
     ── end-of-call-report ─▶ gw-reception  gw_messages row ▸ text-back to caller ▸ text + email alert to owner
Caller replies by text ─────▶ gw-reception?src=twilio-sms ▸ inbox + forwarded to owner
```

- **Every call reaching the AI was missed by the owner**, so every caller with a
  US/Canada number gets exactly one text (booking confirmation, "got your
  message", or the client's missed-call text). Retries never double-text.
- A hang-up before saying anything is logged as `missed_call`; anything else is a
  `lead` in the portal inbox with summary, transcript, and recording link.
- **Degrades honestly:** no Cal.com event type → takes messages only. Kill switch
  off, daily ceiling hit, or DB blip → a short "sorry we missed you, texting you
  now" and the text-back still goes out. A line that's switched off, or a paused /
  cancelled client, sends no texts and the fallback doesn't promise one.
- **Retry-safe:** Vapi is told to retry failed reports (backoff ×3); every step is
  idempotent and the call is only marked done after the texts go out. A caller
  never gets two text-backs. (A Twilio-side send failure is not retried; the miss
  shows in the inbox.)
- **Caller ID check:** if call forwarding drops caller ID and the call shows your
  own cell, you're never texted a text-back (`cli_missing` in the logs) — fix the
  forwarding code if you see it.
- **Email alert for every real call** (`011_gw_email_alerts.sql`): who called, their
  number (tap to call), what they need, and an **Open inbox** link — to the client's
  contact email (else owner email), once per call, ≤ `RL_EMAIL_DAY` (default 50) per
  line per day. Works before texting is approved. The owner switches it off in the
  portal ("Email me new calls"). Needs `RESEND_API_KEY` (already set for the portal
  emails). The portal and admin also show a new-call count, a banner, the count in
  the tab title, and a pop-up when a call arrives while they're open.
- Disclosure is enforced: the greeting always says it's an AI and the call may be
  recorded, even if the client's custom greeting doesn't.

Tests: `deno test -A groundwork/_backend/gw-reception/index.test.ts` (21 cases: auth,
assistant build, fallback, booked call end-to-end, missed call, retries/idempotency,
non-US/Caribbean blocking, per-number text cap, booking abuse, signed + replayed SMS replies,
DB-blip retry, switched-off line, missing caller ID, blocked-ID booking, owner's AI switch,
Text-Back app allowance, lead emails: once per call, escaping, off switch / no address, daily cap).

---

## Setup — DeSmit Designs (line #1)

Rough running cost: Twilio number ~$1–2/mo + ~1–2¢ per text with carrier fees;
A2P ~$20 one-time ($4.50 brand + $15 vetting) + $1.50/mo; Vapi all-in ~$0.10–0.20 per AI minute
(platform + Deepgram + voice + Claude Haiku). _Confirm on each vendor's pricing page._

### 1. Database
Apply `../006_gw_reception.sql` (MCP `apply_migration`, SQL editor, or CLI).
**Do this before the site changes reach `main`** — the portal/admin now save a
`knowledge` field that only exists after this migration.

### 2. Twilio (phone + SMS)
1. Create a Twilio account **in the business's name** (Lost Pines Creative LLC).
2. Buy a local number (512 / 737).
3. **Start A2P 10DLC registration now** — US carriers block business texts from
   unregistered numbers. Calls work immediately; text-backs fail (error 30034) until
   the campaign is approved. Console ▸ Messaging ▸ Regulatory Compliance ▸ Onboarding:
   - **Customer Profile** (LLC, EIN, address, authorized rep) — Twilio review can take 72 h+;
     you can continue while it's pending.
   - **Brand: Low-Volume Standard** — $4.50 one-time, for <6,000 texts/day. (Standard is
     $46; Sole Proprietor is for no-EIN businesses.) Needs a brand contact email for 2FA.
     List **DeSmit Designs** as the brand/DBA name so it matches the texts.
   - **Campaign: Low-Volume Mixed** — $15 vetting + **$1.50/mo** (a Standard use case like
     Customer Care is $10/mo; not needed at this volume). Sample message:
     _"Sorry we missed your call at DeSmit Designs! Reply here with what you need.
     Reply STOP to opt out."_ Opt-in description: _"Customers call our business line;
     if we miss the call we send one text to the calling number. Privacy policy:
     https://lostpinescreative.com/privacy.html"_ (§7 there covers this).
   _Fees verified against Twilio's help center 2026-10-17; re-check the console at checkout._
4. Create a **Messaging Service**, add the number. Set its incoming-message
   webhook to `https://ekogelnbhggyrychfrta.supabase.co/functions/v1/gw-reception?src=twilio-sms` (HTTP POST).
   _(A toll-free number with toll-free verification is the alternative if 10DLC drags.)_

### 3. Cal.com (booking)
1. Event type, e.g. **"Project consult — 20 min, phone call"**, on the Google
   Calendar you actually work from; set availability + buffers.
2. Booking questions: make **Attendee phone number required** and **Email
   optional** — callers rarely spell an email on the phone, and the API books with
   phone only when the event type allows it.
3. Note the **event type ID** (from its URL) and create an **API key** (Settings ▸ Developer).

### 4. Vapi (the voice)
1. Create the account. **Custom Credentials ▸ Bearer token** — generate a long
   random token. Note the credential id.
2. **Phone Numbers ▸ Import ▸ Twilio** with the Twilio SID/auth token and the number.
   Leave **Assistant empty**; set **Server URL** to
   `https://ekogelnbhggyrychfrta.supabase.co/functions/v1/gw-reception` with the
   bearer credential. Note the Vapi phone-number id.
3. After import, confirm in Twilio that the number's **messaging** webhook still
   points at the Messaging Service from step 2 (Vapi only needs voice).

### 5. Deploy the function
```bash
supabase secrets set --project-ref ekogelnbhggyrychfrta \
  VAPI_SERVER_SECRET=<the bearer token> VAPI_CREDENTIAL_ID=<cred id> \
  TWILIO_ACCOUNT_SID=<AC...> TWILIO_AUTH_TOKEN=<...> \
  TWILIO_MESSAGING_SERVICE_SID=<MG...> CALCOM_API_KEY=<cal_live_...>
# RESEND_API_KEY is shared with the portal emails — already set if those work.
supabase functions deploy gw-reception --project-ref ekogelnbhggyrychfrta --no-verify-jwt
```
(Secrets live only in Supabase — never in this repo.)

### 6. Wire DeSmit Designs (SQL editor, as admin)
```sql
-- reuse the client row if DeSmit already has one
insert into public.gw_clients (business_name, owner_email, contact_email, phone, care_plan, status)
values ('DeSmit Designs', 'desmitdesignz@gmail.com', 'ddesmit@lostpinescreative.com',
        '+14083487284', 'internal', 'active')
returning id;   -- → <client_id>

insert into public.gw_settings (client_id, forward_number, hours, greeting, knowledge)
values ('<client_id>', '+14083487284', '{"text":"Mon–Fri 9a–5p, Sat by appointment"}',
  'Thanks for calling DeSmit Designs! Sorry Daniel couldn''t grab the phone — I''m his AI assistant, and this call may be recorded. What are you looking to make?',
  'DeSmit Designs is a design & fabrication studio in Bastrop, Texas, run by Daniel DeSmit, an engineer with 15+ years in medical-device and product design.
Services: multi-color FDM 3D printing (up to 16 colors), high-resolution 12K resin printing, CAD & engineering design, laser cutting & engraving, product development from concept to manufactured part, graphic design & branding, custom one-off commissions.
Materials: PLA, PETG, TPU, ASA, resin, wood, acrylic, leather, MDF. Max FDM print size about 10 x 10 x 10 inches.
Every job is quoted individually — no set prices by phone. Customers can track projects in the client portal.')
on conflict (client_id) do update set knowledge = excluded.knowledge, greeting = excluded.greeting;

insert into public.gw_reception_lines
  (client_id, vapi_phone_number_id, ai_number, cal_event_type_id, booking_url)
values ('<client_id>', '<vapi phone-number id>', '+1512XXXXXXX', <event type id>,
        'https://cal.com/<you>/project-consult');
```
Greeting, hours, text-back and knowledge are then editable from the portal/admin
("Reception & voicemail setup").

### 7. Forward your cell to the AI (conditional forwarding)
Forward only when you **don't answer, are busy, or are unreachable** — you still
pick up when you can. Dial from the cell, replacing `NUMBER` with the Twilio number:

| Carrier | No answer (≈20 s) | Busy | Unreachable |
|---|---|---|---|
| AT&T / T-Mobile | `**61*+1NUMBER**20#` | `**67*+1NUMBER#` | `**62*+1NUMBER#` |
| Verizon | `*71NUMBER` (no answer + busy) | — | — |

Turn off: AT&T/T-Mobile `##004#`; Verizon `*73`. _Codes vary by plan — confirm in
your carrier's app if one doesn't take._ Forwarded calls normally keep the original
caller ID, which is what the text-back uses.

### 8. QA gate (from 03-GROWTH §6) — do all of these from a phone that isn't yours
- [ ] Call, let it ring out: AI answers in DeSmit's greeting, discloses AI + recording.
- [ ] Ask for a consult: it offers real Cal.com times, books one, the calendar blocks it,
      you get "BOOKED …" by text, the caller gets the confirmation text.
- [ ] Call and leave a message: inbox shows a `lead` with summary + transcript; you get the alert.
- [ ] Call and hang up during the greeting: `missed_call` + missed-call text within seconds.
- [ ] Reply to the text-back: it lands in the inbox and is forwarded to you.
- [ ] Ask it something not in "knowledge" (a price): it says Daniel will follow up — no guessing.
- [ ] `update ai_config set enabled=false where fn='gw-reception'`: call → short apology +
      text-back; set back to `true`.

## Adding the next Groundwork client
Their own Twilio number (in their name, imported into the same Vapi org) + a
`gw_reception_lines` row + their `gw_settings`. Today `CALCOM_API_KEY` is a single
key, so booking works only for event types on that Cal.com account — give each
client a Cal.com team seat under it, or add per-client keys when client #2 needs it.

## Operations
- **Off switch:** `update public.ai_config set enabled=false where fn='gw-reception';`
- **Spend ceiling:** `RL_GLOBAL_DAY` (default 300 AI-answered calls/day across all lines).
- **Logs** are metadata only (`evt: agent_run`) — no numbers, names, or content.
- **Retention:** transcripts + recording links stripped after 180 days by `ai_retention_purge()`.
  Also set Vapi's call-data retention to ≤180 days so the recordings themselves go too (privacy §7).
- **Text caps:** one text-back per caller number per day, `RL_SMS_DAY` (default 150) across all
  lines, ≤5 forwarded replies per sender per hour; only real US/Canada numbers are ever texted.
- **Two off switches:** `ai_config.enabled=false` turns off the AI (callers still get a text-back);
  `gw_reception_lines.enabled=false` turns the whole line off, texts included.
