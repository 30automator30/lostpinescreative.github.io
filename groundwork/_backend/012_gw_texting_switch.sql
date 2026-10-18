-- ============================================================
-- Groundwork — per-line texting switch (2026-10-18)
--
-- US carriers block business texts until the number is registered (A2P 10DLC
-- for a local number, toll-free verification for 8xx). Until then gw-reception
-- must not promise or attempt texts. This switch is OFF by default: the AI
-- says the owner will call back, no text-back or text alert is sent, and the
-- owner still gets the email alert (011). While it's off, the Lost Pines app's
-- Text-Back on the owner's phone may text missed callers (gw-device), since
-- the line isn't sending any.
--
-- Turn it on once the number is approved for texting:
--   update public.gw_reception_lines set texting_enabled = true
--    where ai_number = '+1…';
-- Requires 006.
-- ============================================================

alter table public.gw_reception_lines add column if not exists texting_enabled boolean not null default false;
