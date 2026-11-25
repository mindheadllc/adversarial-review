#!/usr/bin/env bun
/**
 * adversarial_review.ts — CLI wrapper for the AdversarialReview skill (I/O layer).
 *
 * Orchestrates: load config -> resolve packet -> PRECISION GATE (hard wall before
 * any model call) -> resolve attachments from disk -> resolve the model panel LIVE
 * from the OpenRouter catalog (current flagship per lab + in-lab fallback chain) ->
 * fan out (BARRIER: wait for every lab slot) -> synthesize with the Claude chain ->
 * write a timestamped report -> print its path.
 *
 * ZDR is a per-run setting (default off): --zdr to enforce zero-data-retention.
 *
 * Subcommands:
 *   gate     --packet <path|->                 Validate a packet; print gaps/OK. No model calls.
 *   describe --packet <path|->                 Echo the packet in plain language.
 *   axes     [--review-type <type>]            List bundled axis-sets.
 *   models   [--zdr] [--config <path>]         Show the live-resolved model panel per lab. No review.
 *   run      --packet <path|->                 Run a full review.
 *   run      --template <path> --artifact <p>  Run a saved template, swapping one artifact.
 *            [--zdr|--no-zdr] [--out <path>] [--dry-run] [--config <path>]
 */

import { join, resolve, isAbsolute, dirname } from "path";
import { mkdirSync, readFileSync, existsSync, statSync, accessSync, constants as fsConstants } from "fs";
import { homedir } from "os";
import {
  normalizePacket,
  validatePacket,
  describePacket,
  fillScaffold,
  leftoverPlaceholders,
  buildSynthesisPrompt,
  buildReportMarkdown,
  buildFamilyChain,
  resolveZdrDecision,
  evaluatePanel,
  resolveCredential,
  isVacuous,
  type ThesisPacket,
  type ModelSpec,
  type ResolvedSources,
  type ReviewerResult,
  type RunMeta,
  type CredentialIO,
  type CredentialResult,
} from "./adversarialReviewCore";
import { createOpenRouterClient, type SlotResult } from "./openRouterClient";

const SKILL_DIR = import.meta.dir;

// ---- tiny arg parser -----------------------------------------------------------
interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}
function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else _.push(a);
  }
  return { _, flags };
}

function fail(message: string, code = 1): never {
  process.stderr.write(`adversarial_review: ${message}\n`);
  process.exit(code);
}
function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}
function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}
function resolveUserPath(p: string): string {
  const e = expandHome(p);
  return isAbsolute(e) ? e : resolve(process.cwd(), e);
}

// ---- config --------------------------------------------------------------------
interface LoadedConfig {
  endpoint: string;
  modelsEndpoint: string;
  zdrDefault: boolean;
  providerPreference: Record<string, any>;
  credentialEnv: string;
  envFile?: string;
  keychainService?: string;
  fallbackFiles: { path: string; var: string }[];
  reviewerLabs: string[];
  synthesizerLab: string;
  labPatterns: Record<string, string>;
  reasoningDefault: any;
  reasoningOverrides: Record<string, any>;
  chainDepth: number;
  smartExclude?: string[];
  defaults: any;
}

async function loadConfig(configPath?: string): Promise<LoadedConfig> {
  const path = configPath ? resolveUserPath(configPath) : join(SKILL_DIR, "models.config.yaml");
  const file = Bun.file(path);
  if (!(await file.exists())) fail(`config not found: ${path}`);
  const raw: any = Bun.YAML.parse(await file.text());
  return {
    endpoint: raw.endpoint,
    modelsEndpoint: raw.models_endpoint,
    zdrDefault: !!(raw.zdr?.default),
    providerPreference: raw.zdr?.provider_preference ?? { zdr: true },
    credentialEnv: raw.credential?.env ?? "OPENROUTER_API_KEY",
    envFile: raw.credential?.env_file,
    keychainService: raw.credential?.keychain_service,
    fallbackFiles: (raw.credential?.fallback_files ?? []).map((f: any) => ({ path: f.path, var: f.var })),
    reviewerLabs: raw.reviewer_labs ?? [],
    synthesizerLab: raw.synthesizer_lab ?? "anthropic",
    labPatterns: raw.lab_patterns ?? {},
    reasoningDefault: raw.reasoning?.default ?? { effort: "high" },
    reasoningOverrides: raw.reasoning?.overrides ?? {},
    chainDepth: raw.selection?.chain_depth ?? 3,
    smartExclude: raw.selection?.smart_exclude,
    defaults: raw.defaults ?? {},
  };
}

