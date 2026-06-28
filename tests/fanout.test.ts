import { test, expect, describe } from "bun:test";
import { createOpenRouterClient, assertReviewersNonClaude } from "../openRouterClient";
import type { ModelSpec } from "../adversarialReviewCore";

// A long, valid critique (clears the work-product length floor + no refusal opener).
const OK = (slug: string) =>
  `Critique from ${slug}. Pillar A is BROKEN: the reasoning ignores the cost of the async path. ` +
  `Pillar B is WEAK at the team level. ` + "Detailed finding text. ".repeat(12);

const RESTRICTION =
  "This model is currently unavailable due to government regulation and export-control law in your jurisdiction, " +
  "and cannot be served for this request under the applicable policy in your region. Please try a different model.";

// ---- mock OpenRouter endpoint --------------------------------------------------
// script.chat[slug] = array of responses consumed in order:
//   { ok: true } | { restriction: true } | { status: 404, dataPolicy: true }
//   | { status: 500 } | { hang: true } | { nonjson: true }
function makeMock(script: { catalog?: any[]; chat?: Record<string, any[]> }) {
  const calls: { body: any }[] = [];
  const cursor: Record<string, number> = {};
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    if (init.method === "GET" || u.endsWith("/models")) {
      return new Response(JSON.stringify({ data: script.catalog ?? [] }), { status: 200 });
    }
    const body = JSON.parse(String(init.body));
    calls.push({ body });
    const slug = body.model as string;
    const seq = script.chat?.[slug] ?? [{ ok: true }];
    const i = Math.min(cursor[slug] ?? 0, seq.length - 1);
    cursor[slug] = (cursor[slug] ?? 0) + 1;
    const r = seq[i];
    if (r.hang) {
      return new Promise<Response>((_resolve, reject) => {
        (init as any).signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    if (r.status && r.status !== 200) {
      const detail = r.dataPolicy ? '{"error":{"message":"No endpoints found matching your data policy (Zero data retention)"}}' : `error ${r.status}`;
      return new Response(detail, { status: r.status });
    }
    if (r.nonjson) return new Response("not-json{{{", { status: 200 });
    const content = r.restriction ? RESTRICTION : r.ok ? OK(slug) : r.content;
    return new Response(JSON.stringify({ choices: [{ message: { content } }], provider: "MockProvider" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const baseOpts = (fetchImpl: typeof fetch, over: Record<string, any> = {}) => ({
  apiKey: "k",
  endpoint: "https://or/api/v1/chat/completions",
  modelsEndpoint: "https://or/api/v1/models",
  zdrEnabled: false,
  providerPreference: { zdr: true, data_collection: "deny", require_parameters: true },
  retry: { attempts: 2, backoff_ms: [1, 1] },
  timeoutMs: 1000,
  slotDeadlineMs: 5000,
  fetchImpl,
  sleepImpl: async () => {},
  ...over,
});

const spec = (slug: string, family: string): ModelSpec => ({ slug, family, reasoning: { effort: "high" } });

describe("runSlot — in-lab failover", () => {
  test("flagship returns a restriction blob (200) → fails over to the next model in the lab", async () => {
    const { fetchImpl } = makeMock({ chat: { "openai/gpt-5.5": [{ restriction: true }], "openai/gpt-5.4": [{ ok: true }] } });
    const client = createOpenRouterClient(baseOpts(fetchImpl));
    const r = await client.runSlot([spec("openai/gpt-5.5", "openai"), spec("openai/gpt-5.4", "openai")], "P", "openai");
    expect(r.status).toBe("ok");
    expect(r.slug).toBe("openai/gpt-5.4");
    expect(r.fallbacksUsed).toBe(1);
    expect(r.trail[0].outcome).toMatch(/invalid/);
  });

  test("flagship times out (never responds) → advances without retrying the hung model", async () => {
    const { fetchImpl, calls } = makeMock({ chat: { "x-ai/grok-4.3": [{ hang: true }], "x-ai/grok-4.20": [{ ok: true }] } });
    const client = createOpenRouterClient(baseOpts(fetchImpl, { timeoutMs: 25 }));
    const r = await client.runSlot([spec("x-ai/grok-4.3", "x-ai"), spec("x-ai/grok-4.20", "x-ai")], "P", "x-ai");
    expect(r.status).toBe("ok");
    expect(r.slug).toBe("x-ai/grok-4.20");
    expect(r.trail[0].outcome).toBe("timeout");
    // hung model called once (no retry on timeout), then the fallback once
    expect(calls.filter((c) => c.body.model === "x-ai/grok-4.3").length).toBe(1);
  });

  test("ZDR block (404 data policy) → advances down the lab chain", async () => {
    const { fetchImpl } = makeMock({ chat: { "x-ai/grok-4.3": [{ status: 404, dataPolicy: true }], "x-ai/grok-4.20": [{ ok: true }] } });
    const client = createOpenRouterClient(baseOpts(fetchImpl, { zdrEnabled: true }));
    const r = await client.runSlot([spec("x-ai/grok-4.3", "x-ai"), spec("x-ai/grok-4.20", "x-ai")], "P", "x-ai");
    expect(r.status).toBe("ok");
    expect(r.trail[0].outcome).toBe("zdr-blocked");
  });

  test("every model in the lab fails → slot failed, with the trail recorded", async () => {
    const { fetchImpl } = makeMock({ chat: { "z-ai/glm-5.2": [{ restriction: true }], "z-ai/glm-4.6": [{ status: 400 }] } });
    const client = createOpenRouterClient(baseOpts(fetchImpl));
    const r = await client.runSlot([spec("z-ai/glm-5.2", "z-ai"), spec("z-ai/glm-4.6", "z-ai")], "P", "z-ai");
    expect(r.status).toBe("failed");
    expect(r.trail.length).toBe(2);
  });

  test("retryable 5xx is retried (same model) before advancing", async () => {
    const { fetchImpl, calls } = makeMock({ chat: { "deepseek/deepseek-v4-pro": [{ status: 500 }, { ok: true }] } });
    const client = createOpenRouterClient(baseOpts(fetchImpl));
    const r = await client.runSlot([spec("deepseek/deepseek-v4-pro", "deepseek")], "P", "deepseek");
    expect(r.status).toBe("ok");
    expect(calls.length).toBe(2); // failed then retried-succeeded on the same model
  });
});

describe("fanOutPanel — barrier", () => {
  test("awaits every lab slot and returns one result per lab", async () => {
    const { fetchImpl } = makeMock({});
    const client = createOpenRouterClient(baseOpts(fetchImpl));
    const slots = [
      { family: "openai", chain: [spec("openai/gpt-5.5", "openai")] },
      { family: "google", chain: [spec("google/gemini-3.1-pro-preview", "google")] },
      { family: "deepseek", chain: [spec("deepseek/deepseek-v4-pro", "deepseek")] },
    ];
    const results = await client.fanOutPanel(slots, "P");
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  test("every lab ZDR-blocked → zero successful reviewers (the sensitive-run hard-fail input)", async () => {
    // Under enforced ZDR, every lab's only model returns OpenRouter's data-policy 404.
    const { fetchImpl } = makeMock({
      chat: {
        "openai/gpt-5.5": [{ status: 404, dataPolicy: true }],
        "x-ai/grok-4.3": [{ status: 404, dataPolicy: true }],
      },
    });
    const client = createOpenRouterClient(baseOpts(fetchImpl, { zdrEnabled: true }));
    const slots = [
      { family: "openai", chain: [spec("openai/gpt-5.5", "openai")] },
      { family: "x-ai", chain: [spec("x-ai/grok-4.3", "x-ai")] },
    ];
    const results = await client.fanOutPanel(slots, "P");
    expect(results.every((r) => r.status === "failed")).toBe(true);
    expect(results.filter((r) => r.status === "ok")).toHaveLength(0);
    expect(results.every((r) => r.trail[0].outcome === "zdr-blocked")).toBe(true);
  });

  test("rejects a Claude reviewer lab", async () => {
    const { fetchImpl } = makeMock({});
    const client = createOpenRouterClient(baseOpts(fetchImpl));
    await expect(client.fanOutPanel([{ family: "anthropic", chain: [spec("anthropic/claude-opus-4.8", "anthropic")] }], "P")).rejects.toThrow(/NON-Claude/i);
  });
});

describe("runSynthesizer — Claude chain fallback", () => {
  test("Fable returns a restriction blob → falls back to Opus", async () => {
    const { fetchImpl } = makeMock({
      chat: { "anthropic/claude-fable-5": [{ restriction: true }], "anthropic/claude-opus-4.8": [{ ok: true }] },
    });
    const client = createOpenRouterClient(baseOpts(fetchImpl));
    const synth = await client.runSynthesizer([spec("anthropic/claude-fable-5", "anthropic"), spec("anthropic/claude-opus-4.8", "anthropic")], "P");
    expect(synth.slug).toBe("anthropic/claude-opus-4.8");
    expect(synth.text).toContain("Critique from anthropic/claude-opus-4.8");
  });

  test("throws when the whole Claude chain fails", async () => {
    const { fetchImpl } = makeMock({ chat: { "anthropic/claude-fable-5": [{ restriction: true }], "anthropic/claude-opus-4.8": [{ status: 400 }] } });
    const client = createOpenRouterClient(baseOpts(fetchImpl));
    await expect(client.runSynthesizer([spec("anthropic/claude-fable-5", "anthropic"), spec("anthropic/claude-opus-4.8", "anthropic")], "P")).rejects.toThrow(/synthesis failed/i);
  });
});

describe("ZDR toggle in the request body", () => {
  test("ZDR off → no provider preference on the request", async () => {
    const { fetchImpl, calls } = makeMock({});
    const client = createOpenRouterClient(baseOpts(fetchImpl, { zdrEnabled: false }));
    await client.runSlot([spec("openai/gpt-5.5", "openai")], "P", "openai");
    expect(calls[0].body.provider).toBeUndefined();
  });

  test("ZDR on → provider.zdr:true rides on the request", async () => {
    const { fetchImpl, calls } = makeMock({});
    const client = createOpenRouterClient(baseOpts(fetchImpl, { zdrEnabled: true }));
    await client.runSlot([spec("openai/gpt-5.5", "openai")], "P", "openai");
    expect(calls[0].body.provider.zdr).toBe(true);
  });
});

describe("fetchCatalog", () => {
  test("returns id + created entries", async () => {
    const { fetchImpl } = makeMock({ catalog: [{ id: "openai/gpt-5.5", created: 1745000000 }, { id: "x-ai/grok-4.3", created: 1746000000 }] });
    const client = createOpenRouterClient(baseOpts(fetchImpl));
    const cat = await client.fetchCatalog();
    expect(cat.map((m) => m.id)).toContain("openai/gpt-5.5");
    expect(cat[0].created).toBeGreaterThan(0);
  });
});

describe("assertReviewersNonClaude", () => {
  test("throws on a claude slug, passes a non-claude lab", () => {
    expect(() => assertReviewersNonClaude([{ slug: "anthropic/claude-opus-4.8", family: "anthropic" }])).toThrow();
    expect(() => assertReviewersNonClaude([{ slug: "openai/gpt-5.5", family: "openai" }])).not.toThrow();
  });
});
