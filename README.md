# adversarial-review

**Get a tough, honest critique of your work from a panel of today's best AI models — not just one.**

When you paste something into a single AI and ask "what's wrong with this?", you get one
model's opinion — and AI models tend to be agreeable. A single model also has a single set of
blind spots, so whatever it can't see, it simply won't mention.

This tool sends your work to **several of the leading AI models at once — built by different
labs, trained on different data — each one told to genuinely try to break it.** That difference
is the whole point: models trained differently fail differently, so they don't just give you
*more* critique, they give you *different* critique. **Where they all land on the same weakness,
you know it's real. Where they disagree is just as valuable — that's the genuinely contested,
non-obvious territory a single model would have quietly smoothed over.** A separate model then
gathers every critique into one organized report. You read it and decide — it lays out the
attacks, it doesn't make the call for you.

It's also built not to flatter you or pad the page. The models are told not to manufacture
criticism just to look busy, and two promises follow from that: **if your material is missing
something they'd genuinely need to judge it well, you're told that — instead of being handed a
confident answer built on a gap. And the tool holds one line it never crosses: it will not
dress up something it couldn't actually test as something that passed.** When a claim couldn't
be properly stress-tested, the report says so plainly rather than giving you false confidence.

Think of it less like a helpful assistant and more like handing your draft to a room of sharp,
skeptical experts who each come at it from a different angle. It works on almost anything you
can put in writing — a strategy, a plan, a contract, an argument, a claim, a decision.

## What you can use it for

- **Stress-test a high-stakes document before it goes out** — a board deck, an investor memo,
  a strategy. Find the holes before your audience does.
- **Vet a contract or agreement before you sign** — where it over- or under-states your rights,
  what's missing, where the logic doesn't hold.
- **Pressure-test a plan** — a product launch, a hiring plan, a rollout. Surface the assumptions
  you're quietly betting on, and the ways it could fail.
- **Sharpen an argument, essay, or framework before you publish** — is the core idea genuinely
  original and sound, or does it just sound impressive until you strip the jargon?
- **War-game a negotiation or a competitive move** — model exactly how a smart opponent would
  attack your position, and get a recommended counter. (This is "steel-man" mode.)
- **Upgrade the "paste it into ChatGPT and hope" habit** — the same instinct, but several
  independent models actively trying to break your work, with their findings reconciled into
  one clear report.

## This is not an AI "advice panel"

You may have seen people prompt an AI to role-play a panel of famous figures — a virtual
Buffett, Jobs, or Bezos — and ask what they'd think of an idea. That's a fun way to brainstorm,
but it's a fundamentally different thing, in two ways:

- **Those panels are one model wearing costumes.** A single AI imitates every persona, so you
  get one system's blind spots dressed up as a crowd — and each "panelist" is that model's
  *caricature* of a famous person, not real, independent judgment. Here the panel is several
  genuinely different models from different labs. The diversity is real, not theatrical.
- **The aim is the opposite.** An advice panel tells you what a wise-sounding persona might
  *recommend* — it leans toward affirmation and plausible counsel. This tool leans toward
  *falsification*: every model is told to attack your strongest claim and surface the
  assumption that's quietly load-bearing and wrong. You're not collecting opinions — you're
  trying to break the thing before reality does.

---

## Why it works (the one idea worth understanding)

Precision of the *input* is the whole game. A vague request — "tell me what's wrong with
this" — produces vague or sycophantic critique. So this tool puts the rails on the input
and enforces them mechanically:

1. **A precision gate** refuses to run unless the load-bearing fields (the question, the
   frame, the review axes, the artifact, an explicit sensitivity declaration) carry real,
   non-vacuous content. Empty, `TBD`, or hedged values are rejected with a per-field list of
   what's missing — *before any model is called and any money is spent.*
