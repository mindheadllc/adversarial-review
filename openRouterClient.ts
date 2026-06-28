/**
 * openRouterClient.ts — the live model layer (I/O).
 *
 * Talks to OpenRouter's OpenAI-compatible endpoint with Bun's built-in fetch.
 * Key behaviors:
 *
 *  - LIVE currency: chains are resolved from the catalog, never frozen slugs.
 *  - In-LAB failover: a panel slot is a lab; on failure we walk DOWN that lab's
 *    chain, never substitute another lab (diversity > frontier).
 *  - THREE failure detectors, all → in-lab failover:
 *      1. HTTP error / ZDR-block (404 "data policy") / non-retryable 4xx
 *      2. invalid work-product — a 200 that is a refusal or a plaintext
 *         "restricted due to..." blob, not a real critique (validated by
 *         isValidWorkProduct). A blocked model (e.g. Fable) may 200 with prose.
 *      3. silent failure — a model that never responds is ABORTED at timeoutMs
 *         and we advance (don't retry a hung model); a per-slot deadline backstops
 *         the whole chain so nothing waits forever.
 *  - SYNTHESIS BARRIER: fanOutPanel awaits ALL slots before the caller synthesizes.
 *  - ZDR is a per-run toggle; the provider preference rides on requests only when on.
 *
 * fetch and sleep are injectable so the whole client is testable with no network
 * and no real waits.
 */

import {
  isValidWorkProduct,
  type ModelSpec,
} from "./adversarialReviewCore";

export interface RetryConfig {
  attempts: number;
  backoff_ms: number[];
}

export interface OpenRouterClientOpts {
  apiKey: string;
  endpoint: string;
  modelsEndpoint: string;
  /** ZDR is per-run; when true the provider preference rides on every request. */
  zdrEnabled: boolean;
  providerPreference: Record<string, any>;
  /** The synthesizer's lab. A reviewer whose lab equals it is refused — the model
   *  that organizes the critiques must not also be a critic (correlated blind spots). */
  synthesizerLab?: string;
  retry?: RetryConfig;
  timeoutMs?: number;
  slotDeadlineMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

const DEFAULT_RETRY: RetryConfig = { attempts: 2, backoff_ms: [1000, 4000] };
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Throws if any reviewer lab equals the synthesizer's lab. The model that organizes
 *  the critiques must not also be one of the critics, or critique and synthesis share
 *  blind spots. Any lab can review — including Claude — as long as it isn't the
 *  synthesizer's lab. A falsy synthesizerLab disables the check. */
export function assertReviewersExcludeSynthesizer(
  specs: { slug: string; family: string }[],
  synthesizerLab: string,
): void {
  if (!synthesizerLab) return;
  const offenders = specs.filter((r) => r.family === synthesizerLab);
  if (offenders.length > 0) {
    throw new Error(
      `A reviewer lab must not be the synthesizer's lab "${synthesizerLab}" — the synthesizer ` +
        `organizes the critiques, so it can't also be a critic (that would correlate critique and ` +
        `synthesis). Offending reviewer(s): ${offenders.map((o) => o.slug).join(", ")}. ` +
        `Set synthesizer_lab to a different lab, or remove "${synthesizerLab}" from reviewer_labs.`,
    );
  }
}

/** The classified outcome of one HTTP attempt against one model. */
type ModelOutcome =
  | { kind: "ok"; text: string; provider?: string }
  | { kind: "invalid"; reason: string; provider?: string }
  | { kind: "zdr_blocked" }
  | { kind: "timeout" }
  | { kind: "retryable"; error: string }
  | { kind: "fatal"; error: string };

function outcomeReason(o: ModelOutcome): string {
  switch (o.kind) {
    case "ok":
      return "ok";
    case "invalid":
      return `invalid (${o.reason})`;
    case "zdr_blocked":
      return "zdr-blocked";
    case "timeout":
      return "timeout";
    case "retryable":
      return `error (${o.error})`;
    case "fatal":
      return `fatal (${o.error})`;
  }
}

export interface SlotResult {
  family: string;
  status: "ok" | "failed";
  /** The model in the chain that actually produced the work product. */
  slug?: string;
  critique?: string;
  provider?: string;
  /** How many models in the chain were walked past before success. */
  fallbacksUsed?: number;
  /** Audit of what each model in the chain did (the failover path). */
  trail: { slug: string; outcome: string }[];
  error?: string;
  latencyMs?: number;
}

export function createOpenRouterClient(opts: OpenRouterClientOpts) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const retry = opts.retry ?? DEFAULT_RETRY;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const slotDeadlineMs = opts.slotDeadlineMs ?? 300_000;
  const log = opts.log ?? (() => {});

  function buildBody(spec: ModelSpec, prompt: string): Record<string, any> {
    const body: Record<string, any> = { model: spec.slug, messages: [{ role: "user", content: prompt }] };
    if (spec.reasoning && Object.keys(spec.reasoning).length > 0) body.reasoning = spec.reasoning;
    if (opts.zdrEnabled) body.provider = { ...opts.providerPreference };
    return body;
  }