function labReasoning(cfg: LoadedConfig, lab: string): any {
  return cfg.reasoningOverrides[lab] ?? cfg.reasoningDefault;
}

// ---- packet loading ------------------------------------------------------------
function parsePacketText(text: string, hint: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || hint.endsWith(".json")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through */
    }
  }
  try {
    return Bun.YAML.parse(text);
  } catch (e: any) {
    fail(`could not parse packet (${hint}): ${String(e?.message ?? e)}`);
  }
}
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}
async function loadPacketRaw(flags: Record<string, string | boolean>): Promise<any> {
  if (typeof flags.template === "string") {
    const tplPath = resolveUserPath(flags.template);
    const tplFile = Bun.file(tplPath);
    if (!(await tplFile.exists())) fail(`template not found: ${tplPath}`);
    const raw = parsePacketText(await tplFile.text(), tplPath);
    if (flags.artifact != null) {
      if (typeof flags.artifact !== "string") fail("--artifact needs a value (a path).");
      raw.artifact = { path: flags.artifact };
    }
    return raw;
  }
  if (typeof flags.packet === "string") {
    if (flags.packet === "-") return parsePacketText(await readStdin(), "<stdin>");
    const p = resolveUserPath(flags.packet);
    const f = Bun.file(p);
    if (!(await f.exists())) fail(`packet not found: ${p}`);
    return parsePacketText(await f.text(), p);
  }
  fail("provide --packet <path|-> (or --template <path> [--artifact <path>]).");
}

// ---- ZDR resolution ------------------------------------------------------------
// Sensitivity (a gated rail) drives routing: `sensitive` forces ZDR on and a
// --no-zdr/zdr:false override is hard-refused here (never a silent downgrade). The
// decision logic is pure (core.resolveZdrDecision); this wrapper threads CLI flags
// + packet + config in and turns a refusal into a clear non-zero exit.
function buildZdrInputs(flags: Record<string, string | boolean>, rawPacket: any, packet: ThesisPacket | undefined, cfg: LoadedConfig) {
  return {
    sensitivity: packet?.sensitivity,
    explicitNoZdr: Boolean(flags["no-zdr"]),
    explicitZdr: Boolean(flags["zdr"]),
    packetZdr: rawPacket && typeof rawPacket.zdr === "boolean" ? rawPacket.zdr : undefined,
    configDefault: cfg.zdrDefault,
  };
}
function resolveRunZdr(
  flags: Record<string, string | boolean>,
  rawPacket: any,
  packet: ThesisPacket | undefined,
  cfg: LoadedConfig,
): { zdr: boolean; forced: boolean } {
  const d = resolveZdrDecision(buildZdrInputs(flags, rawPacket, packet, cfg));
  if (!d.ok) fail(d.error);
  return { zdr: d.zdr, forced: d.forced };
}

