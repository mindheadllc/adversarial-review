import { test, expect, describe } from "bun:test";
import { parseEnvFileVar, resolveCredential, type CredentialIO } from "../adversarialReviewCore";

describe("parseEnvFileVar", () => {
  test("reads a plain assignment", () => {
    expect(parseEnvFileVar("OPENROUTER_API_KEY=sk-or-abc123", "OPENROUTER_API_KEY")).toBe("sk-or-abc123");
  });
  test("honors an `export ` prefix and strips quotes", () => {
    expect(parseEnvFileVar(`export OPENROUTER_API_KEY="sk-or-xyz"`, "OPENROUTER_API_KEY")).toBe("sk-or-xyz");
    expect(parseEnvFileVar(`ADVREVIEW_OPENROUTER_API_KEY='k=eyJ.a.b'`, "ADVREVIEW_OPENROUTER_API_KEY")).toBe("k=eyJ.a.b");
  });
  test("picks the right var among several lines and ignores comments", () => {
    const text = "# comment\nOTHER=nope\nOPENROUTER_API_KEY=correct\n";
    expect(parseEnvFileVar(text, "OPENROUTER_API_KEY")).toBe("correct");
  });
  test("returns null for a missing or empty var", () => {
    expect(parseEnvFileVar("OTHER=x", "OPENROUTER_API_KEY")).toBeNull();
    expect(parseEnvFileVar("OPENROUTER_API_KEY=", "OPENROUTER_API_KEY")).toBeNull();
  });
  test("does not match a var whose name is a suffix of another (no partial match)", () => {
    // A line for FOO_OPENROUTER_API_KEY must not satisfy a lookup of OPENROUTER_API_KEY.
    expect(parseEnvFileVar("FOO_OPENROUTER_API_KEY=wrong", "OPENROUTER_API_KEY")).toBeNull();
  });
});

// Injectable IO built from plain maps — resolution is tested with zero fs/network/spend.
function io(opts: {
  env?: Record<string, string>;
  files?: Record<string, string>;
  keychain?: Record<string, string>;
  platform?: string;
}): CredentialIO {
  return {
    getEnv: (n) => opts.env?.[n],
    readFile: (p) => (opts.files && p in opts.files ? opts.files[p] : null),
    readKeychain: (s) => opts.keychain?.[s] ?? null,
    platform: opts.platform ?? "darwin",
  };
}

// Mirrors the shipped models.config.yaml credential block.
const PLAN = {
  primaryEnv: "ADVREVIEW_OPENROUTER_API_KEY",
  envFile: "~/.config/advreview/key.env",
  keychainService: "openrouter-advreview",
  fallbackFiles: [{ path: "~/.config/advreview/fallback.env", var: "OPENROUTER_API_KEY" }],
};

describe("resolveCredential — host-local resolution order", () => {
  test("primary env var wins (shell with the dedicated key exported)", () => {
    const r = resolveCredential(PLAN, io({ env: { ADVREVIEW_OPENROUTER_API_KEY: "k-env" } }));
    expect(r).toEqual({ key: "k-env", source: "env:ADVREVIEW_OPENROUTER_API_KEY" });
  });

  test("falls back to the primary env file when the env var is absent (non-interactive)", () => {
    const r = resolveCredential(PLAN, io({ files: { "~/.config/advreview/key.env": "ADVREVIEW_OPENROUTER_API_KEY=k-file" } }));
    expect(r).toEqual({ key: "k-file", source: "file:~/.config/advreview/key.env" });
  });

  test("Fallback-file case: resolves the host-local fallback file when no dedicated key exists", () => {
    const r = resolveCredential(PLAN, io({ files: { "~/.config/advreview/fallback.env": "OPENROUTER_API_KEY=k-fallback" } }));
    expect(r).toEqual({ key: "k-fallback", source: "file:~/.config/advreview/fallback.env" });
  });

  test("BLEED GUARD: a generic OPENROUTER_API_KEY in the ENV is never used as a source", () => {
    // A generically-named key in the env (e.g. for a different account) must not bleed in.
    const r = resolveCredential(PLAN, io({ env: { OPENROUTER_API_KEY: "OTHER-ACCOUNT-KEY" } }));
    expect(r).toBeNull(); // dedicated env absent, no files → nothing resolves; env OPENROUTER_API_KEY ignored
  });

  test("BLEED GUARD: env OPENROUTER_API_KEY is ignored even when the fallback FILE also exists", () => {
    const r = resolveCredential(
      PLAN,
      io({
        env: { OPENROUTER_API_KEY: "OTHER-ACCOUNT-KEY" },
        files: { "~/.config/advreview/fallback.env": "OPENROUTER_API_KEY=k-fallback-file" },
      }),
    );
    expect(r?.key).toBe("k-fallback-file"); // the FILE source, never the env value
    expect(r?.source).toBe("file:~/.config/advreview/fallback.env");
  });

  test("keychain is consulted on darwin only", () => {
    const opts = { keychain: { "openrouter-advreview": "k-keychain" } };
    expect(resolveCredential(PLAN, io({ ...opts, platform: "darwin" }))?.source).toBe("keychain:openrouter-advreview");
    expect(resolveCredential(PLAN, io({ ...opts, platform: "linux" }))).toBeNull();
  });

  test("ordering: primary env file precedes keychain precedes fallback files", () => {
    const r = resolveCredential(
      PLAN,
      io({
        files: {
          "~/.config/advreview/key.env": "ADVREVIEW_OPENROUTER_API_KEY=k-primary-file",
          "~/.config/advreview/fallback.env": "OPENROUTER_API_KEY=k-fallback",
        },
        keychain: { "openrouter-advreview": "k-keychain" },
      }),
    );
    expect(r?.key).toBe("k-primary-file");
  });

  test("returns null when nothing resolves (clean hard-fail signal)", () => {
    expect(resolveCredential(PLAN, io({}))).toBeNull();
  });

  test("multiple fallback files are tried in order, first hit wins", () => {
    const plan = {
      primaryEnv: "ADVREVIEW_OPENROUTER_API_KEY",
      fallbackFiles: [
        { path: "/host-a/key.env", var: "OPENROUTER_API_KEY" },
        { path: "/host-b/key.env", var: "OPENROUTER_API_KEY" },
      ],
    };
    const r = resolveCredential(plan, io({ files: { "/host-b/key.env": "OPENROUTER_API_KEY=b-only" } }));
    expect(r).toEqual({ key: "b-only", source: "file:/host-b/key.env" });
  });
});
