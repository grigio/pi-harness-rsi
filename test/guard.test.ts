import { describe, expect, test } from "bun:test";
import { assertAdoptionAllowed, AdoptionGateError, forbiddenMatch, scanTripwire, tripwireError } from "../src/guard";
import { matchGlob, matchesAnyGlob, seededShuffle, seedFromString, jaccardLines, slugify, sanitizeSegment } from "../src/util";
import { DEFAULT_FORBIDDEN_GLOBS, PROFILES, resolveConfig } from "../src/config";

const cfg = resolveConfig({ profile: "small" }, {} as NodeJS.ProcessEnv);

describe("forbidden globs", () => {
	test("plan defaults are immutable", () => {
		expect(forbiddenMatch("tests/foo.test.ts", cfg)).toBe("tests/**");
		expect(forbiddenMatch("package.json", cfg)).toBe("package.json");
		expect(forbiddenMatch(".github/workflows/ci.yml", cfg)).toBe(".github/**");
		expect(forbiddenMatch("src/index.ts", cfg)).toBeUndefined();
		expect(forbiddenMatch("AGENTS.md", cfg)).toBeUndefined();
	});

	test("glob semantics", () => {
		expect(matchGlob("a/b/c.ts", "a/**")).toBe(true);
		expect(matchGlob("a.ts", "a/**")).toBe(false);
		expect(matchGlob("src/x.test.ts", "**/*.test.ts")).toBe(true);
		expect(matchGlob("x.test.ts", "**/*.test.ts")).toBe(true);
		expect(matchGlob("src/x.ts", "**/*.test.ts")).toBe(false);
		expect(matchesAnyGlob("bun.lock", DEFAULT_FORBIDDEN_GLOBS)).toBe("bun.lock");
	});
});

describe("grader-gaming tripwire", () => {
	test("catches marker phrasing case-insensitively", () => {
		expect(scanTripwire("AGENTS.md", "Check what The Grader Expects")).toBe("the grader expects");
		expect(scanTripwire("pass_rate", "")).toBe("pass_rate");
		expect(scanTripwire("scripts/check.sh", "rm tests/… delete the failing test")).toBe("delete the failing test");
	});

	test("clean behaviour text passes", () => {
		expect(scanTripwire("AGENTS.md", "Run the verifier and paste its exit code.")).toBeUndefined();
	});

	test("error text is actionable (verbatim retry feedback)", () => {
		const message = tripwireError("AGENTS.md", "pass_rate");
		expect(message).toContain("pass_rate");
		expect(message).toContain("retry");
	});
});

describe("adoption gate (P6)", () => {
	test("refuses when confirmation is required but absent", () => {
		expect(() => assertAdoptionAllowed({ confirmAdopt: true }, false)).toThrow(AdoptionGateError);
		expect(() => assertAdoptionAllowed({ confirmAdopt: true }, true)).not.toThrow();
		// explicit opt-out is the user's decision
		expect(() => assertAdoptionAllowed({ confirmAdopt: false }, false)).not.toThrow();
	});
});

describe("deterministic helpers", () => {
	test("seeded shuffle is reproducible and order-independent of nothing", () => {
		const seed = seedFromString("run-1");
		const a = seededShuffle(["f0", "f1", "f2"], seed);
		const b = seededShuffle(["f0", "f1", "f2"], seed);
		expect(a).toEqual(b);
		expect([...a].sort()).toEqual(["f0", "f1", "f2"]);
		const other = seededShuffle(["f0", "f1", "f2"], seed + 1);
		expect(other).not.toEqual(a);
	});

	test("jaccard over lines detects mode collapse", () => {
		expect(jaccardLines("a\nb\nc", "a\nb\nc")).toBe(1);
		expect(jaccardLines("a\nb", "c\nd")).toBe(0);
		expect(jaccardLines("", "")).toBe(1);
	});

	test("domains and slugs stay single path segments", () => {
		expect(sanitizeSegment("../../etc")).toBe("etc");
		expect(sanitizeSegment("")).toBe("default");
		expect(slugify("Fix auth bug!")).toBe("fix-auth-bug");
	});
});