  /** One HTTP attempt + work-product validation. Classifies the outcome. */
  async function callModelOnce(spec: ModelSpec, prompt: string): Promise<ModelOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(opts.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json", "X-Title": "AdversarialReview" },
        body: JSON.stringify(buildBody(spec, prompt)),
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = "";
        try {
          detail = await res.text();
        } catch {
          /* ignore */
        }
        if (res.status === 404 && /data policy|zero data retention/i.test(detail)) return { kind: "zdr_blocked" };
        if (RETRYABLE_STATUS.has(res.status)) return { kind: "retryable", error: `HTTP ${res.status}` };
        return { kind: "fatal", error: `HTTP ${res.status}: ${detail.slice(0, 200)}` };
      }
      let data: any;
      try {
        data = await res.json();
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        // An abort fired during body read is a TIMEOUT, not a transient JSON error —
        // advance to the next model rather than retrying a model that didn't finish.
        if (e?.name === "AbortError" || /abort/i.test(msg)) return { kind: "timeout" };
        return { kind: "retryable", error: `malformed JSON body (${msg})` };
      }
      const content = data?.choices?.[0]?.message?.content;
      const provider = typeof data?.provider === "string" ? data.provider : undefined;
      if (typeof content !== "string") return { kind: "invalid", reason: "no content in completion", provider };
      const v = isValidWorkProduct(content);
      if (!v.valid) return { kind: "invalid", reason: v.reason ?? "invalid work product", provider };
      return { kind: "ok", text: content, provider };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (e?.name === "AbortError" || /abort/i.test(msg)) return { kind: "timeout" };
      return { kind: "retryable", error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Try one model, retrying ONLY transient (retryable) errors. Timeouts, ZDR
   *  blocks, invalid work-products, and fatal errors return immediately so the
   *  slot can advance to the next model rather than retrying a doomed call. */
  async function runModelWithRetries(spec: ModelSpec, prompt: string): Promise<ModelOutcome> {
    let last: ModelOutcome = { kind: "retryable", error: "no attempt made" };
    for (let attempt = 1; attempt <= retry.attempts; attempt++) {
      const o = await callModelOnce(spec, prompt);
      last = o;
      if (o.kind !== "retryable") return o;
      if (attempt < retry.attempts) {
        const wait = retry.backoff_ms[Math.min(attempt - 1, retry.backoff_ms.length - 1)] ?? 1000;
        log(`[${spec.slug}] ${o.error}; retry ${attempt}/${retry.attempts} in ${wait}ms`);
        await sleep(wait);
      }
    }
    return last;
  }

  /** Walk a lab's chain: first model that yields a valid work-product wins; any
   *  failure advances to the next model. Bounded by a per-slot deadline. */
  async function runSlot(chain: ModelSpec[], prompt: string, label: string): Promise<SlotResult> {
    const start = Date.now();
    const trail: { slug: string; outcome: string }[] = [];
    if (!chain || chain.length === 0) {
      return { family: label, status: "failed", error: "no models resolved for this lab", trail };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<SlotResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ family: label, status: "failed", error: `slot deadline (${slotDeadlineMs}ms) exceeded`, trail, latencyMs: Date.now() - start }),
        slotDeadlineMs,
      );
    });

    const walk = (async (): Promise<SlotResult> => {
      for (let i = 0; i < chain.length; i++) {
        const spec = chain[i];
        const o = await runModelWithRetries(spec, prompt);
        trail.push({ slug: spec.slug, outcome: outcomeReason(o) });
        if (o.kind === "ok") {
          if (i > 0) log(`[${label}] failed over to ${spec.slug} (skipped ${i} earlier model(s))`);
          return { family: label, status: "ok", slug: spec.slug, critique: o.text, provider: o.provider, fallbacksUsed: i, trail, latencyMs: Date.now() - start };
        }
        log(`[${label}] ${spec.slug}: ${outcomeReason(o)} -> ${i + 1 < chain.length ? "next in lab" : "lab exhausted"}`);
      }
      return { family: label, status: "failed", error: `all ${chain.length} model(s) in lab "${label}" failed`, trail, latencyMs: Date.now() - start };
    })();

    const res = await Promise.race([walk, deadline]);
    if (timer) clearTimeout(timer);
    return res;
  }

  /** Fan out the reviewer prompt across all lab slots. BARRIER: awaits every slot
   *  (success or chain-exhausted) before returning, so synthesis never runs partial. */
  async function fanOutPanel(slots: { family: string; chain: ModelSpec[] }[], prompt: string): Promise<SlotResult[]> {
    assertReviewersExcludeSynthesizer(
      slots.flatMap((s) => [{ slug: s.family, family: s.family }, ...s.chain.map((c) => ({ slug: c.slug, family: c.family }))]),
      opts.synthesizerLab ?? "",
    );
    return Promise.all(slots.map((s) => runSlot(s.chain, prompt, s.family)));
  }

  /** Run the synthesizer over the configured synthesizer lab's chain (Claude by
   *  default — e.g. Fable 5 → Opus 4.8). Throws if every model in the chain fails. */
  async function runSynthesizer(chain: ModelSpec[], prompt: string): Promise<{ slug: string; text: string; trail: { slug: string; outcome: string }[] }> {
    const slot = await runSlot(chain, prompt, "synthesizer");
    if (slot.status !== "ok") {
      throw new Error(`synthesis failed (${slot.error}); trail: ${slot.trail.map((t) => `${t.slug}=${t.outcome}`).join(" | ")}`);
    }
    return { slug: slot.slug as string, text: slot.critique as string, trail: slot.trail };
  }

  /** Fetch the live model catalog (id + created date) for chain resolution. */
  async function fetchCatalog(): Promise<{ id: string; created?: number; name?: string }[]> {
    const res = await fetchImpl(opts.modelsEndpoint, { method: "GET", headers: { Authorization: `Bearer ${opts.apiKey}` } });
    if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`);
    const data: any = await res.json();
    return (data?.data ?? []).map((m: any) => ({ id: String(m?.id), created: typeof m?.created === "number" ? m.created : undefined, name: m?.name }));
  }

  return { fetchCatalog, runSlot, fanOutPanel, runSynthesizer, callModelOnce };
}

export type OpenRouterClient = ReturnType<typeof createOpenRouterClient>;
