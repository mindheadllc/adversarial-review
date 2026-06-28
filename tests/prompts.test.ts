import { test, expect, describe } from "bun:test";
import { join } from "path";
import {
  normalizePacket,
  fillScaffold,
  leftoverPlaceholders,
  renderAxes,
  type ResolvedSources,
} from "../adversarialReviewCore";

const SKILL_DIR = join(import.meta.dir, "..");

async function scaffold(name: string): Promise<string> {
  return await Bun.file(join(SKILL_DIR, "prompt-scaffolds", `${name}.md`)).text();
}

const resolved: ResolvedSources = {
  artifactText: "ARTIFACT BODY TEXT",
  evidenceText: "EVIDENCE BODY",
  opponentInfoText: "OPPONENT KNOWS X AND Y",
};

describe("fillScaffold — adversarial", () => {
  test("fills every placeholder; none leak", async () => {
    const tmpl = await scaffold("adversarial");
    const { packet } = normalizePacket({
      mode: "adversarial",
      artifact: { text: "x" },
      question: "Is the removal clause enforceable?",
      frame: "Legal accuracy only.",
      axes: [{ name: "citation accuracy", probe: "Do the citations exist?" }],
      known_gaps: ["Missing the 2019 amendment."],
    });
    const out = fillScaffold(tmpl, packet, resolved);
    expect(leftoverPlaceholders(out)).toEqual([]);
    expect(out).toContain("Is the removal clause enforceable?");
    expect(out).toContain("citation accuracy");
    expect(out).toContain("ARTIFACT BODY TEXT");
    expect(out).toContain("EVIDENCE BODY");
    expect(out).toContain("Missing the 2019 amendment.");
    // The agnostic-framing guardrails survive into the prompt.
    expect(out).toMatch(/strongest version/i);
    expect(out).toMatch(/endorsement is not data/i);
  });

  test("empty evidence renders the explicit '(none provided)' sentinel", async () => {
    const tmpl = await scaffold("adversarial");
    const { packet } = normalizePacket({
      mode: "adversarial",
      artifact: { text: "x" },
      question: "q?",
      frame: "f",
      axes: [{ name: "assumptions" }],
    });
    const out = fillScaffold(tmpl, packet, { artifactText: "A", evidenceText: "", opponentInfoText: "" });
    expect(out).toContain("(none provided)");
    expect(leftoverPlaceholders(out)).toEqual([]);
  });

  test("carries the secondary packet-limitations nudge (harvested packet-auditor)", async () => {
    const tmpl = await scaffold("adversarial");
    expect(tmpl).toContain("Packet limitations");
    expect(tmpl).toMatch(/byproduct, not your main task/i);
  });
});

describe("fillScaffold — steel-man", () => {
  test("fills opponent placeholders; none leak; reasons only from opponent info", async () => {
    const tmpl = await scaffold("steel-man");
    const { packet } = normalizePacket({
      mode: "steel-man",
      artifact: { text: "Our observable position." },
      question: "How does the opponent defeat us?",
      frame: "Strategic counter-play.",
      axes: [{ name: "leverage" }],
      opponent: {
        identity: "The minority director",
        goal: "Retain the seat",
        information: [{ text: "Knows the supermajority requirement." }],
      },
    });
    const out = fillScaffold(tmpl, packet, resolved);
    expect(leftoverPlaceholders(out)).toEqual([]);
    expect(out).toContain("The minority director");
    expect(out).toContain("Retain the seat");
    expect(out).toContain("OPPONENT KNOWS X AND Y");
    // The contamination guard survives into the prompt.
    expect(out).toMatch(/do not have access to the other side's private reasoning/i);
  });

  test("carries the secondary packet-limitations nudge", async () => {
    const tmpl = await scaffold("steel-man");
    expect(tmpl).toContain("Packet limitations");
  });
});

describe("renderAxes", () => {
  test("numbers axes and includes the probe line when present", () => {
    const out = renderAxes([
      { name: "assumptions", probe: "What is unstated?" },
      { name: "failure modes" },
    ]);
    expect(out).toContain("1. assumptions");
    expect(out).toContain("Probe: What is unstated?");
    expect(out).toContain("2. failure modes");
  });
});