// ---- source resolution ---------------------------------------------------------
// Relative paths inside a packet FILE resolve against that file's folder first (so a
// packet works from any cwd), then the cwd (back-compat). Stdin and template packets
// have no packet folder, so they resolve against the cwd as before.
function packetBaseDir(flags: Record<string, string | boolean>): string | undefined {
  if (typeof flags.template === "string") return undefined;
  if (typeof flags.packet !== "string" || flags.packet === "-") return undefined;
  return dirname(resolveUserPath(flags.packet));
}
function resolveSourcePath(p: string, baseDir: string | undefined): string {
  const e = expandHome(p);
  if (isAbsolute(e) || !baseDir) return resolveUserPath(e);
  const fromPacket = resolve(baseDir, e);
  return existsSync(fromPacket) ? fromPacket : resolveUserPath(e);
}
async function readSource(ref: { path?: string; text?: string }, field: string, baseDir?: string): Promise<string> {
  if (!isVacuous(ref.text)) return (ref.text as string).trim();
  if (!isVacuous(ref.path)) {
    const p = resolveSourcePath(ref.path as string, baseDir);
    const f = Bun.file(p);
    if (!(await f.exists())) fail(`malformed packet: ${field} references a missing file: ${ref.path}`);
    return (await f.text()).trim();
  }
  return "";
}
async function resolveSources(packet: ThesisPacket, baseDir?: string): Promise<ResolvedSources> {
  const artifactText = await readSource(packet.artifact, "artifact", baseDir);
  let evidenceText = "";
  if (packet.evidence?.include?.length) {
    const parts: string[] = [];
    for (let i = 0; i < packet.evidence.include.length; i++) {
      const ref = packet.evidence.include[i];
      const body = await readSource(ref, `evidence.include[${i}]`, baseDir);
      if (body) parts.push(`## Evidence: ${ref.label ?? ref.path ?? `item ${i + 1}`}\n${body}`);
    }
    evidenceText = parts.join("\n\n");
  }
  let opponentInfoText = "";
  if (packet.mode === "steel-man" && packet.opponent?.information?.length) {
    const parts: string[] = [];
    for (let i = 0; i < packet.opponent.information.length; i++) {
      const ref = packet.opponent.information[i];
      const body = await readSource(ref, `opponent.information[${i}]`, baseDir);
      if (body) parts.push(`## What the opponent knows: ${ref.label ?? ref.path ?? `item ${i + 1}`}\n${body}`);
    }
    opponentInfoText = parts.join("\n\n");
  }
  return { artifactText, evidenceText, opponentInfoText };
}

// ---- report output -------------------------------------------------------------
// The report path is resolved and checked BEFORE any model call, so a bad --out can't
// throw away a paid run. A --out naming an existing folder (or ending in "/") gets the
// default timestamped filename inside it.
function resolveOutPath(outFlag: string | boolean | undefined, mode: string, stamp: string): string {
  const fileName = `${stamp}-${mode}.md`;
  if (typeof outFlag !== "string") return resolveUserPath(join("adversarial-reviews", fileName));
  const p = resolveUserPath(outFlag);
  const isDir = outFlag.endsWith("/") || (existsSync(p) && statSync(p).isDirectory());
  return isDir ? join(p, fileName) : p;
}
function assertWritable(outPath: string, outFlag: string | boolean | undefined): void {
  const label = typeof outFlag === "string" ? `--out ${outFlag}` : `--out (default ${outPath})`;
  // Walk up to the nearest existing ancestor: it must be a writable folder.
  let dir = dirname(outPath);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  try {
    if (!statSync(dir).isDirectory()) fail(`${label}: can't write a report there (${dir} is a file, not a folder).`);
    accessSync(dir, fsConstants.W_OK);
  } catch (e) {
    fail(`${label}: can't write a report there (${(e as Error).message}).`);
  }
}
// Never lose a paid run: if the chosen path fails at write time, fall back to the home
// folder, then to stdout.
async function writeReport(outPath: string, markdown: string): Promise<string> {
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    await Bun.write(outPath, markdown);
    return outPath;
  } catch (e) {
    const fallback = join(homedir(), `adversarial-review-${Date.now()}.md`);
    process.stderr.write(`warning: couldn't write ${outPath} (${(e as Error).message}); saving to ${fallback}\n`);
    try {
      await Bun.write(fallback, markdown);
      return fallback;
    } catch {
      process.stderr.write("warning: fallback write failed too; printing the report to stdout.\n");
      process.stdout.write(markdown + "\n");
      return "<stdout>";
    }
  }
}