2. **Diversity defeats correlated blind spots.** The reviewers are several frontier models
   from *different* labs (OpenAI, Google, xAI, DeepSeek, etc.), run at high reasoning effort —
   and deliberately a *different lineage than the synthesizer*, so the model organizing the
   critiques isn't also one of the critics. By default that's a non-Claude panel with a Claude
   synthesizer, but it's configurable: whichever lab you pick to synthesize is auto-excluded
   from the panel (see [Model configuration](#model-configuration)).
3. **The synthesis organizes; it does not decide.** One Claude model reads all the
   independent critiques and produces a single structured map. It is told, explicitly, that
   the human is the final judge. It never critiques; it only reconciles.

---

## Requirements

- **[Bun](https://bun.sh) ≥ 1.3** — the only runtime. The tool uses Bun's built-in `fetch`
  and `Bun.YAML`. **There are no npm dependencies and no `bun install` step.**
- **An [OpenRouter](https://openrouter.ai) API key** with credits, and outbound network
  access to `openrouter.ai`. Every model is reached through OpenRouter's single
  OpenAI-compatible endpoint, so you need exactly one key — not one per lab.
- macOS or Linux. (An optional macOS-keychain credential source exists but is not required.)

A full review is **paid inference**: it calls ~6 reasoning models at high effort plus a
synthesizer, so a single run typically costs on the order of a dollar or two. Use
`--dry-run` to assemble and inspect a review with **zero spend**.

---

## Setup

```bash
git clone <your-fork-url> adversarial-review
cd adversarial-review

# Provide your OpenRouter key (any ONE of these):
export OPENROUTER_API_KEY="sk-or-..."                       # simplest
#   …or put it in a mode-600 file and point models.config.yaml -> credential.env_file at it
#   …or set credential.keychain_service (macOS) in models.config.yaml

# Optional sanity checks (no paid inference):
bun test                              # full suite, all mocked — proves your checkout is intact
bun adversarial_review.ts models      # prints the live-resolved model panel (free catalog fetch)
```

The key is read at runtime and **never stored in this directory** — a grep of the repo for
key material returns nothing.

---

## Quick start

**1. Write a thesis packet** (`my-packet.yaml`). This example is a product-strategy review;
the same shape works for a technical design, a framework, or a governance document.

```yaml
schema_version: 2
mode: adversarial

# REQUIRED. "sensitive" forces zero-data-retention routing; "not-sensitive" uses the
# full frontier panel. There is no default — you must declare it.
sensitivity: not-sensitive

# REQUIRED. The bounded thing under review — a file path or inline text.
artifact:
  path: ./docs/launch-plan.md

# REQUIRED. One sentence: exactly what is being decided.
question: >
  Is the proposed three-region launch sequence the fastest path to $1M ARR without
  taking on unacceptable operational risk?

# REQUIRED. What the review IS and ISN'T about.
frame: >
  Review the launch sequencing and risk model. In scope: assumptions, second-order
  effects, failure modes, and a faster alternative if one exists. Out of scope: copy,
  branding, and pricing (decided elsewhere).

# REQUIRED. The review dimensions. Pull a starter set with `bun adversarial_review.ts axes`.
axes:
  - name: load-bearing assumptions
    probe: What must be true for this plan to work, and which of those is unverified?
  - name: failure modes
    probe: What are the concrete ways this fails, and what is the early signal of each?
  - name: higher-leverage alternatives
    probe: Is there a sequencing that reaches the goal faster or at lower risk?

# Optional but recommended.
known_gaps:
  - We do not yet have churn data for the second region.
```

**2. Gate it** (free — catches a weak packet before you spend):

```bash
bun adversarial_review.ts gate --packet my-packet.yaml
```

**3. See what will be sent and how it will route** (free):

```bash
bun adversarial_review.ts describe --packet my-packet.yaml
```

**4. Run it** (paid):

```bash
bun adversarial_review.ts run --packet my-packet.yaml
# writes a timestamped report to ./adversarial-reviews/ and prints its path
```

Add `--dry-run` to assemble the whole review and resolve the live model panel with **no
model calls and no spend**.

---

## The thesis packet — full reference

A packet is a YAML or JSON object (or piped to `--packet -` on stdin). Required rails are
enforced by the precision gate in **both** modes.

| Rail | Required | Meaning |
|---|---|---|
| `mode` | ✅ | `adversarial` (general pressure) or `steel-man` (model a named opponent). |
| `sensitivity` | ✅ | `sensitive` or `not-sensitive`, declared explicitly (see below). Absent is a gap, **not** "false". |
| `artifact` | ✅ | The bounded thing under review: `{ path: ... }` or `{ text: ... }`. |
| `question` | ✅ | One sentence: exactly what is being decided or tested. |
| `frame` | ✅ | The scope — what the review is and isn't about. |
| `axes` | ✅ | A list of `{ name, probe }`. The `probe` is a NEUTRAL question, never a planted conclusion. |
| `evidence.include` | optional | List of `{ path }` / `{ text }` the reviewers may use. |
| `evidence.exclude` | optional | List of `{ item, why }` — what must NOT be seen, and the reason (a contamination guard). |
| `known_gaps` | optional | Named uncertainties you already know about. |
| `stance` | optional | Adversarial disposition. Has a sensible default. |
| `output_shape` | optional | Per-finding format + severity ranking. Has a default. |

**Steel-man mode adds (all required in that mode):**

| Rail | Meaning |
|---|---|
| `opponent.identity` | Who the opponent is. |
| `opponent.goal` | What they want / their incentives. |
| `opponent.information` | What THEY would actually know. The opponent is modeled **only** from this — never from your own internal reasoning. |

---

## Sensitivity & zero-data-retention (ZDR)

`sensitivity` is a **required, gated rail** because it is the one input that decides whether
your material can reach data-retaining model endpoints.

- **`sensitive`** → ZDR is forced ON regardless of flags. The run routes only to
  zero-retention endpoints, and a `--no-zdr` (or `zdr: false` in the packet) override is
  **hard-refused** with a non-zero exit — never silently downgraded. If zero ZDR-capable
  reviewers can be resolved, the run hard-fails rather than leaking.
- **`not-sensitive`** → ZDR follows the per-run toggle: off by default (full frontier panel),
  on if you pass `--zdr`.
- **Absent** → the precision gate refuses to run and tells you to declare it. There is no
  implicit default, by design: the safety-deciding input is never left to chance.

`describe` shows you the *resulting* routing (`ZDR routing: ON / off / REFUSED`) before any
spend, so you can confirm where the material will go.

---

## Modes

- **Adversarial** — each model attacks the artifact. The synthesis returns, per pillar of
  your thesis: `HOLDS / WEAK / BROKEN / UNTESTED`, consensus vs. outlier findings, and a
  single severity-ranked fix list.
- **Steel man** — each model role-plays a named opponent using only what that opponent would
  know. The synthesis returns one game-theory playbook: the opponent's most likely strategy,
  the vulnerabilities they'd exploit, and a recommended counter-strategy
  (move / basis / expected-response / counter / end-state).

### Packet Health (every adversarial run)

The synthesis opens with a short **Packet Health** section *before* the verdicts: it reports
whether the panel could actually use your packet, or whether a gap (missing evidence, an
ambiguous question, an axis nobody could probe) limited the review. A pillar the panel could
not genuinely test is marked **UNTESTED** and is *never* folded into HOLDS — "nobody could
attack it" is not "it survived attack." This keeps the tool honest about its own reliability.

---

## Axis-sets (bundled, editable)

Axis-sets are starter review dimensions, shipped as plain YAML in `axis-sets/`. List them:

```bash
bun adversarial_review.ts axes                          # all sets
bun adversarial_review.ts axes --review-type strategy   # the best-matching set
```

Three ship by default, and they're examples, not limits — copy one and edit, or write your
own:

- **`strategy-decision`** — assumptions, second-order effects, failure modes, stakeholder
  incentives, what-would-have-to-be-true. For plans and decisions.
- **`structural-claim`** — non-obviousness, substrate-transfer reality, reverse-direction
  test, prescription, vocabulary-strip. For intellectual frameworks and conceptual models.
- **`legal-accuracy`** — citation accuracy, governing-law accuracy, omissions, over-/under-
  statement of a party's power, named-scenario soundness. For contracts and governance docs.

Each axis carries a **neutral probe** — a question, never an expected finding. A probe that
names its own conclusion would anchor the reviewer the way a leading question anchors an
interview subject.

---

## Saved templates (recurring reviews)

For a review whose shape is fixed and only the artifact changes (e.g. running the same
council over each new article), fill a template once and feed just the artifact per run:

```bash
bun adversarial_review.ts run \
  --template packet-templates/saved-recurring.yaml \
  --artifact ./new-article.md
```

`packet-templates/one-off.yaml` is a blank, fully-commented starting point;
`packet-templates/saved-recurring.yaml` is a locked recurring example.

---

## Model configuration

`models.config.yaml` names **labs, not model slugs**. Each run resolves the lab's *current*
flagship reasoner from the live OpenRouter catalog by release date, so the config never goes
stale as new models ship. Key points:

- The **synthesizer's lab is auto-excluded from the reviewer panel** — the model that
  organizes the critiques can't also be one of the critics. By default the synthesizer is
  Claude and the panel is the six non-Claude labs, but it's your choice: pick any
  `synthesizer_lab`, and list any labs in `reviewer_labs`. **Running Codex/GPT as your daily
  driver?** Add `anthropic` to `reviewer_labs` to put Opus on the panel, and set
  `synthesizer_lab` to a different lab — so the models attacking your work don't share the
  blind spots of the model you drafted it with.
- Failover walks **down the same lab's chain** (a newer model → an older one in the same
  family), never across labs — diversity is preserved over chasing the absolute frontier.
- A response is validated as a real critique, not just an HTTP 200: a refusal or restriction
  blob triggers in-lab failover.
- Synthesis waits for **every** lab slot to resolve (a barrier), with per-request timeouts and
  per-slot deadlines so one hung model can't stall the run forever.

Edit the `reviewer_labs` list to change the panel, `reasoning` to change effort,
`credential` to change where the key is read from, and `defaults` to tune timeouts.

---

## Driving this from an agent

If you're an AI agent operating this tool, the intended flow is:

1. **Build the packet from a conversation, then validate it.** Walk the human (or another
   agent) through the rails — artifact, the real question, the frame, who the opponent is —
   assemble the YAML, and run `gate` to confirm it passes the precision gate. If it's
   rejected, the output names exactly which rail is vacuous; fix those and re-gate.
2. **Always `describe` before you spend.** It echoes the assembled packet and the resulting
   ZDR routing. Confirm the routing matches the sensitivity of the material *before* calling
   `run`. A `sensitive` packet shown as `ZDR routing: ON` is correct; shown as `REFUSED`
   means a contradictory `--no-zdr`/`zdr:false` is present and must be removed.
3. **`run --dry-run` to preview the resolved panel** with no spend, then `run` for real once
   the packet and routing are confirmed.
4. **Treat paid runs as a spend gate.** A real `run` calls many reasoning models. If you are
   acting autonomously, get explicit go-ahead before a paid run, exactly as you would for any
   other metered action.
5. **The output is an input to a decision, not the decision.** The synthesis organizes the
   attacks; surface it to the human and let them judge.

Every subcommand prints JSON (or, for `describe`, a plain echo) to stdout and progress to
stderr, so it's straightforward to parse and chain.

---

## Tests

```bash
bun test          # full suite — entirely mocked, no network, no spend
```

The model fan-out, the precision gate, the credential resolver, the ZDR coupling, and the
report writer are all covered against an injected fake OpenRouter endpoint, so the suite runs
offline and proves a checkout is intact before you spend a cent.

---

## License

Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0). See
[`LICENSE`](LICENSE). You may share and adapt the material, including commercially, as long
as you give appropriate credit and license your derivatives under the same terms.
