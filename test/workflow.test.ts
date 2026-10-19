import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The finish gate is a contract, not a convention: every script the always-on
 * AGENTS.md tells an agent to run must exist, and `bun run check` must chain
 * them in the documented order. Removing or renaming a gate fails here.
 */
const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
	scripts?: Record<string, string>;
};

describe("development workflow contract", () => {
	test("the gate scripts exist", () => {
		for (const script of ["typecheck", "lint", "test", "check"]) {
			expect(typeof pkg.scripts?.[script]).toBe("string");
		}
		expect(pkg.scripts?.typecheck).toContain("tsc");
		expect(pkg.scripts?.lint).toContain("biome check");
		expect(pkg.scripts?.test).toContain("bun test");
	});

	test("bun run check chains typecheck, lint and test in order", () => {
		const check = pkg.scripts?.check ?? "";
		const order = ["bun run typecheck", "bun run lint", "bun test"].map((command) => check.indexOf(command));
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	test("CI runs the same single gate, not a drifting copy of it", () => {
		const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
		expect(ci).toContain("bun run check");
		// CI must not re-list the individual steps: that is how the two drift apart.
		expect(ci).not.toContain("bun run typecheck");
		expect(ci).not.toContain("run: bun test");
	});

	test("AGENTS.md documents the same gate", () => {
		const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
		expect(agents).toContain("bunx tsc -p tsconfig.json");
		expect(agents).toContain("bun run lint");
		expect(agents).toContain("bun test");
		expect(agents).toContain("bun run check");
	});
});