// ---- credential ----------------------------------------------------------------
// Resolution order (host-agnostic, first hit wins): $primaryEnv -> primary env file
// -> keychain (interactive macOS) -> host-local fallback FILES from the config. The
// ordering + bleed-guard logic is the pure `resolveCredential` in core; this wrapper
// only supplies real filesystem / env / keychain readers (all sync).
function buildCredentialIO(): CredentialIO {
  return {
    getEnv: (name) => process.env[name],
    readFile: (p) => {
      const abs = resolveUserPath(p);
      try {
        return existsSync(abs) ? readFileSync(abs, "utf8") : null;
      } catch {
        return null;
      }
    },
    readKeychain: (service) => {
      try {
        const proc = Bun.spawnSync(["security", "find-generic-password", "-s", service, "-w"], { stdout: "pipe", stderr: "ignore" });
        if (proc.exitCode === 0) {
          const t = proc.stdout.toString().trim();
          return t.length > 0 ? t : null;
        }
      } catch {
        /* ignore */
      }
      return null;
    },
    platform: process.platform,
  };
}

function getCredential(cfg: LoadedConfig): CredentialResult {
  return resolveCredential(
    { primaryEnv: cfg.credentialEnv, envFile: cfg.envFile, keychainService: cfg.keychainService, fallbackFiles: cfg.fallbackFiles },
    buildCredentialIO(),
  );
}

function credMissingMessage(cfg: LoadedConfig): string {
  const sources = [
    `$${cfg.credentialEnv}`,
    cfg.envFile,
    cfg.keychainService ? `keychain ${cfg.keychainService}` : null,
    ...cfg.fallbackFiles.map((f) => f.path),
  ].filter(Boolean);
  return `missing credential — no OpenRouter key found on this host. Looked in: ${sources.join(", ")}. No review was run.`;
}

// ---- scaffold ------------------------------------------------------------------
async function loadScaffold(mode: ThesisPacket["mode"]): Promise<string> {
  const name = mode === "steel-man" ? "steel-man" : "adversarial";
  const f = Bun.file(join(SKILL_DIR, "prompt-scaffolds", `${name}.md`));
  if (!(await f.exists())) fail(`scaffold missing: prompt-scaffolds/${name}.md`);
  return await f.text();
}

// ---- chain resolution ----------------------------------------------------------
function buildReviewerSlots(catalog: any[], cfg: LoadedConfig): { family: string; chain: ModelSpec[] }[] {
  return cfg.reviewerLabs
    .filter((lab) => lab !== cfg.synthesizerLab) // de-correlate: the synthesizer's lab never also reviews
    .map((lab) => ({
      family: lab,
      chain: buildFamilyChain(catalog, lab, { depth: cfg.chainDepth, smartExclude: cfg.smartExclude, reasoning: labReasoning(cfg, lab), includePattern: cfg.labPatterns[lab] }),
    }));
}
function buildSynthChain(catalog: any[], cfg: LoadedConfig): ModelSpec[] {
  return buildFamilyChain(catalog, cfg.synthesizerLab, {
    depth: cfg.chainDepth,
    smartExclude: cfg.smartExclude,
    reasoning: labReasoning(cfg, cfg.synthesizerLab),
    includePattern: cfg.labPatterns[cfg.synthesizerLab],
  });
}

// ---- subcommands ---------------------------------------------------------------
async function cmdGate(flags: Record<string, string | boolean>): Promise<void> {
  const raw = await loadPacketRaw(flags);
  const { packet, warnings: nWarn } = normalizePacket(raw);
  const res = validatePacket(packet);
  if (res.ok) {
    out({ status: "ok", mode: packet.mode, warnings: [...nWarn, ...res.warnings] });
    process.exit(0);
  }
  out({ status: "rejected", mode: packet.mode, gaps: res.gaps, warnings: nWarn });
  process.exit(2);
}

