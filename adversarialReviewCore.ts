/**
 * adversarialReviewCore.ts — PURE core for the AdversarialReview skill.
 *
 * No I/O, no fetch, no env, no fs, no Bun-specific APIs. Everything here takes
 * data and returns data so it stays unit-testable and (via a Core/CLI split)
 * embeddable. File reads, network calls, the OpenRouter client,
 * and report writing all live in the CLI wrapper (adversarial_review.ts).
 *
 * The load-bearing piece is the PRECISION GATE: it refuses to let a review fan
 * out unless the load-bearing input rails carry real, non-vacuous content. The
 * quality ceiling of a judgment-heavy review is set by input precision, not model
 * strength — so the rails go on the input, enforced mechanically, the same way a
 * spec-completeness validator refuses a hedged spec.
 */

export const PACKET_SCHEMA_VERSION = 2;

export type ReviewMode = "adversarial" | "steel-man";

/**
 * Data-sensitivity declaration. REQUIRED on every packet, in BOTH modes, and
 * carried as an EXPLICIT enum — never a boolean defaulting to a value. "Absent"
 * is a gap the precision gate refuses on, NOT an implicit "not-sensitive". This
 * is the one input that decides whether sensitive material (confidential,
 * regulated, or pre-publication content) may reach data-retaining endpoints, so it
 * is gated with the same discipline as every other load-bearing rail.
 *   - `sensitive`     → ZDR forced ON; any --no-zdr / zdr:false override is REFUSED.
 *   - `not-sensitive` → ZDR follows the per-run toggle (default off).
 */
export type SensitivityLevel = "sensitive" | "not-sensitive";

/** A bounded source: a file path OR inline text. At least one must be present. */
export interface SourceRef {
  path?: string;
  text?: string;
  label?: string;
}

/** Evidence scoped both ways — what the review SEES and what it must NOT see. */
export interface Evidence {
  include: SourceRef[];
  /** Each exclusion names WHAT must not be seen and WHY (contamination guard). */
  exclude: { item: string; why: string }[];
}

/** A single review dimension. `name` is the axis; `probe` is a NEUTRAL question. */
export interface Axis {
  name: string;
  /**
   * A neutral probe phrased as a question, NOT as an expected finding. A probe
   * that names its conclusion ("show the citation is wrong") anchors the reviewer
   * the same way a leading question anchors an interview subject. Keep it open.
   * (A probe that names its conclusion is a leading question — avoid it.)
   */
  probe?: string;
}

export interface OutputShape {
  perFinding: string;
  severityRanking: string[];
}

/** Steel-man only: the opponent is modeled ONLY from information scoped as theirs. */
export interface Opponent {
  identity: string;
  goal: string;
  /** What THEY would actually know — never the author's own internal reasoning. */
  information: SourceRef[];
}

export interface ThesisPacket {
  schema_version: number;
  mode: ReviewMode;
  /**
   * Explicit data-sensitivity declaration — REQUIRED in both modes. `sensitive`
   * forces ZDR on and refuses any --no-zdr/zdr:false override; `not-sensitive`
   * follows the per-run ZDR toggle. Absent is a precision-gate gap, not "false".
   */
  sensitivity?: SensitivityLevel;
  /** The named, bounded thing under review. */
  artifact: SourceRef;
  /** One sentence: exactly what is being decided/tested. */
  question: string;
  /** What the review IS and ISN'T about (its scope). */
  frame: string;
  /** The explicit review dimensions. At least one, each with a real name. */
  axes: Axis[];
  evidence?: Evidence;
  known_gaps?: string[];
  stance?: string;
  output_shape?: OutputShape;
  /** Required in steel-man mode; ignored in adversarial mode. */
  opponent?: Opponent;
  meta?: { title?: string; created?: string; review_type?: string };
}

export const DEFAULT_STANCE =
  "Assume the author wants to be proven wrong; endorsement is not data. Attack the " +
  "strongest version of the claim, not a strawman. If a pillar holds, say so plainly " +
  "rather than manufacturing a weakness.";

export const DEFAULT_OUTPUT_SHAPE: OutputShape = {
  perFinding:
    "For each finding: the axis it came from; the specific claim/pillar it targets; " +
    "a verdict of HOLDS | WEAK | BROKEN; a severity of critical | high | medium | low; " +
    "the concrete evidence or reasoning behind it; and a specific fix or counter.",
  severityRanking: ["critical", "high", "medium", "low"],
};

// ---------------------------------------------------------------------------
// Vacuity detection — mirrors the spec-completeness validator's refuse-hedged rule.
// ---------------------------------------------------------------------------

const PLACEHOLDER_TOKENS = new Set([
  "tbd",
  "to be determined",
  "todo",
  "to do",
  "n/a",
  "na",
  "none",
  "null",
  "tba",
  "tbc",
  "to be confirmed",
  "?",
  "??",
  "???",
  "xxx",
  "fixme",
  "placeholder",
  "...",
  "..",
  "-",
  "--",
  "—",
  "[fill in]",
  "fill in",
]);

const HEDGE_ONLY = new Set([
  "not sure",
  "unclear",
  "maybe",
  "dunno",
  "i don't know",
  "i dont know",
  "idk",
  "unsure",
  "no idea",
  "it depends",
  "depends",
  "various",
  "stuff",
  "things",
  "something",
]);

/**
 * A required rail value is vacuous when it carries no real, reviewable content:
 * empty/whitespace, a placeholder token, a bare hedge, or too short to mean anything.
 * NOTE: a long value that merely *contains* the word "maybe" is fine — only a value
 * that IS essentially a hedge fails, so legitimate prose is never rejected.
 */
export function isVacuous(value: string | undefined | null): boolean {
  if (value == null) return true;
  const t = value.trim().toLowerCase();
  if (t.length === 0) return true;
  if (PLACEHOLDER_TOKENS.has(t)) return true;
  if (HEDGE_ONLY.has(t)) return true;
  if (t.replace(/[^a-z0-9]/g, "").length < 3) return true; // e.g. "?!", "--", "n/a"
  return false;
}

/** A SourceRef is empty when neither a path nor inline text carries content. */
export function sourceRefIsEmpty(ref: SourceRef | undefined | null): boolean {
  if (ref == null) return true;
  return isVacuous(ref.path) && isVacuous(ref.text);
}

