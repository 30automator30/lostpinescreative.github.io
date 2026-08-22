# Agent evals (EVAL-01 / EVAL-02)

Regression set for the Lost Pines AI assistants, per the Agent Build Standard.

- `eval-set.json` — versioned cases: on-topic, out-of-scope, adversarial/injection,
  disclosure, grounding traps, safety (pro-advice refusal). Heuristic substring gates.
- `run-evals.mjs` — dependency-free runner (Node 18+). Exits non-zero if any **MUST**
  case fails.

## Run

```
# gw-assistant (default)
node run-evals.mjs

# DeSmit ai-receptionist (cross-cutting cases apply; the Groundwork-worded
# on-topic/pricing cases are gw-specific)
node run-evals.mjs https://ekogelnbhggyrychfrta.supabase.co/functions/v1/ai-receptionist
```

## When to run (EVAL-01)

Before every deploy of a change to **the prompt, the tools, the caps, or the model
pin** in either edge function. Treat a MUST failure as a ship blocker.

## Model pinning (EVAL-02)

Both functions pin `MODEL = "claude-haiku-4-5-20251001"` (a dated snapshot, not a
floating alias). A model bump is a deploy that must pass this set first.
