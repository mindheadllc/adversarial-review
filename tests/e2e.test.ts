import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";

const SKILL_DIR = join(import.meta.dir, "..");
const ENTRY = join(SKILL_DIR, "adversarial_review.ts");
const CATALOG = join(SKILL_DIR, "tests", "fixtures", "catalog.json");

let TMP: string;
let ARTIFACT_FILE: string;
let NO_CRED_CONFIG: string;

beforeAll(async () => {
  TMP = mkdtempSync(join(tmpdir(), "advrev-"));
  ARTIFACT_FILE = join(TMP, "artifact.md");
  writeFileSync(ARTIFACT_FILE, "# Test artifact\nThis article claims a structural identity between two domains.\n");
  // A config with NO credential source (no env_file, no keychain, no host-local
  // fallback files), so the credential hard-fail test is deterministic regardless of
  // the build host — a real local env file could otherwise satisfy it.
  const cfg: any = Bun.YAML.parse(await Bun.file(join(SKILL_DIR, "models.config.yaml")).text());
  delete cfg.credential.keychain_service;
  delete cfg.credential.env_file;
  delete cfg.credential.fallback_files;
  cfg.credential.env = "OPENROUTER_API_KEY_UNSET_IN_TEST"; // deterministic: guaranteed absent from env
  NO_CRED_CONFIG = join(TMP, "no-cred.config.yaml");
  writeFileSync(NO_CRED_CONFIG, JSON.stringify(cfg, null, 2));
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

async function runCli(
  args: string[],
  opts: { cwd?: string; stdin?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    cwd: opts.cwd ?? SKILL_DIR,
    stdin: opts.stdin != null ? Buffer.from(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OPENROUTER_API_KEY: "", ADVREVIEW_OPENROUTER_API_KEY: "", ...(opts.env ?? {}) },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

const COMPLETE = JSON.stringify({
  mode: "adversarial",
  sensitivity: "not-sensitive",
  artifact: { text: "inline artifact body under review for the e2e test" },
  question: "Is the central claim of this artifact actually supported?",
  frame: "Test the claim, not the prose. Out of scope: tone.",
  axes: [{ name: "assumptions", probe: "What is unstated?" }, { name: "failure modes", probe: "How does it fail?" }],
});

// Same as COMPLETE but declared sensitive — used for the ZDR-coupling e2e checks.
const COMPLETE_SENSITIVE = JSON.stringify({ ...JSON.parse(COMPLETE), sensitivity: "sensitive" });

// Missing sensitivity (and the other rails) — the gate must list sensitivity as a gap.
const MUSHY = JSON.stringify({ mode: "adversarial", artifact: {}, question: "", frame: "TBD", axes: [] });

describe("gate subcommand", () => {
  test("rejects a mushy packet with a per-rail gap list (exit 2)", async () => {
    const r = await runCli(["gate", "--packet", "-"], { stdin: MUSHY });
    expect(r.code).toBe(2);
    const j = JSON.parse(r.stdout);
    expect(j.status).toBe("rejected");
    const rails = j.gaps.map((g: any) => g.rail).sort();
    expect(rails).toEqual(["artifact", "axes", "frame", "question", "sensitivity"]);
  });

  test("passes a complete packet (exit 0)", async () => {
    const r = await runCli(["gate", "--packet", "-"], { stdin: COMPLETE });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).status).toBe("ok");
  });
});

describe("describe subcommand", () => {
  test("echoes the packet in plain language", async () => {
    const r = await runCli(["describe", "--packet", "-"], { stdin: COMPLETE });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Adversarial");
    expect(r.stdout).toContain("assumptions");
  });
});

describe("axes subcommand", () => {
  test("lists all bundled axis-sets", async () => {
    const r = await runCli(["axes"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    const names = j.axis_sets.map((s: any) => s.name).sort();
    expect(names).toEqual(["legal-accuracy", "strategy-decision", "structural-claim"]);
  });

  test("suggests the matching set for a review type", async () => {
    const r = await runCli(["axes", "--review-type", "structural-claim"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).suggested.name).toBe("structural-claim");
  });
});

describe("run subcommand — gate enforcement", () => {
  test("a mushy packet is rejected BEFORE any model call (exit 2)", async () => {
    const r = await runCli(["run", "--packet", "-"], { stdin: MUSHY });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Precision gate REJECTED");
  });
});

describe("run subcommand — dry run (no spend, no network, offline catalog)", () => {
  test("resolves the live-style panel from the catalog and lists labs without calling out", async () => {
    const r = await runCli(["run", "--packet", "-", "--dry-run", "--catalog", CATALOG], { stdin: COMPLETE });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.status).toBe("dry_run");
    expect(Array.isArray(j.panel)).toBe(true);
    expect(j.panel.length).toBeGreaterThanOrEqual(3);
    // each panel entry resolved a current flagship (e.g. openai → gpt-5.5, not 5.1)
    const openai = j.panel.find((p: any) => p.lab === "openai");
    expect(openai.flagship).toMatch(/^openai\/gpt-5\.5/);
    // synthesizer resolves to the Claude flagship (Fable) with Opus as fallback
    expect(j.synthesizer).toContain("claude");
    expect(j.reviewer_prompt_preview).toContain("Is the central claim");
  });

  test("ZDR is off by default and on with --zdr", async () => {
    const off = JSON.parse((await runCli(["run", "--packet", "-", "--dry-run", "--catalog", CATALOG], { stdin: COMPLETE })).stdout);
    const on = JSON.parse((await runCli(["run", "--packet", "-", "--dry-run", "--catalog", CATALOG, "--zdr"], { stdin: COMPLETE })).stdout);
    expect(off.zdr).toBe(false);
    expect(on.zdr).toBe(true);
  });

  test("saved-template path: swaps in one artifact and runs", async () => {
    const r = await runCli(
      ["run", "--template", join(SKILL_DIR, "packet-templates", "saved-recurring.yaml"), "--artifact", ARTIFACT_FILE, "--dry-run", "--catalog", CATALOG],
      {},
    );
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.status).toBe("dry_run");
    expect(j.reviewer_prompt_preview).toContain("coined vocabulary"); // template's fixed question
    expect(j.reviewer_prompt_preview).toContain("structural identity between two domains"); // swapped artifact
  });
});

describe("sensitivity rail — gate + ZDR coupling (Phase 5)", () => {
  test("gate rejects a packet missing sensitivity, listing it as a gap (exit 2)", async () => {
    const noSens = JSON.stringify({ ...JSON.parse(COMPLETE), sensitivity: undefined });
    const r = await runCli(["gate", "--packet", "-"], { stdin: noSens });
    expect(r.code).toBe(2);
    const rails = JSON.parse(r.stdout).gaps.map((g: any) => g.rail);
    expect(rails).toContain("sensitivity");
  });

  test("sensitive packet forces ZDR ON even without --zdr (dry-run)", async () => {
    const r = await runCli(["run", "--packet", "-", "--dry-run", "--catalog", CATALOG], { stdin: COMPLETE_SENSITIVE });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.sensitivity).toBe("sensitive");
    expect(j.zdr).toBe(true);
    expect(j.zdr_forced).toBe(true);
  });

  test("sensitive packet + --no-zdr is HARD-REFUSED before any model/catalog call (non-zero)", async () => {
    const r = await runCli(["run", "--packet", "-", "--no-zdr", "--catalog", CATALOG], { stdin: COMPLETE_SENSITIVE });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/REFUSED/);
    expect(r.stderr).toMatch(/--no-zdr/);
    // never produced a report path
    expect(r.stdout).not.toContain("report_path");
  });

  test("not-sensitive preserves v1: ZDR off by default, not forced (dry-run)", async () => {
    const r = await runCli(["run", "--packet", "-", "--dry-run", "--catalog", CATALOG], { stdin: COMPLETE });
    const j = JSON.parse(r.stdout);
    expect(j.sensitivity).toBe("not-sensitive");
    expect(j.zdr).toBe(false);
    expect(j.zdr_forced).toBe(false);
  });

  test("describe shows the declared sensitivity and the resulting ZDR routing", async () => {
    const sensitive = await runCli(["describe", "--packet", "-"], { stdin: COMPLETE_SENSITIVE });
    expect(sensitive.code).toBe(0);
    expect(sensitive.stdout).toMatch(/Sensitivity:\s*SENSITIVE/);
    expect(sensitive.stdout).toMatch(/ZDR routing:\s*ON/);

    const notSensitive = await runCli(["describe", "--packet", "-"], { stdin: COMPLETE });
    expect(notSensitive.stdout).toMatch(/Sensitivity:\s*not-sensitive/);
    expect(notSensitive.stdout).toMatch(/ZDR routing:\s*off/);
  });

  test("describe surfaces the REFUSED routing for sensitive + --no-zdr (exit 0, inspection only)", async () => {
    const r = await runCli(["describe", "--packet", "-", "--no-zdr"], { stdin: COMPLETE_SENSITIVE });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/ZDR routing:\s*REFUSED/);
  });
});

describe("models subcommand", () => {
  test("lists the live-resolved flagship + fallbacks per lab (offline catalog)", async () => {
    const r = await runCli(["models", "--catalog", CATALOG], {});
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    const openai = j.reviewer_labs.find((l: any) => l.lab === "openai");
    expect(openai.flagship).toMatch(/^openai\/gpt-5\.5/);
    expect(j.synthesizer.flagship).toContain("claude-fable-5");
  });
});

describe("run subcommand — hard fails (never an empty review)", () => {
  test("missing credential hard-fails with a clear message (non-zero, no network)", async () => {
    const r = await runCli(["run", "--packet", "-", "--config", NO_CRED_CONFIG], { stdin: COMPLETE });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("missing credential");
  });
});

describe("self-containment", () => {
  test("runs from a foreign cwd with an inline-artifact packet (bundled reads are skill-dir-relative)", async () => {
    // cwd is the temp dir, NOT the repo root — proves config/scaffolds/axis-sets load
    // from the skill dir, and an inline artifact needs no external read at all.
    const r = await runCli(["run", "--packet", "-", "--dry-run", "--catalog", CATALOG], { cwd: TMP, stdin: COMPLETE });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).status).toBe("dry_run");
  });
});
