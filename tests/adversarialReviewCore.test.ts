import { test, expect, describe } from "bun:test";
import {
  isVacuous,
  sourceRefIsEmpty,
  normalizePacket,
  validatePacket,
  serializePacket,
  describePacket,
  DEFAULT_STANCE,
  DEFAULT_OUTPUT_SHAPE,
  PACKET_SCHEMA_VERSION,
  type ThesisPacket,
} from "../adversarialReviewCore";

// A complete, valid adversarial packet object (pre-normalization).
function completeAdversarialRaw(): any {
  return {
    mode: "adversarial",
    sensitivity: "not-sensitive",
    artifact: { path: "foo/bylaws.md" },
    question: "Do the bylaws as drafted give the board the power to remove a director without cause?",
    frame: "Review the legal accuracy of the removal provisions. Out of scope: drafting style.",
    axes: [
      { name: "citation accuracy", probe: "Does every cited section exist and say what is claimed?" },
      { name: "law accuracy", probe: "Is the statement of governing law correct for the jurisdiction?" },
    ],
    evidence: {
      include: [{ path: "foo/current_bylaws.md" }],
      exclude: [{ item: "the author's preferred outcome", why: "it would bias the reading toward that result" }],
    },
    known_gaps: ["We do not have the 2019 amendment on file."],
  };
}

function completeSteelManRaw(): any {
  return {
    mode: "steel-man",
    sensitivity: "not-sensitive",
    artifact: { text: "Our position: we control the majority of board seats and intend to vote out the minority director." },
    question: "How would the opposing director defeat our removal attempt?",
    frame: "Model the opponent's strategic and legal counter-play. Out of scope: the merits of removal itself.",
    axes: [{ name: "leverage", probe: "What leverage would the opponent press on?" }],
    opponent: {
      identity: "The minority director, a litigator by background",
      goal: "Retain the board seat and deter future removal attempts",
      information: [{ text: "Knows the bylaws require a supermajority for removal without cause." }],
    },
  };
}

describe("isVacuous", () => {
  test("empty / whitespace / null are vacuous", () => {
    expect(isVacuous("")).toBe(true);
    expect(isVacuous("   ")).toBe(true);
    expect(isVacuous(null)).toBe(true);
    expect(isVacuous(undefined)).toBe(true);
  });
  test("placeholder tokens are vacuous", () => {
    for (const t of ["TBD", "tbd", "TODO", "n/a", "N/A", "none", "???", "xxx", "...", "—", "placeholder"]) {
      expect(isVacuous(t)).toBe(true);
    }
  });
  test("bare hedges are vacuous", () => {
    for (const t of ["not sure", "unclear", "maybe", "idk", "it depends", "stuff"]) {
      expect(isVacuous(t)).toBe(true);
    }
  });
  test("real content is NOT vacuous, even if it contains a hedge word", () => {
    expect(isVacuous("I am not sure the citation is correct — verify section 4.2")).toBe(false);
    expect(isVacuous("Maybe the board lacks authority; check the supermajority clause")).toBe(false);
    expect(isVacuous("citation accuracy")).toBe(false);
  });
});

describe("sourceRefIsEmpty", () => {
  test("empty when neither path nor text", () => {
    expect(sourceRefIsEmpty({})).toBe(true);
    expect(sourceRefIsEmpty(undefined)).toBe(true);
    expect(sourceRefIsEmpty({ path: "" })).toBe(true);
    expect(sourceRefIsEmpty({ path: "TBD" })).toBe(true);
  });
  test("non-empty with a path or text", () => {
    expect(sourceRefIsEmpty({ path: "a/b.md" })).toBe(false);
    expect(sourceRefIsEmpty({ text: "some real content here" })).toBe(false);
  });
});

describe("normalizePacket", () => {
  test("applies stance + output_shape + schema_version defaults", () => {
    const { packet } = normalizePacket(completeAdversarialRaw());
    expect(packet.schema_version).toBe(PACKET_SCHEMA_VERSION);
    expect(packet.stance).toBe(DEFAULT_STANCE);
    expect(packet.output_shape).toEqual(DEFAULT_OUTPUT_SHAPE);
  });
  test("coerces a bare string artifact into { text }", () => {
    const { packet } = normalizePacket({ ...completeAdversarialRaw(), artifact: "inline artifact body" });
    expect(packet.artifact.text).toBe("inline artifact body");
  });
  test("coerces string axes into { name }", () => {
    const { packet } = normalizePacket({ ...completeAdversarialRaw(), axes: ["assumptions", "failure modes"] });
    expect(packet.axes.map((a) => a.name)).toEqual(["assumptions", "failure modes"]);
  });
  test("defaults unknown mode to adversarial with a warning", () => {
    const { packet, warnings } = normalizePacket({ ...completeAdversarialRaw(), mode: "weird" });
    expect(packet.mode).toBe("adversarial");
    expect(warnings.join(" ")).toContain("weird");
  });
  test("accepts the steelman alias", () => {
    const { packet } = normalizePacket({ ...completeSteelManRaw(), mode: "steelman" });
    expect(packet.mode).toBe("steel-man");
  });
  test("non-object input yields a shell packet that fails validation", () => {
    const { packet } = normalizePacket(null);
    const res = validatePacket(packet);
    expect(res.ok).toBe(false);
  });
});