// ---------------------------------------------------------------------------
// Normalization — apply defaults & coerce a parsed object into a ThesisPacket.
// Pure: takes an already-parsed object (the CLI does the YAML/JSON file read).
// ---------------------------------------------------------------------------

export interface NormalizeResult {
  packet: ThesisPacket;
  warnings: string[];
}

function coerceSourceRef(raw: any): SourceRef {
  if (raw == null) return {};
  if (typeof raw === "string") return { text: raw };
  return {
    path: typeof raw.path === "string" ? raw.path : undefined,
    text: typeof raw.text === "string" ? raw.text : undefined,
    label: typeof raw.label === "string" ? raw.label : undefined,
  };
}

function coerceSourceRefList(raw: any): SourceRef[] {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map(coerceSourceRef).filter((r) => !(r.path == null && r.text == null && r.label == null));
}

function coerceAxes(raw: any): Axis[] {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map((a): Axis | null => {
      if (a == null) return null;
      if (typeof a === "string") return { name: a };
      if (typeof a.name === "string") return { name: a.name, probe: typeof a.probe === "string" ? a.probe : undefined };
      return null;
    })
    .filter((a): a is Axis => a != null);
}

/**
 * Coerce a raw sensitivity value to the canonical enum. Accepts the two canonical
 * strings plus common separator/spelling variants. Anything else — empty, an
 * unrecognized string, or a boolean (the spec is explicit that sensitivity is NOT
 * a boolean) — yields `undefined` so the precision gate refuses it: absent or
 * unrecognized is a gap, never an implicit default. A present-but-unrecognized
 * value also returns a warning so the operator sees WHY it didn't take.
 */
