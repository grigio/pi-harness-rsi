import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config";
import { newLedger, saveLedger } from "../src/ledger";
import { pruneRuns } from "../src/retention";

const cfg = resolveConfig({}, {} as NodeJS.ProcessEnv);

function makeCwdWithRuns(ids: ReadonlyArray<{ id: string; outcome?: "pending" | "adopted" | "running" }>): string {
	const cwd = mkdtempSync(join(tmpdir(), "rsi-ret-"));
	for (const { id, outcome } of ids) {
		const dir = join(cwd, ".pi", "harness", "runs", id);
		mkdirSync(dir, { recursive: true });
		const ledger = newLedger(id, "task", "demo", cfg);
		if (outcome) ledger.outcome = outcome;
		saveLedger(dir, ledger);
	}
	return cwd;
}

describe("run retention (rsi.keepRuns)", () => {
	test("keeps the newest N runs by run id order, deletes the decided rest", () => {
		const cwd = makeCwdWithRuns([
			{ id: "20261010-100000-alpha" },
			{ id: "20261011-100000-beta" },
			{ id: "20261012-100000-gamma" },
			{ id: "20261013-100000-delta" },
		]);
		const result = pruneRuns(cwd, { keepRuns: 2 });
		expect(result.removed).toEqual(["20261011-100000-beta", "20261010-100000-alpha"]);
		expect(result.kept).toBe(2);
		expect(existsSync(join(cwd, ".pi", "harness", "runs", "20261012-100000-gamma"))).toBe(true);
		expect(existsSync(join(cwd, ".pi", "harness", "runs", "20261013-100000-delta"))).toBe(true);
		expect(existsSync(join(cwd, ".pi", "harness", "runs", "20261011-100000-beta"))).toBe(false);
	});

	test("pending adoptions and protected ids are never pruned (repairability)", () => {
		const cwd = makeCwdWithRuns([
			{ id: "20261001-100000-old" },
			{ id: "20261002-100000-pending", outcome: "pending" },
			{ id: "20261003-100000-new" },
		]);
		const result = pruneRuns(cwd, { keepRuns: 1, protect: ["20261001-100000-old"] });
		expect(result.removed).toEqual([]);
		for (const id of ["20261001-100000-old", "20261002-100000-pending", "20261003-100000-new"]) {
			expect(existsSync(join(cwd, ".pi", "harness", "runs", id))).toBe(true);
		}
	});

	test("an empty or missing runs directory is a no-op", () => {
		const cwd = mkdtempSync(join(tmpdir(), "rsi-ret-"));
		expect(pruneRuns(cwd, { keepRuns: 5 })).toEqual({ removed: [], kept: 0 });
	});
});
