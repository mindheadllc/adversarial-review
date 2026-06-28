import { test, expect, describe } from "bun:test";
import {
  normalizePacket,
  labelReviewers,
  buildSynthesisPrompt,
  buildReportMarkdown,
  type ReviewerResult,
  type ResolvedSources,
  type RunMeta,
} from "../adversarialReviewCore";

const resolved: ResolvedSources = { artifactText: "THE ARTIFACT", evidenceText: "", opponentInfoText: "" };

const okResult = (slug: string, family: string, critique: string): ReviewerResult => ({ slug, family, status: "ok", critique });
const failResult = (slug: string, family: string, error: string): ReviewerResult => ({ slug, family, status: "failed", error, attempts: 3 });

describe("labelReviewers", () => {
  test("labels only successful reviewers A, B, C in order", () => {
    const labelled = labelReviewers([
      okResult("deepseek/deepseek-v4-pro", "deepseek", "c1"),
      failResult("x-ai/grok-4.3", "xai", "500"),
      okResult("openai/gpt-5.2", "openai", "c2"),
    ]);
    expect(labelled.map((l) => l.label)).toEqual(["Reviewer A", "Reviewer B"]);
    expect(labelled.map((l) => l.result.slug)).toEqual(["deepseek/deepseek-v4-pro", "openai/gpt-5.2"]);
  });
});

describe("buildSynthesisPrompt — adversarial", () => {
  const { packet } = normalizePacket({
    mode: "adversarial",
    artifact: { text: "x" },
    question: "Is the clause enforceable?",
    frame: "Legal accuracy.",
    axes: [{ name: "citation accuracy" }, { name: "law accuracy" }],
  });
  const results = [okResult("deepseek/deepseek-v4-pro", "deepseek", "DEEPSEEK SAYS BROKEN"), okResult("x-ai/grok-4.3", "xai", "GROK SAYS WEAK")];

  test("anonymizes reviewers and embeds the thesis", () => {
    const p = buildSynthesisPrompt(packet, results, resolved);
    expect(p).toContain("Reviewer A");
    expect(p).toContain("Reviewer B");
    expect(p).toContain("DEEPSEEK SAYS BROKEN");
    expect(p).toContain("Is the clause enforceable?");
    expect(p).toContain("THE ARTIFACT");
    // brand names must NOT appear in the synthesis prompt (anonymized)
    expect(p).not.toContain("deepseek/deepseek-v4-pro");
  });

  test("carries the adversarial synthesis instructions", () => {
    const p = buildSynthesisPrompt(packet, results, resolved);
    expect(p).toMatch(/HOLDS \| WEAK \| BROKEN/);
    expect(p).toMatch(/severity-ranked fix list/i);
    expect(p).toMatch(/final judge/i);
  });

  test("emits a Packet Health section and the UNTESTED guardrail", () => {
    const p = buildSynthesisPrompt(packet, results, resolved);
    expect(p).toContain("Packet Health");
    // UNTESTED is added to the verdict vocabulary...
    expect(p).toMatch(/HOLDS \| WEAK \| BROKEN \| UNTESTED/);
    // ...and a pillar nobody could probe must never be rolled into HOLDS.
    expect(p).toMatch(/never fold an untested pillar into holds/i);
  });

  test("excludes failed reviewers from the synthesis body", () => {
    const withFail = [...results, failResult("openai/gpt-5.2", "openai", "timeout")];
    const p = buildSynthesisPrompt(packet, withFail, resolved);
    expect(p).toContain("Reviewer A");
    expect(p).toContain("Reviewer B");
    expect(p).not.toContain("Reviewer C"); // only 2 ok reviewers
    expect(p).not.toContain("timeout");
  });
});