export function coerceSensitivity(raw: any): { value?: SensitivityLevel; warning?: string } {
  if (raw == null) return {};
  if (typeof raw !== "string") {
    return {
      warning: `sensitivity must be the string "sensitive" or "not-sensitive", not a ${typeof raw} (${JSON.stringify(
        raw,
      )}); treating as undeclared so the precision gate refuses it.`,
    };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {}; // empty = undeclared; the gate handles it cleanly
  const t = trimmed.toLowerCase().replace(/[\s_]+/g, "-");
  if (t === "sensitive") return { value: "sensitive" };
  if (t === "not-sensitive" || t === "nonsensitive" || t === "non-sensitive" || t === "notsensitive") {
    return { value: "not-sensitive" };
  }
  return { warning: `Unrecognized sensitivity "${raw}"; declare exactly "sensitive" or "not-sensitive". Treating as undeclared.` };
}

/**
 * Coerce a parsed packet object into a normalized ThesisPacket, applying defaults.
 * Does NOT validate — call validatePacket() after. Unknown fields are dropped.
 */
export function normalizePacket(raw: any): NormalizeResult {
  const warnings: string[] = [];
  if (raw == null || typeof raw !== "object") {
    // Return a shell; validation will reject it with the right gaps.
    return {
      packet: {
        schema_version: PACKET_SCHEMA_VERSION,
        mode: "adversarial",
        artifact: {},
        question: "",
        frame: "",
        axes: [],
      },
      warnings: ["Packet was not an object."],
    };
  }

  const mode: ReviewMode = raw.mode === "steel-man" || raw.mode === "steelman" ? "steel-man" : "adversarial";
  if (raw.mode && raw.mode !== "adversarial" && raw.mode !== "steel-man" && raw.mode !== "steelman") {
    warnings.push(`Unrecognized mode "${raw.mode}"; defaulting to "adversarial".`);
  }

  // sensitivity is NEVER defaulted — undeclared/unrecognized stays undefined so the
  // gate refuses it. A present-but-bad value carries a warning explaining why.
  const sens = coerceSensitivity(raw.sensitivity);
  if (sens.warning) warnings.push(sens.warning);

  const sv = typeof raw.schema_version === "number" ? raw.schema_version : PACKET_SCHEMA_VERSION;
  if (typeof raw.schema_version === "number" && raw.schema_version > PACKET_SCHEMA_VERSION) {
    warnings.push(
      `Packet schema_version ${raw.schema_version} is newer than this skill (${PACKET_SCHEMA_VERSION}); proceeding best-effort.`,
    );
  }

  const evidenceRaw = raw.evidence;
  const evidence: Evidence | undefined = evidenceRaw
    ? {
        include: coerceSourceRefList(evidenceRaw.include),
        exclude: Array.isArray(evidenceRaw.exclude)
          ? evidenceRaw.exclude
              .map((e: any) =>
                typeof e === "string"
                  ? { item: e, why: "" }
                  : { item: String(e?.item ?? ""), why: String(e?.why ?? "") },
              )
              .filter((e: any) => e.item.trim().length > 0)
          : [],
      }
    : undefined;

  const opponent: Opponent | undefined = raw.opponent
    ? {
        identity: typeof raw.opponent.identity === "string" ? raw.opponent.identity : "",
        goal: typeof raw.opponent.goal === "string" ? raw.opponent.goal : "",
        information: coerceSourceRefList(raw.opponent.information),
      }
    : undefined;

  const packet: ThesisPacket = {
    schema_version: sv,
    mode,
    sensitivity: sens.value,
    artifact: coerceSourceRef(raw.artifact),
    question: typeof raw.question === "string" ? raw.question : "",
    frame: typeof raw.frame === "string" ? raw.frame : "",
    axes: coerceAxes(raw.axes),
    evidence,
    known_gaps: Array.isArray(raw.known_gaps)
      ? raw.known_gaps.map((g: any) => String(g)).filter((g: string) => g.trim().length > 0)
      : undefined,
    stance: isVacuous(raw.stance) ? DEFAULT_STANCE : String(raw.stance),
    output_shape:
      raw.output_shape && typeof raw.output_shape === "object"
        ? {
            perFinding: isVacuous(raw.output_shape.perFinding)
              ? DEFAULT_OUTPUT_SHAPE.perFinding
              : String(raw.output_shape.perFinding),
            severityRanking: Array.isArray(raw.output_shape.severityRanking)
              ? raw.output_shape.severityRanking.map((s: any) => String(s))
              : DEFAULT_OUTPUT_SHAPE.severityRanking,
          }
        : DEFAULT_OUTPUT_SHAPE,
    opponent,
    meta:
      raw.meta && typeof raw.meta === "object"
        ? {
            title: typeof raw.meta.title === "string" ? raw.meta.title : undefined,
            created: typeof raw.meta.created === "string" ? raw.meta.created : undefined,
            review_type: typeof raw.meta.review_type === "string" ? raw.meta.review_type : undefined,
          }
        : undefined,
  };

  return { packet, warnings };
}

// ---------------------------------------------------------------------------
// The precision gate.
// ---------------------------------------------------------------------------

export interface Gap {
  rail: string;
  reason: string;
}

export type GateResult =
  | { ok: true; warnings: string[] }
  | { ok: false; gaps: Gap[] };

/**
 * The precision gate. Refuses to fan out unless every load-bearing rail carries
 * real, non-vacuous content. Returns ALL gaps (not just the first) so the caller
 * can show a complete per-rail gap list and the operator fixes everything at once.
 *
 * Required in both modes: artifact, question, frame, axes (≥1 with a real name).
 * Steel-man adds: opponent.identity, opponent.goal, opponent.information (≥1 source).
 */
export function validatePacket(packet: ThesisPacket): GateResult {
  const gaps: Gap[] = [];
  const warnings: string[] = [];

  // artifact — at least one of path/text must carry content.
  if (sourceRefIsEmpty(packet.artifact)) {
    gaps.push({
      rail: "artifact",
      reason: "Name the bounded thing under review — a file path or inline text. Got nothing usable.",
    });
  }

  // question — one sentence on exactly what is being decided/tested.
  if (isVacuous(packet.question)) {
    gaps.push({
      rail: "question",
      reason: "State, in one sentence, exactly what is being decided or tested. A review without a question fans out into noise.",
    });
  }

  // frame — what the review IS and ISN'T about.
  if (isVacuous(packet.frame)) {
    gaps.push({
      rail: "frame",
      reason: "Define the scope — what this review IS and ISN'T about. Without it the reviewers drift off-target.",
    });
  }

  // axes — at least one, each with a non-vacuous name.
  if (!Array.isArray(packet.axes) || packet.axes.length === 0) {
    gaps.push({
      rail: "axes",
      reason: 'Give the explicit review dimensions. "Find problems" is not an axis — name the angles (e.g. citation accuracy, second-order effects).',
    });
  } else {
    const bad = packet.axes.filter((a) => isVacuous(a.name));
    if (bad.length > 0) {
      gaps.push({
        rail: "axes",
        reason: `${bad.length} axis entr${bad.length === 1 ? "y is" : "ies are"} empty or placeholder. Every axis needs a real name.`,
      });
    }
    // Soft: probes that name a conclusion anchor the reviewer — warn, don't block.
    for (const a of packet.axes) {
      if (a.probe && /\b(prove|show that|demonstrate that|confirm that)\b/i.test(a.probe)) {
        warnings.push(
          `Axis "${a.name}" probe reads as a leading question ("${a.probe.slice(0, 60)}…"). A neutral probe gets a more honest review.`,
        );
      }
    }
  }

  // sensitivity — REQUIRED in BOTH modes. Absent or unrecognized is a gap, NOT
  // an implicit "not-sensitive". This is the rail that decides whether the
  // material may reach data-retaining endpoints, so the gate refuses to fan out
  // until the operator declares it. (The conversational builder asks this; if it
  // forgot, this gap is the question it must put to the operator.)
  if (packet.sensitivity !== "sensitive" && packet.sensitivity !== "not-sensitive") {
    gaps.push({
      rail: "sensitivity",
      reason:
        'Declare whether this material is sensitive. Set sensitivity to "sensitive" or "not-sensitive" — ' +
        'there is no default; absent is treated as a gap, not as "not-sensitive". "sensitive" forces ' +
        "zero-data-retention routing (and refuses any --no-zdr override); \"not-sensitive\" follows the run's ZDR toggle.",
    });
  }

  // Steel-man mode: opponent rails are required.
  if (packet.mode === "steel-man") {
    if (packet.opponent == null) {
      gaps.push({
        rail: "opponent",
        reason: "Steel-man mode requires an opponent (identity, goal, information). None provided.",
      });
    } else {
      if (isVacuous(packet.opponent.identity)) {
        gaps.push({ rail: "opponent.identity", reason: "Name who the opponent is." });
      }
      if (isVacuous(packet.opponent.goal)) {
        gaps.push({ rail: "opponent.goal", reason: "State what the opponent wants / their incentives." });
      }
      if (!packet.opponent.information || packet.opponent.information.length === 0) {
        gaps.push({
          rail: "opponent.information",
          reason:
            "Scope what the OPPONENT would actually know. The steel man is built only from their information — never your own internal reasoning.",
        });
      } else if (packet.opponent.information.every(sourceRefIsEmpty)) {
        gaps.push({
          rail: "opponent.information",
          reason: "opponent.information has entries but none carry a path or text.",
        });
      }
    }
  }

  // Soft sufficiency check on evidence excludes: an exclude with no `why` is a weak guard.
  if (packet.evidence?.exclude) {
    for (const ex of packet.evidence.exclude) {
      if (isVacuous(ex.why)) {
        warnings.push(`Evidence exclusion "${ex.item}" has no stated reason — say why it must not be seen (contamination guard).`);
      }
    }
  }

  if (gaps.length > 0) return { ok: false, gaps };
  return { ok: true, warnings };
}

// ---------------------------------------------------------------------------
// ZDR resolution — sensitivity is the GATE on routing. `sensitive` forces ZDR on
// and refuses any explicit downgrade; `not-sensitive` follows the per-run toggle.
// Pure so the safety coupling is unit-testable without a network or the CLI.
// (See the project doc "Addendum — Phase 5: Sensitivity as a Gated Rail".)
// ---------------------------------------------------------------------------

export interface ZdrInputs {
  /** The packet's declared sensitivity (post-normalize). */
  sensitivity?: SensitivityLevel;
  /** `--no-zdr` flag present on the CLI. */
  explicitNoZdr: boolean;
  /** `--zdr` flag present on the CLI. */
  explicitZdr: boolean;
  /** A boolean `zdr:` field in the packet, or undefined if absent. */
  packetZdr?: boolean;
  /** The config default, used only when nothing more specific decides. */
  configDefault: boolean;
}

export type ZdrDecision =
  | { ok: true; zdr: boolean; forced: boolean; reason: string }
  | { ok: false; error: string };

/**
 * Decide the ZDR routing for a run from the (gated) sensitivity rail plus the
 * per-run toggle inputs. The safety contract:
 *   - `sensitive` → ZDR forced ON regardless of config default or the absence of
 *     --zdr. Any explicit downgrade (--no-zdr, or zdr:false in the packet) is
 *     REFUSED with a clear error — NEVER silently downgraded — even if --zdr is
 *     also present (a sensitive packet that internally says zdr:false is the exact
 *     silent-leak shape this rail exists to kill; the operator must clean it up).
 *   - `not-sensitive` (or, defensively, undeclared — the gate blocks undeclared
 *     before the CLI calls this, but the resolution stays total) → ZDR follows the
 *     existing precedence: --no-zdr > --zdr > packet zdr: > config default.
 */
export function resolveZdrDecision(inp: ZdrInputs): ZdrDecision {
  const explicitOff = inp.explicitNoZdr || inp.packetZdr === false;

  if (inp.sensitivity === "sensitive") {
    if (explicitOff) {
      const src = inp.explicitNoZdr ? "--no-zdr" : "zdr: false in the packet";
      return {
        ok: false,
        error:
          `sensitivity is "sensitive" but ZDR was explicitly turned off (${src}). ` +
          "A sensitive review must never route to data-retaining endpoints, so this is REFUSED — not silently downgraded. " +
          "Remove the override (a sensitive run forces ZDR on), or re-declare the material as not-sensitive if it truly is not.",
      };
    }
    return { ok: true, zdr: true, forced: true, reason: 'sensitivity="sensitive" forces ZDR on' };
  }

  let zdr: boolean;
  let reason: string;
  if (inp.explicitNoZdr) {
    zdr = false;
    reason = "--no-zdr";
  } else if (inp.explicitZdr) {
    zdr = true;
    reason = "--zdr";
  } else if (typeof inp.packetZdr === "boolean") {
    zdr = inp.packetZdr;
    reason = `packet zdr:${inp.packetZdr}`;
  } else {
    zdr = inp.configDefault;
    reason = `config default (${inp.configDefault})`;
  }
  return { ok: true, zdr, forced: false, reason };
}

// ---------------------------------------------------------------------------
// Panel sufficiency — the "never an empty review" contract, plus the sensitive-run
// zero-ZDR-reviewer hard-fail. Pure so both branches are unit-testable without a
// live fan-out.
// ---------------------------------------------------------------------------

export interface PanelEval {
  okCount: number;
  total: number;
  /** "family: error" summaries for the failed labs, for the message. */
  labErrors: string[];
}

/**
 * Decide whether the post-fan-out panel is sufficient to proceed. A sensitive run
 * (ZDR forced on) that resolves ZERO successful reviewer labs hard-fails with a
 * sensitivity-specific message — every lab's chain was ZDR-blocked or failed, and a
 * sensitive run must not fall back to data-retaining endpoints. Otherwise the
 * generic "at least panelMin reviewers" contract applies (zero reviewers => no
 * empty review, ever).
 */
export function evaluatePanel(
  e: PanelEval,
  opts: { panelMin: number; sensitiveZdrForced: boolean },
): { ok: true } | { ok: false; message: string } {
  const errs = e.labErrors.length ? ` Failed labs: ${e.labErrors.join("; ")}.` : "";
  if (opts.sensitiveZdrForced && e.okCount === 0) {
    return {
      ok: false,
      message:
        "sensitive review resolved ZERO ZDR-capable reviewer labs — every lab's chain was blocked or failed under enforced ZDR. " +
        "Refusing to proceed: a sensitive run must not fall back to data-retaining endpoints, and an empty review is never produced." +
        errs,
    };
  }
  if (e.okCount < opts.panelMin) {
    return {
      ok: false,
      message: `too few successful reviewer labs (${e.okCount}, need ${opts.panelMin}). No review produced.${errs}`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Credential resolution (pure + injectable).
// ---------------------------------------------------------------------------
// The skill runs locally on whatever host invokes it — there is no fixed run host.
// Each machine supplies its own OpenRouter key from a host-local source. Resolution
// is pure + injectable so every branch — including the "a generic OPENROUTER_API_KEY
// in the env must NOT bleed in" guard — is unit-tested with no filesystem, no
// network, and no spend.

/**
 * Read `VARNAME=value` from env-file text. Honors an optional `export ` prefix and
 * strips surrounding single/double quotes. Returns null if the var is absent or its
 * value is empty.
 */
export function parseEnvFileVar(text: string, varName: string): string | null {
  const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*(?:export\\s+)?${esc}\\s*=\\s*(.+?)\\s*$`, "m");
  const m = text.match(re);
  if (!m) return null;
  const v = m[1].replace(/^["']|["']$/g, "").trim();
  return v.length > 0 ? v : null;
}

export interface CredentialFileSource {
  path: string;
  /** The variable name to read from the file at `path`. */
  var: string;
}

export interface CredentialPlan {
  /**
   * The env var name read from the process env first. The fallbackFiles below are
   * FILE-only (never env), so a *different* generic OpenRouter key a user happens to
   * have exported in their shell can't be silently picked up here. If you run more
   * than one OpenRouter account on a machine, set a distinct primaryEnv name so the
   * tool's key and the other account's key can't be confused.
   */
  primaryEnv: string;
  /** Primary env file holding `primaryEnv=...` (a dedicated mode-600 file). */
  envFile?: string;
  /** Login-keychain service, consulted on interactive macOS only. */
  keychainService?: string;
  /**
   * Host-local fallbacks, tried in order after the dedicated sources above. FILE
   * sources only (path + var) — never an env var, so a generic OPENROUTER_API_KEY
   * exported in the shell can never bleed in. Adding a new host is a one-line config
   * change: drop the machine's key in a local file and name it here.
   */
  fallbackFiles?: CredentialFileSource[];
}

export interface CredentialIO {
  getEnv: (name: string) => string | undefined;
  /** Returns file contents, or null if the file is absent/unreadable. */
  readFile: (path: string) => string | null;
  /** Returns the keychain secret, or null. Only invoked when platform === "darwin". */
  readKeychain?: (service: string) => string | null;
  platform: string;
}

export type CredentialResult = { key: string; source: string } | null;

/**
 * Resolve an OpenRouter key from the host-local sources, first hit wins:
 *   1. $primaryEnv   2. primary envFile   3. keychain (darwin only)   4. fallback files.
 * Returns the key plus a non-secret `source` label for transparency (e.g. which host
 * file supplied it). The env var named in `primaryEnv` is the ONLY env source read;
 * fallback files are read by path, so a generic OPENROUTER_API_KEY in the shell env is
 * structurally unreachable.
 */
export function resolveCredential(plan: CredentialPlan, io: CredentialIO): CredentialResult {
  const fromEnv = io.getEnv(plan.primaryEnv);
  if (fromEnv && fromEnv.trim().length > 0) return { key: fromEnv.trim(), source: `env:${plan.primaryEnv}` };

  if (plan.envFile) {
    const text = io.readFile(plan.envFile);
    if (text != null) {
      const v = parseEnvFileVar(text, plan.primaryEnv);
      if (v) return { key: v, source: `file:${plan.envFile}` };
    }
  }

  if (plan.keychainService && io.readKeychain && io.platform === "darwin") {
    const v = io.readKeychain(plan.keychainService);
    if (v && v.trim().length > 0) return { key: v.trim(), source: `keychain:${plan.keychainService}` };
  }

  for (const fb of plan.fallbackFiles ?? []) {
    const text = io.readFile(fb.path);
    if (text != null) {
      const v = parseEnvFileVar(text, fb.var);
      if (v) return { key: v, source: `file:${fb.path}` };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Serialization & human echo (pure).
// ---------------------------------------------------------------------------

/** Stable JSON serialization of a packet (for saved templates / audit). */
export function serializePacket(packet: ThesisPacket): string {
  return JSON.stringify(packet, null, 2);
}

function sourceRefLabel(ref: SourceRef): string {
  if (!isVacuous(ref.path)) return ref.path as string;
  if (!isVacuous(ref.text)) {
    const t = (ref.text as string).trim().replace(/\s+/g, " ");
    return `inline: "${t.slice(0, 80)}${t.length > 80 ? "…" : ""}"`;
  }
  return "(empty)";
}

/** Plain-language description of the sensitivity declaration + its routing consequence. */
export function describeSensitivity(s: SensitivityLevel | undefined): string {
  if (s === "sensitive") return "SENSITIVE — forces zero-data-retention (ZDR) routing ON; a --no-zdr / zdr:false override will be REFUSED";
  if (s === "not-sensitive") return "not-sensitive — ZDR follows the run toggle (default off; --zdr to enforce)";
  return "(NOT DECLARED — the precision gate will refuse to run until this is set to sensitive or not-sensitive)";
}

/**
 * A human-readable echo of the packet, for the conversational builder to show
 * back before running. Plain text, no model jargon.
 */
export function describePacket(packet: ThesisPacket): string {
  const lines: string[] = [];
  lines.push(`Mode:        ${packet.mode === "steel-man" ? "Steel man (persona-modeled)" : "Adversarial (general pressure)"}`);
  lines.push(`Sensitivity: ${describeSensitivity(packet.sensitivity)}`);
  lines.push(`Artifact:    ${sourceRefLabel(packet.artifact)}`);
  lines.push(`Question:    ${packet.question}`);
  lines.push(`Frame:       ${packet.frame}`);
  lines.push(`Axes:        ${packet.axes.map((a) => a.name).join(" · ")}`);
  if (packet.evidence?.include?.length) {
    lines.push(`Evidence (include): ${packet.evidence.include.map(sourceRefLabel).join("; ")}`);
  }
  if (packet.evidence?.exclude?.length) {
    lines.push(`Evidence (exclude): ${packet.evidence.exclude.map((e) => `${e.item} (${e.why || "no reason given"})`).join("; ")}`);
  }
  if (packet.known_gaps?.length) {
    lines.push(`Known gaps: ${packet.known_gaps.join("; ")}`);
  }
  if (packet.mode === "steel-man" && packet.opponent) {
    lines.push(`Opponent:  ${packet.opponent.identity}`);
    lines.push(`  Goal:    ${packet.opponent.goal}`);
    lines.push(`  Knows:   ${packet.opponent.information.map(sourceRefLabel).join("; ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Model specs & results — shared types used by the OpenRouter client, the
// synthesis pass, and the report writer. Kept in core so they're pure data.
// ---------------------------------------------------------------------------

export interface ModelSpec {
  slug: string;
  family: string;
  role?: "reviewer" | "synthesizer";
  enabled?: boolean;
  reasoning?: { effort?: string; [k: string]: any };
  verify_required?: boolean;
  note?: string;
}

export interface ReviewerResult {
  slug: string; // the model that actually produced the work product (post-failover)
  family: string; // the lab
  status: "ok" | "failed";
  critique?: string;
  error?: string;
  attempts?: number;
  latencyMs?: number;
  provider?: string;
  /** How many earlier models in the lab's chain were walked past before success. */
  fallbacksUsed?: number;
  /** The failover path: what each tried model in the lab chain did. */
  trail?: { slug: string; outcome: string }[];
}

const CLAUDE_FAMILIES = new Set(["anthropic", "claude"]);

/**
 * True if a slug/family is a Claude/Anthropic model. Used to enforce the hard rule
 * that REVIEWERS are non-Claude (correlated training data => correlated blind spots)
 * and that the SYNTHESIZER is Claude.
 */
export function isClaudeModel(slug: string, family?: string): boolean {
  if (family && CLAUDE_FAMILIES.has(family.toLowerCase())) return true;
  const s = (slug || "").toLowerCase();
  return s.startsWith("anthropic/") || s.includes("claude");
}

// ---------------------------------------------------------------------------
// Prompt construction (pure). The CLI reads the bundled scaffold file and
// resolves artifact/evidence/opponent text from disk, then calls fillScaffold.
// ---------------------------------------------------------------------------

export interface ResolvedSources {
  /** The artifact body (file contents or inline text), already read by the CLI. */
  artifactText: string;
  /** Concatenated include-evidence text for the adversarial pass. */
  evidenceText: string;
  /** Concatenated opponent.information text for the steel-man pass. */
  opponentInfoText: string;
}

export function renderAxes(axes: Axis[]): string {
  return axes
    .map((a, i) => {
      const probe = a.probe && a.probe.trim().length > 0 ? `\n   Probe: ${a.probe.trim()}` : "";
      return `${i + 1}. ${a.name}${probe}`;
    })
    .join("\n");
}

export function renderKnownGaps(gaps: string[] | undefined): string {
  if (!gaps || gaps.length === 0) return "(none named)";
  return gaps.map((g) => `- ${g}`).join("\n");
}

export function renderOutputShape(shape: OutputShape): string {
  return (
    `${shape.perFinding}\n` +
    `Rank findings by severity, most to least severe: ${shape.severityRanking.join(" > ")}.`
  );
}

/**
 * Fill a bundled scaffold's {{PLACEHOLDER}} tokens from the packet + resolved text.
 * Replaces every occurrence of each token (global). Returns the finished prompt.
 */
export function fillScaffold(scaffoldText: string, packet: ThesisPacket, resolved: ResolvedSources): string {
  const repl: Record<string, string> = {
    "{{QUESTION}}": packet.question,
    "{{FRAME}}": packet.frame,
    "{{STANCE}}": packet.stance ?? DEFAULT_STANCE,
    "{{ARTIFACT}}": resolved.artifactText,
    "{{EVIDENCE}}":
      resolved.evidenceText && resolved.evidenceText.trim().length > 0 ? resolved.evidenceText : "(none provided)",
    "{{KNOWN_GAPS}}": renderKnownGaps(packet.known_gaps),
    "{{AXES}}": renderAxes(packet.axes),
    "{{OUTPUT_SHAPE}}": renderOutputShape(packet.output_shape ?? DEFAULT_OUTPUT_SHAPE),
    "{{OPPONENT_IDENTITY}}": packet.opponent?.identity ?? "",
    "{{OPPONENT_GOAL}}": packet.opponent?.goal ?? "",
    "{{OPPONENT_INFORMATION}}":
      resolved.opponentInfoText && resolved.opponentInfoText.trim().length > 0
        ? resolved.opponentInfoText
        : "(none provided)",
  };
  let out = scaffoldText;
  for (const [k, v] of Object.entries(repl)) {
    out = out.split(k).join(v);
  }
  return out;
}

/** Any {{TOKEN}} the scaffold left unfilled — a wiring bug the CLI should catch. */
export function leftoverPlaceholders(text: string): string[] {
  const m = text.match(/\{\{[A-Z_]+\}\}/g);
  return m ? Array.from(new Set(m)) : [];
}

// ---------------------------------------------------------------------------
// Synthesis prompt + report (pure). The synthesizer ORGANIZES the attacks into
// one map; it does NOT decide — the author is the final judge.
// ---------------------------------------------------------------------------

/** Ordered A/B/C labels for the successful reviewers. Anonymizes brand in synthesis. */
export function labelReviewers(results: ReviewerResult[]): { label: string; result: ReviewerResult }[] {
  const ok = results.filter((r) => r.status === "ok");
  return ok.map((result, i) => ({ label: `Reviewer ${String.fromCharCode(65 + (i % 26))}`, result }));
}

/**
 * Build the synthesis prompt. Reviewer identities are anonymized (Reviewer A/B/C)
 * so the synthesizer weighs the argument, not the brand. The report appendix
 * de-anonymizes for the human reader.
 */
export function buildSynthesisPrompt(
  packet: ThesisPacket,
  results: ReviewerResult[],
  resolved: ResolvedSources,
): string {
  const labelled = labelReviewers(results);
  const reviewBlocks = labelled
    .map(({ label, result }) => `### ${label}\n${(result.critique ?? "").trim()}`)
    .join("\n\n");

  const head = [
    "You are synthesizing several INDEPENDENT reviews of one thesis into a single map.",
    "You organize and reconcile the attacks; you do NOT decide the outcome — the author is the final judge.",
    "Do not invent findings that are not present in the reviews below. Preserve disagreement: where reviewers conflict, say so and name the split.",
    "",
    "## The original thesis",
    `Question: ${packet.question}`,
    `Frame: ${packet.frame}`,
    `Axes: ${packet.axes.map((a) => a.name).join(" · ")}`,
    "",
    "### Artifact under review",
    resolved.artifactText.trim(),
    "",
    `## The ${labelled.length} independent review${labelled.length === 1 ? "" : "s"}`,
    reviewBlocks,
    "",
    "## Produce the synthesis",
  ].join("\n");

  const tail =
    packet.mode === "steel-man"
      ? [
          "Start with a short **Packet Health** section, placed BEFORE the playbook. Aggregate every 'Packet limitations' note the reviewers reported — places where the opponent's information scope was insufficient to model them realistically. Open it with a one-line reliability verdict ('reliable as-is' or 'limited by a packet gap'), then list the specific gaps the reviewers named (by Reviewer label). If no reviewer reported a limitation, write exactly: 'Packet Health: no limitations reported — the panel could model the opponent from the packet as given.'",
          "Then consolidate the reviewers' opponent-plays into ONE game-theory playbook for the author:",
          "1. The opponent's most likely strategy — the consensus line across reviewers, noting any outlier line worth taking seriously.",
          "2. The specific vulnerabilities in the author's position the opponent would exploit, ranked by how dangerous they are.",
          "3. A recommended counter-strategy for the author, in offense and defense, using this shape per recommended move:",
          "   - Move / Basis / Expected response / Counter / End-state.",
          "Flag any opponent move a reviewer marked as a bluff (a threat the opponent couldn't actually back). Where a gap in the opponent's information meant a line of play could not be realistically tested, mark it as such rather than presenting a guess as the opponent's confirmed strategy.",
        ].join("\n")
      : [
          "Start with a short **Packet Health** section, placed BEFORE the pillar verdicts. Aggregate every 'Packet limitations' note the reviewers reported — missing or insufficient evidence, an ambiguous question or frame, or an axis they could not probe. Open it with a one-line reliability verdict ('reliable as-is' or 'limited by a packet gap'), then list the specific gaps the reviewers named (by Reviewer label). If no reviewer reported a limitation, write exactly: 'Packet Health: no limitations reported — the panel was able to use the packet as given.'",
          "Then map the thesis against the reviews:",
          "1. For each pillar / claim of the thesis, give a verdict: HOLDS | WEAK | BROKEN | UNTESTED — and state whether the reviewers agree (consensus) or split (outlier), naming who said what (by Reviewer label).",
          "   UNTESTED means the panel could not genuinely probe that pillar because of a packet gap (e.g. the evidence needed to attack it was not provided). NEVER fold an UNTESTED pillar into HOLDS: 'nobody could attack it' is not 'it survived attack'. Reserve HOLDS for a pillar that was actually probed and stood.",
          "2. Surface consensus findings first (multiple reviewers independently flagged it), then notable outlier findings (one reviewer, but worth attention).",
          "3. End with a single severity-ranked fix list (critical → low): the concrete changes that would most strengthen the thesis. For any UNTESTED pillar, the fix is what to add to the packet (evidence, scope) so it can be probed on a re-run.",
          "Where a reviewer endorsed a pillar with no real evidence, treat that as 'holds, untested' — not as a positive finding.",
        ].join("\n");

  return `${head}\n${tail}\n`;
}

export interface RunMeta {
  timestamp: string; // ISO — supplied by the CLI (core is pure, no clock access)
  configuredReviewerSlugs: string[];
  synthesizerSlug: string;
  mode: ReviewMode;
}

function artifactDescriptor(packet: ThesisPacket): string {
  if (!isVacuous(packet.artifact.path)) return packet.artifact.path as string;
  if (packet.meta?.title && !isVacuous(packet.meta.title)) return packet.meta.title;
  return "inline artifact";
}

/**
 * Render the full markdown report: synthesis on top, raw per-model critiques in an
 * appendix beneath it, failed models named, and run metadata. Pure — the CLI writes
 * the returned string to a timestamped file and returns the path.
 */
export function buildReportMarkdown(
  packet: ThesisPacket,
  results: ReviewerResult[],
  synthesisText: string,
  meta: RunMeta,
): string {
  const labelled = labelReviewers(results);
  const failed = results.filter((r) => r.status === "failed");
  const succeeded = results.filter((r) => r.status === "ok");
  const title = packet.meta?.title && !isVacuous(packet.meta.title) ? packet.meta.title : packet.question;
  const modeLabel = packet.mode === "steel-man" ? "Steel Man" : "Adversarial";

  const lines: string[] = [];
  lines.push(`# ${modeLabel} Review — ${title}`);
  lines.push("");
  lines.push(`> Generated ${meta.timestamp}. This report ORGANIZES independent critiques; the author is the final judge.`);
  lines.push("");
  lines.push("## Run summary");
  lines.push("");
  lines.push(`- **Mode:** ${modeLabel}`);
  lines.push(`- **Artifact:** ${artifactDescriptor(packet)}`);
  lines.push(`- **Question:** ${packet.question}`);
  lines.push(`- **Frame:** ${packet.frame}`);
  lines.push(`- **Axes:** ${packet.axes.map((a) => a.name).join(" · ")}`);
  lines.push(`- **Reviewers succeeded:** ${succeeded.length} of ${results.length} lab(s)`);
  if (succeeded.length > 0) {
    lines.push(
      `- **Panel (lab → model used):** ${succeeded
        .map((r) => `${r.family} → ${r.slug}${(r.fallbacksUsed ?? 0) > 0 ? " (failover)" : ""}`)
        .join("; ")}`,
    );
  }
  lines.push(`- **Synthesizer:** ${meta.synthesizerSlug}`);
  if (failed.length > 0) {
    lines.push(
      `- **Failed labs:** ${failed.map((f) => `${f.family} (${(f.error ?? "unknown error").slice(0, 60)})`).join("; ")}`,
    );
  }
  lines.push("");
  lines.push("## Synthesis");
  lines.push("");
  lines.push(synthesisText.trim());
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Appendix — raw reviewer critiques");
  lines.push("");
  if (labelled.length === 0) {
    lines.push("_No successful reviewer critiques._");
    lines.push("");
  } else {
    for (const { label, result } of labelled) {
      const via = result.family && result.slug && result.family !== result.slug ? `${result.family} via ${result.slug}` : result.slug;
      lines.push(`### ${label} — ${via}`);
      if ((result.fallbacksUsed ?? 0) > 0 && result.trail) {
        lines.push(`> Failed over within lab: ${result.trail.map((t) => `${t.slug} (${t.outcome})`).join(" → ")}`);
      }
      lines.push("");
      lines.push((result.critique ?? "").trim());
      lines.push("");
    }
  }
  if (failed.length > 0) {
    lines.push("### Failed labs (no model in the lab produced a usable critique)");
    lines.push("");
    for (const f of failed) {
      const trail = f.trail && f.trail.length ? ` — tried: ${f.trail.map((t) => `${t.slug} (${t.outcome})`).join(" → ")}` : "";
      lines.push(`- **${f.family}** — ${f.error ?? "unknown error"}${trail}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ===========================================================================
// LIVE MODEL RESOLUTION + WORK-PRODUCT VALIDATION (pure)
//
// The model layer does NOT freeze slugs. Each panel slot is a LAB; the lab's
// current smart-reasoner chain is resolved live from the OpenRouter catalog by
// release date, and failover walks DOWN the same lab's chain (diversity > frontier).
// These pure helpers do the resolution and the validation; the client does the I/O.
// ===========================================================================

/** A model entry from the OpenRouter /models catalog (only the fields we use). */
export interface CatalogModel {
  id: string; // "openai/gpt-5.5"
  created?: number; // unix seconds — the currency signal
  name?: string;
}

/**
 * Variant keywords that mark a NON-flagship-reasoner model. A lab's chain keeps
 * only its smart reasoners (the thinking flagships), excluding mini/fast/cheap/
 * modality-specific/non-reasoning variants. NOTE: "preview" is NOT excluded —
 * a current flagship can ship as a preview (e.g. gemini-3.1-pro-preview).
 */
export const DEFAULT_SMART_EXCLUDE = [
  "mini",
  "nano",
  "flash",
  "lite",
  "small",
  "tiny",
  "fast", // the speed-tier variant, not the flagship reasoner
  "turbo",
  "image",
  "audio",
  "tts",
  "voice",
  "embed",
  "rerank",
  "guard",
  "moderation",
  "safety",
  "transcribe",
  "realtime",
  "search",
  "chat", // chat variants are the non-reasoning tier
  "code", // coding-specialized variant
  "codex",
  "coder",
  "customtools", // tool-calling-tuned variant, not the general reasoner
  "instruct",
  "vision",
  "ocr",
];

export interface ChainOpts {
  smartExclude?: string[];
  depth: number;
  reasoning?: { effort?: string; [k: string]: any };
  /**
   * Optional regex (matched against the slug tail, case-insensitive) that scopes a
   * lab to its FLAGSHIP REASONER LINE. Line names (gemini-…-pro, grok-[0-9], gpt-[0-9])
   * are stable; only versions rot — so this catches a current flagship while excluding
   * a lab's small/open/modality-specific models (gemma, lyria, grok-build) that the
   * variant denylist can't, AND it doesn't go stale the way a version slug would.
   */
  includePattern?: string;
}

/**
 * Build a lab's failover chain: its smart flagship-line reasoners from the catalog,
 * newest first, capped at `depth`. The first entry is the current flagship; the rest
 * are the in-lab fallbacks. Pure — the client fetches the catalog and passes it in.
 */
export function buildFamilyChain(catalog: CatalogModel[], lab: string, opts: ChainOpts): ModelSpec[] {
  const prefix = lab.toLowerCase() + "/";
  const exclude = (opts.smartExclude ?? DEFAULT_SMART_EXCLUDE).map((s) => s.toLowerCase());
  const excludeSet = new Set(exclude);
  const includeRe = opts.includePattern ? new RegExp(opts.includePattern, "i") : null;
  const candidates = (catalog ?? [])
    .filter((m) => typeof m?.id === "string" && m.id.toLowerCase().startsWith(prefix))
    .filter((m) => !m.id.toLowerCase().includes(":free")) // skip rate-limited free tiers for paid reviews
    .filter((m) => !includeRe || includeRe.test(m.id.slice(prefix.length))) // scope to the flagship reasoner line
    .filter((m) => {
      // Match exclude keywords as whole TOKENS, not substrings — otherwise "geMINI"
      // would match "mini" and drop every Gemini model. Tokens split on non-alphanumerics.
      const tail = m.id.slice(prefix.length).toLowerCase();
      const tokens = tail.split(/[^a-z0-9]+/).filter(Boolean);
      return !tokens.some((tok) => excludeSet.has(tok));
    })
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));

  const seen = new Set<string>();
  const chain: ModelSpec[] = [];
  for (const m of candidates) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    chain.push({ slug: m.id, family: lab, reasoning: opts.reasoning });
    if (chain.length >= opts.depth) break;
  }
  return chain;
}

// --- Work-product validation -----------------------------------------------
// A model can fail WITHOUT an HTTP error: a blocked model (e.g. Fable blocked by
// the US government) may return HTTP 200 with a plaintext "restricted due to..."
// blob instead of a real critique. Validate the CONTENT, not just the status —
// an invalid work-product triggers the same in-lab failover as an HTTP error.

const MIN_WORKPRODUCT_CHARS = 150;

// Task-refusal signatures. First-person anchored ("I can't help", "I'm unable",
// "I must decline") so a FINDING that says "I cannot find support for X" or "the
// plan can't provide Y" is NOT misread as a refusal. Checked against the opening
// window (not just the string start) so "I'm sorry, I can't help with this" is caught.
const REFUSAL_PATTERNS: RegExp[] = [
  /\bi\s+can(?:'?t|not)\s+(?:help|assist|comply|provide|complete|fulfill|process|continue|engage|do this|generate|create|produce|review)\b/i,
  /\bi(?:'?m|\s+am)\s+(?:sorry|unable|not able)\b/i,
  /\bi\s+(?:must|have to|will|am going to)\s+decline\b/i,
  /\bi\s+won'?t\s+be able\b/i,
  /^\s*as an ai\b/i,
  /^\s*(?:sorry[,. ]|apologies[,. ]|unfortunately,\s+i\s+can(?:'?t|not))/i,
];

// Availability / legal / geographic restriction signatures (the Fable case).
const RESTRICTION_PATTERNS: RegExp[] = [
  /\b(restricted|unavailable|not available|blocked|prohibited|access denied|cannot be (?:provided|served|accessed|fulfilled))\b[^.]{0,80}\b(region|country|government|regulation|regulatory|sanction|export|policy|jurisdiction|law|legal|geographic|location)\b/i,
  /\bdue to\b[^.]{0,40}\b(government|regulatory|regulation|legal|export|sanction|geographic|compliance|policy)\b/i,
  /\bthis (?:model|content|service|request|feature) is (?:currently )?(?:restricted|unavailable|not available|blocked|disabled)\b/i,
  /\b(?:temporarily|currently) (?:unavailable|restricted|disabled|blocked)\b/i,
];

/**
 * Decide whether a model's response is a real work product (a usable critique /
 * synthesis) vs. a refusal, a restriction blob, an error payload, or something too
 * short to be real. Conservative on the refusal openers (specific verbs) so a
 * legitimate finding isn't dropped; aggressive on restriction/availability blobs
 * (those are never valid output). An invalid verdict triggers in-lab failover.
 */
export function isValidWorkProduct(text: string | undefined | null): { valid: boolean; reason?: string } {
  if (text == null) return { valid: false, reason: "empty response" };
  const t = text.trim();
  if (t.length === 0) return { valid: false, reason: "empty response" };
  if (t.length < MIN_WORKPRODUCT_CHARS) return { valid: false, reason: `too short to be a real critique (${t.length} chars)` };
  const head = t.slice(0, 300);
  // error-shaped payload (a JSON/error blob leaked as content)
  if (/^\s*\{?\s*"?error"?\s*["']?\s*[:=]/i.test(head)) return { valid: false, reason: "error-shaped payload, not a critique" };
  for (const re of REFUSAL_PATTERNS) {
    if (re.test(head)) return { valid: false, reason: "opens as a task refusal" };
  }
  for (const re of RESTRICTION_PATTERNS) {
    if (re.test(head)) return { valid: false, reason: "availability/legal restriction blob, not a critique" };
  }
  return { valid: true };
}
