---
name: adversarial-review
description: >
  Pressure-tests a claim, document, plan, or framework by fanning it out to several
  INDEPENDENT frontier models from different labs (adversarial mode), or models how a named
  opponent would attack a position (steel-man mode). Both consume a structured
  "thesis packet" whose required rails — artifact, precise question, frame, scoped
  evidence, named gaps, review axes, and an explicit sensitivity declaration — are
  enforced by a PRECISION GATE that refuses to run on vague input. A Claude model
  synthesizes the independent critiques into one map; you remain the final judge.
  USE WHEN you want an artifact stress-tested by diverse models across ANY discipline
  (strategy, technical design, governance/contracts, intellectual frameworks), or to
  war-game how an opponent would beat a position.
version: 1.3.0
runtime: bun
entry_point: adversarial_review.ts
tags:
  - review
  - adversarial
  - llm-panel
status: active
---

# adversarial-review

A multi-model critique panel: several independent, different-lab models try to break a
piece of work; a separate Claude model organizes their critiques into one report; the human
decides. See **[README.md](README.md)** for full setup, requirements, the complete packet
format, and how to drive it from an agent. This file is the quick operational card.

## Why it works

Precision of the *input* is the whole game: a vague request produces vague critique. So
the rails go on the input, enforced mechanically by a precision gate that refuses to fan
out on empty/hedged values. Reviewers are deliberately a different lineage than the
synthesizer (the model organizing the critiques can't also be a critic) — by default a
non-Claude panel with a Claude synthesizer, but the synthesizer/panel split is configurable.
The synthesis ORGANIZES the attacks — you are the final judge.

## Commands

```bash
bun adversarial_review.ts axes [--review-type <type>]   # list bundled axis-sets
bun adversarial_review.ts gate     --packet <path|->     # validate a packet (no model calls)
bun adversarial_review.ts describe --packet <path|->     # echo packet + resulting ZDR routing
bun adversarial_review.ts models   [--zdr]               # show the live-resolved model panel
bun adversarial_review.ts run      --packet <path|-> [--zdr|--no-zdr] [--out <path>] [--dry-run]
bun adversarial_review.ts run      --template <path> --artifact <path>   # saved recurring review
```

## The thesis packet (required rails — the precision gate)

| Rail | Required | Meaning |
|---|---|---|
| `sensitivity` | ✅ both modes | `sensitive` (forces ZDR on, refuses `--no-zdr`) or `not-sensitive` (follows the `--zdr` toggle). Absent is a gap, NOT "false". |
| `artifact` | ✅ | The bounded thing under review — a file path or inline text. |
| `question` | ✅ | One sentence: exactly what is being decided/tested. |
| `frame` | ✅ | What the review IS and ISN'T about (its scope). |
| `axes` | ✅ | The explicit review dimensions (pull a starter set via `axes`). |
| `evidence.include` / `.exclude` | optional | What reviewers may see / must NOT see (with reasons). |
| `known_gaps` | optional | Named uncertainties you already know about. |
| `opponent.{identity,goal,information}` | ✅ steel-man | Who the opponent is, what they want, and what THEY know (the opponent is modeled only from this). |

## Output

The synthesis opens with **Packet Health** (was the panel able to use the packet, or did a
gap limit it), then per-pillar verdicts `HOLDS / WEAK / BROKEN / UNTESTED` (a pillar nobody
could probe is UNTESTED, never folded into HOLDS), then a severity-ranked fix list. Steel-man
mode returns a game-theory playbook instead. Raw per-model critiques are preserved in an
appendix. The report is a timestamped markdown file (default `./adversarial-reviews/`,
override with `--out`); the run prints its path.