describe("validatePacket — adversarial", () => {
  test("a complete adversarial packet passes", () => {
    const { packet } = normalizePacket(completeAdversarialRaw());
    const res = validatePacket(packet);
    expect(res.ok).toBe(true);
  });

  test("missing artifact fails with an artifact gap", () => {
    const { packet } = normalizePacket({ ...completeAdversarialRaw(), artifact: {} });
    const res = validatePacket(packet);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.gaps.map((g) => g.rail)).toContain("artifact");
  });

  test("missing question fails", () => {
    const { packet } = normalizePacket({ ...completeAdversarialRaw(), question: "" });
    const res = validatePacket(packet);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.gaps.map((g) => g.rail)).toContain("question");
  });

  test("hedged frame ('TBD') fails", () => {
    const { packet } = normalizePacket({ ...completeAdversarialRaw(), frame: "TBD" });
    const res = validatePacket(packet);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.gaps.map((g) => g.rail)).toContain("frame");
  });

  test("empty axes fails", () => {
    const { packet } = normalizePacket({ ...completeAdversarialRaw(), axes: [] });
    const res = validatePacket(packet);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.gaps.map((g) => g.rail)).toContain("axes");
  });

  test("an axis with a placeholder name fails", () => {
    const { packet } = normalizePacket({ ...completeAdversarialRaw(), axes: [{ name: "TBD" }] });
    const res = validatePacket(packet);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.gaps.map((g) => g.rail)).toContain("axes");
  });

  test("returns ALL gaps at once, not just the first", () => {
    const { packet } = normalizePacket({ mode: "adversarial", artifact: {}, question: "", frame: "", axes: [] });
    const res = validatePacket(packet);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const rails = res.gaps.map((g) => g.rail).sort();
      // sensitivity joins the universal required rails (no default; absent is a gap).
      expect(rails).toEqual(["artifact", "axes", "frame", "question", "sensitivity"]);
    }
  });

  test("adversarial mode does NOT require an opponent", () => {
    const raw = completeAdversarialRaw();
    delete raw.opponent;
    const { packet } = normalizePacket(raw);
    const res = validatePacket(packet);
    expect(res.ok).toBe(true);
  });

  test("a leading axis probe produces a warning but still passes", () => {
    const raw = completeAdversarialRaw();
    raw.axes = [{ name: "citation accuracy", probe: "Prove that the citation is wrong" }];
    const { packet } = normalizePacket(raw);
    const res = validatePacket(packet);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.warnings.join(" ")).toMatch(/leading question/i);
  });
});

describe("validatePacket — steel-man", () => {
  test("a complete steel-man packet passes", () => {
    const { packet } = normalizePacket(completeSteelManRaw());
    const res = validatePacket(packet);
    expect(res.ok).toBe(true);
  });

  test("steel-man without an opponent fails on opponent", () => {
    const raw = completeSteelManRaw();
    delete raw.opponent;
    const { packet } = normalizePacket(raw);
    const res = validatePacket(packet);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.gaps.map((g) => g.rail)).toContain("opponent");
  });

  test("steel-man with a hollow opponent fails on identity, goal, and information", () => {
    const raw = completeSteelManRaw();
    raw.opponent = { identity: "", goal: "TBD", information: [] };
    const { packet } = normalizePacket(raw);
    const res = validatePacket(packet);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const rails = res.gaps.map((g) => g.rail);
      expect(rails).toContain("opponent.identity");
      expect(rails).toContain("opponent.goal");
      expect(rails).toContain("opponent.information");
    }
  });

  test("steel-man opponent.information with only-empty sources fails", () => {
    const raw = completeSteelManRaw();
    raw.opponent.information = [{ path: "" }, { text: "" }];
    const { packet } = normalizePacket(raw);
    const res = validatePacket(packet);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.gaps.map((g) => g.rail)).toContain("opponent.information");
  });
});

describe("serialize / describe", () => {
  test("serializePacket round-trips through normalize", () => {
    const { packet } = normalizePacket(completeAdversarialRaw());
    const json = serializePacket(packet);
    const { packet: again } = normalizePacket(JSON.parse(json));
    expect(again.question).toBe(packet.question);
    expect(again.axes.map((a) => a.name)).toEqual(packet.axes.map((a) => a.name));
  });

  test("describePacket renders plain-language lines for the echo", () => {
    const { packet } = normalizePacket(completeAdversarialRaw());
    const desc = describePacket(packet);
    expect(desc).toContain("Adversarial");
    expect(desc).toContain("citation accuracy");
    expect(desc).toContain(packet.question);
  });

  test("describePacket includes opponent block for steel-man", () => {
    const { packet } = normalizePacket(completeSteelManRaw());
    const desc = describePacket(packet);
    expect(desc).toContain("Opponent:");
    expect(desc).toContain("Goal:");
  });
});
