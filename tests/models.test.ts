import { test, expect, describe } from "bun:test";
import { buildFamilyChain, isValidWorkProduct, type CatalogModel } from "../adversarialReviewCore";

const CATALOG: CatalogModel[] = [
  { id: "openai/gpt-5.5", created: 1745000000 },
  { id: "openai/gpt-5.5-pro", created: 1745000000 },
  { id: "openai/gpt-5.5-mini", created: 1745000000 }, // excluded (mini)
  { id: "openai/gpt-5.5-chat", created: 1745000000 }, // excluded (chat)
  { id: "openai/gpt-5.4", created: 1741000000 },
  { id: "google/gemma-4-26b-a4b-it", created: 1748000000 }, // NEWEST but a small open model — pattern must exclude
  { id: "google/lyria-3-pro-preview", created: 1749000000 }, // a music model — pattern must exclude
  { id: "google/gemini-3.5-flash", created: 1747000000 }, // excluded (flash)
  { id: "google/gemini-3.1-pro-preview", created: 1740000000 }, // the real Gemini flagship reasoner
  { id: "x-ai/grok-build-0.1", created: 1747500000 }, // NEWEST but a tooling model — pattern must exclude
  { id: "x-ai/grok-4.3", created: 1746000000 },
  { id: "anthropic/claude-fable-5", created: 1749500000 },
  { id: "anthropic/claude-opus-4.8-fast", created: 1747000000 }, // excluded (fast)
  { id: "anthropic/claude-opus-4.8", created: 1746500000 },
];

describe("buildFamilyChain", () => {
  test("resolves a lab's smart reasoners newest-first, excludes variants, caps at depth", () => {
    const chain = buildFamilyChain(CATALOG, "openai", { depth: 3 });
    const slugs = chain.map((c) => c.slug);
    // mini + chat excluded; gpt-5.5 / gpt-5.5-pro (newest) then gpt-5.4
    expect(slugs).not.toContain("openai/gpt-5.5-mini");
    expect(slugs).not.toContain("openai/gpt-5.5-chat");
    expect(slugs).toContain("openai/gpt-5.5");
    expect(slugs[slugs.length - 1]).toBe("openai/gpt-5.4"); // oldest is last
    expect(chain.length).toBeLessThanOrEqual(3);
  });

  test("does NOT exclude 'preview' — a current flagship can be a preview", () => {
    const chain = buildFamilyChain(CATALOG, "google", { depth: 3 });
    const slugs = chain.map((c) => c.slug);
    expect(slugs).toContain("google/gemini-3.1-pro-preview");
    expect(slugs).not.toContain("google/gemini-3.5-flash"); // flash excluded
  });

  test("synthesizer chain (anthropic): Fable first, Opus as fallback", () => {
    const chain = buildFamilyChain(CATALOG, "anthropic", { depth: 3 });
    expect(chain[0].slug).toBe("anthropic/claude-fable-5"); // newest
    expect(chain.map((c) => c.slug)).toContain("anthropic/claude-opus-4.8");
  });

  test("attaches the lab's reasoning to every chain entry", () => {
    const chain = buildFamilyChain(CATALOG, "deepseek", { depth: 2, reasoning: { effort: "xhigh" } });
    // deepseek has no entries in this small catalog -> empty chain is fine
    const chain2 = buildFamilyChain(CATALOG, "openai", { depth: 2, reasoning: { effort: "xhigh" } });
    expect(chain2[0].reasoning).toEqual({ effort: "xhigh" });
    expect(chain.length).toBe(0);
  });

  test("a lab absent from the catalog resolves to an empty chain", () => {
    expect(buildFamilyChain(CATALOG, "nonexistentlab", { depth: 3 })).toEqual([]);
  });

  test("includePattern scopes to the flagship reasoner LINE — excludes gemma, lyria, grok-build", () => {
    // Without a pattern, the newest google model is gemma (a small open model) — wrong.
    const noPattern = buildFamilyChain(CATALOG, "google", { depth: 3 });
    expect(noPattern[0].slug).toMatch(/gemma|lyria/); // demonstrates the naive failure

    // With the line pattern, only the real Gemini flagship reasoner survives.
    const google = buildFamilyChain(CATALOG, "google", { depth: 3, includePattern: "gemini-[0-9.]+-pro" });
    expect(google.map((c) => c.slug)).toEqual(["google/gemini-3.1-pro-preview"]);

    // xAI: grok-build-0.1 is newer but the pattern keeps grok-4.3.
    const xai = buildFamilyChain(CATALOG, "x-ai", { depth: 3, includePattern: "grok-[0-9]" });
    expect(xai[0].slug).toBe("x-ai/grok-4.3");
    expect(xai.map((c) => c.slug)).not.toContain("x-ai/grok-build-0.1");
  });

  test("anthropic synthesizer chain: Fable then Opus, -fast variant excluded", () => {
    const a = buildFamilyChain(CATALOG, "anthropic", { depth: 3, includePattern: "claude-(fable|opus|sonnet)-?[0-9]" });
    expect(a.map((c) => c.slug)).toEqual(["anthropic/claude-fable-5", "anthropic/claude-opus-4.8"]);
  });
});

describe("isValidWorkProduct", () => {
  const realCritique =
    "Pillar A (the 75-minute saving) is BROKEN: the figure counts only the meeting cost and ignores the " +
    "time spent writing and reading async updates, which is substantial. Pillar B holds at the individual " +
    "level but is WEAK at the team level because blocker latency increases. Severity-ranked fixes follow.";

  test("accepts a real, substantial critique", () => {
    expect(isValidWorkProduct(realCritique).valid).toBe(true);
  });

  test("rejects empty / too-short responses", () => {
    expect(isValidWorkProduct("").valid).toBe(false);
    expect(isValidWorkProduct("ok").valid).toBe(false);
    expect(isValidWorkProduct(null).valid).toBe(false);
  });

  test("rejects an availability/legal restriction blob (the Fable-blocked case)", () => {
    const blob =
      "This model is currently unavailable in your region due to government regulation and export-control " +
      "restrictions under applicable law. Please try a different model or contact support for further assistance.";
    const r = isValidWorkProduct(blob);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/restriction|unavailable/i);
  });

  test("rejects a task-refusal opener", () => {
    const refusal = "I'm sorry, I can't help with this request. As an AI, I am not able to comply with adversarial review of this material under the current policy and must decline.";
    expect(isValidWorkProduct(refusal).valid).toBe(false);
  });

  test("does NOT reject a finding that merely says 'I cannot find support'", () => {
    const finding =
      "I cannot find support for the central claim in the provided evidence. The assumption that the standup " +
      "is pure overhead is unverified, and the document never enumerates what coordination value the meeting " +
      "actually provides. This is a WEAK pillar, severity high, but the reasoning below stands on the evidence.";
    expect(isValidWorkProduct(finding).valid).toBe(true);
  });

  test("rejects an error-shaped payload leaked as content", () => {
    expect(isValidWorkProduct('{"error": "rate limited, try again later, this is a fairly long error body to clear the length floor and ensure we exercise the error-shape branch rather than the length branch"}').valid).toBe(false);
  });
});