async function cmdDescribe(flags: Record<string, string | boolean>): Promise<void> {
  const cfg = await loadConfig(typeof flags.config === "string" ? flags.config : undefined);
  const raw = await loadPacketRaw(flags);
  const { packet } = normalizePacket(raw);
  // Show the RESULTING ZDR routing — not just the declared sensitivity — so the
  // operator confirms before any spend. A sensitive+--no-zdr combination is shown
  // as REFUSED here (describe is inspection; it does not exit non-zero — the run does).
  const d = resolveZdrDecision(buildZdrInputs(flags, raw, packet, cfg));
  const routing = d.ok
    ? `ZDR routing: ${d.zdr ? "ON" : "off"} (${d.reason})`
    : `ZDR routing: REFUSED — ${d.error}`;
  process.stdout.write(describePacket(packet) + "\n" + routing + "\n");
}

async function cmdAxes(flags: Record<string, string | boolean>): Promise<void> {
  const dir = join(SKILL_DIR, "axis-sets");
  const { readdirSync } = await import("fs");
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  const sets = await Promise.all(
    files.map(async (f) => {
      const data: any = Bun.YAML.parse(await Bun.file(join(dir, f)).text());
      return { file: f, name: data.name, review_type: data.review_type, description: (data.description ?? "").trim(), axes: data.axes };
    }),
  );
  if (typeof flags["review-type"] === "string") {
    const rt = (flags["review-type"] as string).toLowerCase();
    const match =
      sets.find((s) => String(s.review_type).toLowerCase() === rt) ??
      sets.find((s) => String(s.review_type).toLowerCase().includes(rt) || rt.includes(String(s.name).toLowerCase()));
    if (!match) {
      out({ status: "no_match", review_type: flags["review-type"], available: sets.map((s) => ({ name: s.name, review_type: s.review_type })) });
      return;
    }
    out({ status: "ok", suggested: match });
    return;
  }
  out({ status: "ok", axis_sets: sets.map((s) => ({ name: s.name, review_type: s.review_type, description: s.description, axes: s.axes })) });
}

function makeClient(cfg: LoadedConfig, apiKey: string, zdr: boolean) {
  return createOpenRouterClient({
    apiKey,
    endpoint: cfg.endpoint,
    modelsEndpoint: cfg.modelsEndpoint,
    zdrEnabled: zdr,
    providerPreference: cfg.providerPreference,
    retry: cfg.defaults.retry,
    timeoutMs: cfg.defaults.request_timeout_ms,
    slotDeadlineMs: cfg.defaults.slot_deadline_ms,
    synthesizerLab: cfg.synthesizerLab,
    log: (line) => process.stderr.write(`  ${line}\n`),
  });
}

/** Load the model catalog: from a local --catalog file (offline) or live fetch. */
async function loadCatalog(cfg: LoadedConfig, flags: Record<string, string | boolean>, zdr: boolean): Promise<any[]> {
  if (typeof flags.catalog === "string") {
    const f = Bun.file(resolveUserPath(flags.catalog));
    if (!(await f.exists())) fail(`catalog file not found: ${flags.catalog}`);
    const data: any = JSON.parse(await f.text());
    return Array.isArray(data) ? data : data.data ?? [];
  }
  const cred = getCredential(cfg);
  if (!cred) fail(credMissingMessage(cfg));
  process.stderr.write(`note: OpenRouter credential resolved from ${cred.source} (runs locally).\n`);
  return makeClient(cfg, cred.key, zdr).fetchCatalog();
}

async function cmdModels(flags: Record<string, string | boolean>): Promise<void> {
  const cfg = await loadConfig(typeof flags.config === "string" ? flags.config : undefined);
  const { zdr } = resolveRunZdr(flags, null, undefined, cfg); // no packet → toggle only
  const catalog = await loadCatalog(cfg, flags, zdr);
  const reviewerSlots = buildReviewerSlots(catalog, cfg);
  const synth = buildSynthChain(catalog, cfg);
  out({
    status: "ok",
    zdr,
    note: zdr ? "ZDR on — a lab whose chain has no zero-retention endpoint will fail over / drop at run time." : "ZDR off — full frontier panel.",
    reviewer_labs: reviewerSlots.map((s) => ({ lab: s.family, flagship: s.chain[0]?.slug ?? "(none resolved)", fallbacks: s.chain.slice(1).map((c) => c.slug) })),
    synthesizer: { lab: cfg.synthesizerLab, flagship: synth[0]?.slug ?? "(none)", fallbacks: synth.slice(1).map((c) => c.slug) },
  });
}

