-- The number a line publishes. Twilio sends its voice calls to gw-ring, which
-- rings the owner's cell first and hands unaccepted calls to ai_number.
-- Null = the line has no ring-first number; ai_number is called directly.
alter table public.gw_reception_lines
  add column if not exists public_number text unique;