describe("buildSynthesisPrompt — steel-man", () => {
  const { packet } = normalizePacket({
    mode: "steel-man",
    artifact: { text: "our position" },
    question: "How do they beat us?",
    frame: "Counter-play.",
    axes: [{ name: "leverage" }],
    opponent: { identity: "the director", goal: "keep the seat", information: [{ text: "knows the bylaws" }] },
  });
  const results = [okResult("deepseek/deepseek-v4-pro", "deepseek", "OPPONENT PLAY 1")];

  test("carries the game-theory playbook instructions", () => {
    const p = buildSynthesisPrompt(packet, results, resolved);
    expect(p).toMatch(/game-theory playbook/i);
    expect(p).toMatch(/counter-strategy/i);
    expect(p).toMatch(/Move \/ Basis \/ Expected response \/ Counter \/ End-state/);
  });

  test("emits a Packet Health section in steel-man mode too", () => {
    const p = buildSynthesisPrompt(packet, results, resolved);
    expect(p).toContain("Packet Health");
  });
});

describe("buildReportMarkdown", () => {
  const { packet } = normalizePacket({
    mode: "adversarial",
    artifact: { path: "foo/bylaws.md" },
    question: "Is the clause enforceable?",
    frame: "Legal accuracy.",
    axes: [{ name: "citation accuracy" }],
    meta: { title: "bylaws removal clause" },
  });
  const results = [
    okResult("deepseek/deepseek-v4-pro", "deepseek", "DEEPSEEK CRITIQUE"),
    okResult("x-ai/grok-4.3", "xai", "GROK CRITIQUE"),
    failResult("openai/gpt-5.2", "openai", "HTTP 503: upstream unavailable"),
  ];
  const meta: RunMeta = {
    timestamp: "2026-06-22T18:30:00Z",
    configuredReviewerSlugs: ["deepseek/deepseek-v4-pro", "x-ai/grok-4.3", "openai/gpt-5.2"],
    synthesizerSlug: "anthropic/claude-opus-4.8",
    mode: "adversarial",
  };

  test("puts synthesis on top and raw critiques in the appendix", () => {
    const md = buildReportMarkdown(packet, results, "THE SYNTHESIS", meta);
    const synthIdx = md.indexOf("## Synthesis");
    const appendixIdx = md.indexOf("## Appendix");
    expect(synthIdx).toBeGreaterThan(-1);
    expect(appendixIdx).toBeGreaterThan(synthIdx); // synthesis before appendix
    expect(md).toContain("THE SYNTHESIS");
    expect(md).toContain("bylaws removal clause");
  });

  test("de-anonymizes reviewers in the appendix and names failed labs", () => {
    const md = buildReportMarkdown(packet, results, "S", meta);
    expect(md).toContain("Reviewer A — deepseek via deepseek/deepseek-v4-pro");
    expect(md).toContain("x-ai/grok-4.3");
    expect(md).toContain("DEEPSEEK CRITIQUE");
    // failed lab is named with its error
    expect(md).toContain("Failed labs");
    expect(md).toContain("HTTP 503");
    expect(md).toContain("Reviewers succeeded:** 2 of 3");
    // panel line shows lab -> model used
    expect(md).toMatch(/Panel \(lab → model used\):.*deepseek/);
    expect(md).toContain("Synthesizer:** anthropic/claude-opus-4.8");
  });

  test("surfaces the in-lab failover path when a flagship was skipped", () => {
    const failedOver: ReviewerResult = {
      family: "anthropic-ish-lab",
      slug: "lab/second-model",
      status: "ok",
      critique: "critique after failover",
      fallbacksUsed: 1,
      trail: [
        { slug: "lab/flagship", outcome: "invalid (restriction blob)" },
        { slug: "lab/second-model", outcome: "ok" },
      ],
    };
    const md = buildReportMarkdown(packet, [failedOver], "S", meta);
    expect(md).toContain("Failed over within lab");
    expect(md).toContain("lab/flagship");
    expect(md).toMatch(/\(failover\)/);
  });

  test("handles zero successful reviewers gracefully in the appendix", () => {
    const md = buildReportMarkdown(packet, [failResult("a/b", "a", "boom")], "S", meta);
    expect(md).toContain("No successful reviewer critiques");
  });
});