async function cmdRun(flags: Record<string, string | boolean>): Promise<void> {
  const cfg = await loadConfig(typeof flags.config === "string" ? flags.config : undefined);
  const raw = await loadPacketRaw(flags);
  const { packet, warnings: nWarn } = normalizePacket(raw);

  // PRECISION GATE — hard wall. No model calls (and no ZDR resolution) on a mushy
  // packet. `sensitivity` is one of the gated rails, so an undeclared-sensitivity
  // packet is refused HERE before any routing decision is even attempted.
  const gate = validatePacket(packet);
  if (!gate.ok) {
    process.stderr.write("Precision gate REJECTED the packet — no review was run. Fix these rails:\n");
    for (const g of gate.gaps) process.stderr.write(`  - ${g.rail}: ${g.reason}\n`);
    process.exit(2);
  }
  for (const w of [...nWarn, ...gate.warnings]) process.stderr.write(`note: ${w}\n`);

  // ZDR routing is decided AFTER the gate: the (now-declared) sensitivity rail drives
  // it, and a --no-zdr/zdr:false override on sensitive material is hard-refused here.
  const { zdr, forced: zdrForced } = resolveRunZdr(flags, raw, packet, cfg);
  if (zdrForced) {
    process.stderr.write("note: sensitivity=sensitive — ZDR forced ON (sensitive material never routes to data-retaining endpoints).\n");
  }

  const runStamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  const outPath = resolveOutPath(flags.out, packet.mode, runStamp);
  assertWritable(outPath, flags.out);

  const resolved = await resolveSources(packet, packetBaseDir(flags));
  const scaffold = await loadScaffold(packet.mode);
  const reviewerPrompt = fillScaffold(scaffold, packet, resolved);
  const leftover = leftoverPlaceholders(reviewerPrompt);
  if (leftover.length > 0) fail(`scaffold wiring bug: unfilled placeholders ${leftover.join(", ")}`);

  if (cfg.reviewerLabs.length === 0) fail("no reviewer labs configured.");

  // Resolve the panel LIVE from the catalog (offline if --catalog supplied).
  const catalog = await loadCatalog(cfg, flags, zdr);
  const reviewerSlots = buildReviewerSlots(catalog, cfg).filter((s) => s.chain.length > 0);
  const synthChain = buildSynthChain(catalog, cfg);
  if (reviewerSlots.length === 0) fail("no reviewer labs resolved to any model from the live catalog.");
  if (synthChain.length === 0) fail(`synthesizer lab "${cfg.synthesizerLab}" resolved to no model from the live catalog.`);

  process.stderr.write(`Resolved panel (ZDR ${zdr ? "ON" : "off"}):\n`);
  for (const s of reviewerSlots) process.stderr.write(`  ${s.family} → ${s.chain[0].slug}${s.chain.length > 1 ? ` (fallbacks: ${s.chain.slice(1).map((c) => c.slug).join(", ")})` : ""}\n`);
  process.stderr.write(`  synthesizer → ${synthChain[0].slug}${synthChain.length > 1 ? ` (fallback: ${synthChain.slice(1).map((c) => c.slug).join(", ")})` : ""}\n`);

  // Dry run: assemble + resolve, NO model calls, no spend.
  if (flags["dry-run"]) {
    out({
      status: "dry_run",
      mode: packet.mode,
      sensitivity: packet.sensitivity,
      zdr,
      zdr_forced: zdrForced,
      panel: reviewerSlots.map((s) => ({ lab: s.family, flagship: s.chain[0].slug, fallbacks: s.chain.slice(1).map((c) => c.slug) })),
      synthesizer: synthChain[0].slug,
      target_reviewers: cfg.defaults.panel_target,
      reviewer_prompt_preview: reviewerPrompt.slice(0, 1200),
      report_path: outPath,
    });
    return;
  }

  // Real run — credential + client required. (loadCatalog above already resolved and
  // logged the credential source for the live catalog fetch; resolve again for the
  // client, silently, since the source note was already printed.)
  const cred = getCredential(cfg);
  if (!cred) fail(credMissingMessage(cfg));
  const client = makeClient(cfg, cred.key, zdr);

  // Fan out — BARRIER: awaits every lab slot before synthesizing.
  const slotResults: SlotResult[] = await client.fanOutPanel(reviewerSlots, reviewerPrompt);
  const results: ReviewerResult[] = slotResults.map((s) => ({
    slug: s.slug ?? s.family,
    family: s.family,
    status: s.status,
    critique: s.critique,
    error: s.error,
    provider: s.provider,
    fallbacksUsed: s.fallbacksUsed,
    trail: s.trail,
    latencyMs: s.latencyMs,
  }));

  const ok = results.filter((r) => r.status === "ok");
  // Never an empty review. A sensitive run (ZDR forced) that cleared ZERO ZDR-capable
  // labs hard-fails with a sensitivity-specific message rather than falling back to
  // data-retaining endpoints; otherwise the generic panel_min contract applies.
  const panelEval = evaluatePanel(
    {
      okCount: ok.length,
      total: results.length,
      labErrors: results.filter((r) => r.status === "failed").map((r) => `${r.family}: ${r.error}`),
    },
    { panelMin: cfg.defaults.panel_min ?? 1, sensitiveZdrForced: zdrForced },
  );
  if (!panelEval.ok) fail(panelEval.message);
  const target = cfg.defaults.panel_target ?? 3;
  if (ok.length < target) process.stderr.write(`note: ${ok.length} of ${target} target reviewer labs succeeded; report proceeds on the survivors.\n`);

  // Synthesize over the Claude chain (Fable -> Opus fallback). Hard-fail if all fail.
  const synthPrompt = buildSynthesisPrompt(packet, results, resolved);
  let synthSlug: string;
  let synthesisText: string;
  try {
    const synth = await client.runSynthesizer(synthChain, synthPrompt);
    synthSlug = synth.slug;
    synthesisText = synth.text;
  } catch (e: any) {
    fail(`synthesis failed: ${String(e?.message ?? e)}. ${ok.length} reviewer critique(s) obtained but not synthesized.`);
  }

  const timestamp = new Date().toISOString();
  const meta: RunMeta = {
    timestamp,
    configuredReviewerSlugs: reviewerSlots.map((s) => s.family),
    synthesizerSlug: synthSlug,
    mode: packet.mode,
  };
  const markdown = buildReportMarkdown(packet, results, synthesisText, meta);

  const reportPath = await writeReport(outPath, markdown);

  out({
    status: "success",
    mode: packet.mode,
    sensitivity: packet.sensitivity,
    zdr,
    zdr_forced: zdrForced,
    report_path: reportPath,
    reviewers_succeeded: ok.length,
    reviewers_total: results.length,
    panel: ok.map((r) => ({ lab: r.family, model: r.slug, failover: (r.fallbacksUsed ?? 0) > 0 })),
    failed_labs: results.filter((r) => r.status === "failed").map((r) => r.family),
    synthesizer: synthSlug,
  });
}

async function main(): Promise<void> {
  const { _, flags } = parseArgs(process.argv.slice(2));
  switch (_[0]) {
    case "gate":
      return cmdGate(flags);
    case "describe":
      return cmdDescribe(flags);
    case "axes":
      return cmdAxes(flags);
    case "models":
      return cmdModels(flags);
    case "run":
      return cmdRun(flags);
    default:
      fail(
        `unknown command "${_[0] ?? ""}". Use: gate | describe | axes | models | run.\n` +
          "  gate     --packet <path|->\n" +
          "  describe --packet <path|->\n" +
          "  axes     [--review-type <type>]\n" +
          "  models   [--zdr]\n" +
          "  run      --packet <path|-> | --template <path> --artifact <path> [--zdr|--no-zdr] [--out <path>] [--dry-run]",
      );
  }
}

main().catch((e) => fail(String(e?.stack ?? e?.message ?? e)));
