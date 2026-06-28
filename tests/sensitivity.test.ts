import { test, expect, describe } from "bun:test";
import {
  coerceSensitivity,
  normalizePacket,
  validatePacket,
  describeSensitivity,
  describePacket,
  resolveZdrDecision,
  evaluatePanel,
  PACKET_SCHEMA_VERSION,
} from "../adversarialReviewCore";

// A complete adversarial packet WITHOUT a sensitivity declaration.
function completeNoSensitivity(): any {
  return {
    mode: "adversarial",
    artifact: { path: "foo/bylaws.md" },
    question: "Do the bylaws give the board power to remove a director without cause?",
    frame: "Legal accuracy of the removal provisions. Out of scope: drafting style.",
    axes: [{ name: "citation accuracy", probe: "Does every cited section exist?" }],
  };
}
function completeSteelManNoSensitivity(): any {
  return {
    mode: "steel-man",
    artifact: { text: "Our observable position." },
    question: "How does the opponent defeat us?",
    frame: "Strategic counter-play. Out of scope: the merits.",
    axes: [{ name: "leverage", probe: "What leverage would they press?" }],
    opponent: { identity: "the minority director", goal: "retain the seat", information: [{ text: "knows the supermajority rule" }] },
  };
}

describe("coerceSensitivity", () => {
  test("accepts the two canonical values", () => {
    expect(coerceSensitivity("sensitive").value).toBe("sensitive");
    expect(coerceSensitivity("not-sensitive").value).toBe("not-sensitive");
  });
  test("accepts separator/spelling variants", () => {
    expect(coerceSensitivity("Sensitive").value).toBe("sensitive");
    expect(coerceSensitivity("  SENSITIVE  ").value).toBe("sensitive");
    expect(coerceSensitivity("not sensitive").value).toBe("not-sensitive");
    expect(coerceSensitivity("not_sensitive").value).toBe("not-sensitive");
    expect(coerceSensitivity("nonsensitive").value).toBe("not-sensitive");
  });
  test("empty / missing → undefined, NO warning (gate handles it)", () => {
    expect(coerceSensitivity("").value).toBeUndefined();
    expect(coerceSensitivity("").warning).toBeUndefined();
    expect(coerceSensitivity(undefined).value).toBeUndefined();
    expect(coerceSensitivity(null).value).toBeUndefined();
  });
  test("a boolean is NOT accepted (sensitivity is not a boolean) and warns", () => {
    const t = coerceSensitivity(true);
    expect(t.value).toBeUndefined();
    expect(t.warning).toMatch(/not a boolean|must be the string/i);
    const f = coerceSensitivity(false);
    expect(f.value).toBeUndefined();
    expect(f.warning).toBeTruthy();
  });
  test("an unrecognized string → undefined with a warning", () => {
    const r = coerceSensitivity("kinda");
    expect(r.value).toBeUndefined();
    expect(r.warning).toMatch(/Unrecognized sensitivity/i);
  });
});

describe("the gate requires sensitivity in BOTH modes — absent ≠ false", () => {
  test("adversarial: missing sensitivity is a gap, no other rails affected", () => {
    const { packet } = normalizePacket(completeNoSensitivity());
    const res = validatePacket(packet);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const rails = res.gaps.map((g) => g.rail);
      expect(rails).toEqual(["sensitivity"]); // the ONLY gap — everything else is complete
    }
  });

  test("steel-man: missing sensitivity is a gap", () => {
    const { packet } = normalizePacket(completeSteelManNoSensitivity());
    const res = validatePacket(packet);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.gaps.map((g) => g.rail)).toContain("sensitivity");
  });

  test("an unrecognized sensitivity value is rejected (treated as undeclared)", () => {
    const { packet, warnings } = normalizePacket({ ...completeNoSensitivity(), sensitivity: "maybe-private" });
    expect(warnings.join(" ")).toMatch(/Unrecognized sensitivity/i);
    const res = validatePacket(packet);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.gaps.map((g) => g.rail)).toContain("sensitivity");
  });

  test("a boolean sensitivity is rejected (not a silent true/false)", () => {
    const { packet } = normalizePacket({ ...completeNoSensitivity(), sensitivity: false });
    const res = validatePacket(packet);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.gaps.map((g) => g.rail)).toContain("sensitivity");
  });

  test("declared sensitive passes (adversarial)", () => {
    const { packet } = normalizePacket({ ...completeNoSensitivity(), sensitivity: "sensitive" });
    expect(validatePacket(packet).ok).toBe(true);
    expect(packet.sensitivity).toBe("sensitive");
  });

  test("declared not-sensitive passes (steel-man)", () => {
    const { packet } = normalizePacket({ ...completeSteelManNoSensitivity(), sensitivity: "not-sensitive" });
    expect(validatePacket(packet).ok).toBe(true);
  });

  test("the schema_version bumped to 2 with the new rail", () => {
    expect(PACKET_SCHEMA_VERSION).toBe(2);
    const { packet } = normalizePacket({ ...completeNoSensitivity(), sensitivity: "sensitive" });
    expect(packet.schema_version).toBe(2);
  });
});

describe("resolveZdrDecision — sensitivity drives routing, safety cannot be silently overridden", () => {
  const base = { explicitNoZdr: false, explicitZdr: false, packetZdr: undefined as boolean | undefined, configDefault: false };

  test("sensitive forces ZDR ON regardless of config default or absence of --zdr", () => {
    const d = resolveZdrDecision({ ...base, sensitivity: "sensitive" });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.zdr).toBe(true);
      expect(d.forced).toBe(true);
    }
  });

  test("sensitive forces ON even when the config default is off", () => {
    const d = resolveZdrDecision({ ...base, sensitivity: "sensitive", configDefault: false });
    expect(d.ok && d.zdr).toBe(true);
  });

  test("sensitive + --no-zdr → REFUSED (never a silent downgrade)", () => {
    const d = resolveZdrDecision({ ...base, sensitivity: "sensitive", explicitNoZdr: true });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.error).toMatch(/REFUSED/);
      expect(d.error).toMatch(/--no-zdr/);
    }
  });

  test("sensitive + packet zdr:false → REFUSED, naming the packet as the source", () => {
    const d = resolveZdrDecision({ ...base, sensitivity: "sensitive", packetZdr: false });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toMatch(/zdr: false in the packet/);
  });

  test("sensitive + --no-zdr is refused even if --zdr is also present (no silent resolution)", () => {
    const d = resolveZdrDecision({ ...base, sensitivity: "sensitive", explicitNoZdr: true, explicitZdr: true });
    expect(d.ok).toBe(false);
  });

  test("sensitive + --zdr (consistent) → ON, forced", () => {
    const d = resolveZdrDecision({ ...base, sensitivity: "sensitive", explicitZdr: true });
    expect(d.ok && d.zdr && d.forced).toBe(true);
  });

  test("not-sensitive preserves v1: default off when nothing else decides", () => {
    const d = resolveZdrDecision({ ...base, sensitivity: "not-sensitive", configDefault: false });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.zdr).toBe(false);
      expect(d.forced).toBe(false);
    }
  });

  test("not-sensitive: --zdr turns it on; --no-zdr wins over --zdr", () => {
    expect((resolveZdrDecision({ ...base, sensitivity: "not-sensitive", explicitZdr: true }) as any).zdr).toBe(true);
    expect((resolveZdrDecision({ ...base, sensitivity: "not-sensitive", explicitZdr: true, explicitNoZdr: true }) as any).zdr).toBe(false);
  });

  test("not-sensitive: packet zdr: true is honored; config default applies last", () => {
    expect((resolveZdrDecision({ ...base, sensitivity: "not-sensitive", packetZdr: true }) as any).zdr).toBe(true);
    expect((resolveZdrDecision({ ...base, sensitivity: "not-sensitive", configDefault: true }) as any).zdr).toBe(true);
  });

  test("undeclared sensitivity resolves defensively as not-sensitive (the gate blocks it upstream)", () => {
    const d = resolveZdrDecision({ ...base, sensitivity: undefined });
    expect(d.ok && d.forced).toBe(false);
  });
});

describe("evaluatePanel — never an empty review; sensitive zero-ZDR-reviewer hard-fail", () => {
  test("a sensitive run that resolves ZERO ZDR-capable reviewers hard-fails (not a fallback)", () => {
    const r = evaluatePanel(
      { okCount: 0, total: 6, labErrors: ["x-ai: zdr-blocked", "openai: zdr-blocked"] },
      { panelMin: 1, sensitiveZdrForced: true },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/sensitive review resolved ZERO ZDR-capable/i);
      expect(r.message).toMatch(/zdr-blocked/);
    }
  });

  test("a non-sensitive run with zero reviewers still hard-fails (generic below-min)", () => {
    const r = evaluatePanel({ okCount: 0, total: 3, labErrors: ["a: 500"] }, { panelMin: 1, sensitiveZdrForced: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/too few successful reviewer labs/i);
  });

  test("enough reviewers → ok", () => {
    expect(evaluatePanel({ okCount: 3, total: 6, labErrors: [] }, { panelMin: 1, sensitiveZdrForced: true }).ok).toBe(true);
    expect(evaluatePanel({ okCount: 1, total: 6, labErrors: [] }, { panelMin: 1, sensitiveZdrForced: false }).ok).toBe(true);
  });
});

describe("describeSensitivity / describePacket surface the rail", () => {
  test("describeSensitivity covers all three states", () => {
    expect(describeSensitivity("sensitive")).toMatch(/SENSITIVE/);
    expect(describeSensitivity("sensitive")).toMatch(/REFUSED/);
    expect(describeSensitivity("not-sensitive")).toMatch(/not-sensitive/);
    expect(describeSensitivity(undefined)).toMatch(/NOT DECLARED/);
  });

  test("describePacket includes a Sensitivity line", () => {
    const { packet } = normalizePacket({ ...completeNoSensitivity(), sensitivity: "sensitive" });
    expect(describePacket(packet)).toMatch(/Sensitivity:\s*SENSITIVE/);
  });
});
