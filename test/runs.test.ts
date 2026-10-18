import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config";
import { newLedger, saveLedger } from "../src/ledger";
import { latestRunId, listRunIds, listRuns, runsDir } from "../src/runs";

const cfg = resolveConfig({}, {} as NodeJS.ProcessEnv);

function makeProject(): string {
	return mkdtempSync(join(tmpdir(), "rsi-runs-"));
}

function makeRun(cwd: string, id: string, opts: { ledger?: boolean } = {}): string {
	const dir = join(runsDir(cwd), id);
	mkdirSync(dir, { recursive: true });
	if (opts.ledger !== false) saveLedger(dir, newLedger(id, "task", "demo", cfg));
	return dir;
}

describe("run discovery (src/runs.ts)", () => {
	test("lists top-level run dirs newest-first and ignores files", () => {
		const cwd = makeProject();
		makeRun(cwd, "20260101-000000-old");
		makeRun(cwd, "20260102-000000-new");
		writeFileSync(join(runsDir(cwd), "stray.txt"), "not a run\n");
		expect(listRunIds(cwd)).toEqual(["20260102-000000-new", "20260101-000000-old"]);
	});

	test("a run with a deep evidence tree does not hide later runs (top-level scan)", () => {
		const cwd = makeProject();
		// Simulate a run that would exhaust a recursive walk cap: many nested files.
		const deep = makeRun(cwd, "20260101-000000-deep");
		for (let i = 0; i < 50; i++) {
			const dir = join(deep, "evidence", "rollouts", `n${i}`, "more");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "session.jsonl"), "{}\n");
		}
		makeRun(cwd, "20260103-000000-later");
		const ids = listRunIds(cwd);
		expect(ids).toContain("20260101-000000-deep");
		expect(ids).toContain("20260103-000000-later");
		expect(ids[0]).toBe("20260103-000000-later"); // newest is not hidden by depth
	});

	test("listRuns reports an undefined ledger for unreadable runs (fail closed)", () => {
		const cwd = makeProject();
		makeRun(cwd, "20260101-000000-ok");
		makeRun(cwd, "20260102-000000-noledger", { ledger: false });
		const runs = listRuns(cwd);
		expect(runs.find((r) => r.runId === "20260101-000000-ok")?.ledger?.runId).toBe("20260101-000000-ok");
		expect(runs.find((r) => r.runId === "20260102-000000-noledger")?.ledger).toBeUndefined();
	});

	test("latestRunId skips runs without a readable ledger and supports predicates", () => {
		const cwd = makeProject();
		makeRun(cwd, "20260101-000000-old");
		makeRun(cwd, "20260102-000000-new");
		makeRun(cwd, "20260103-000000-broken", { ledger: false });
		expect(latestRunId(cwd)).toBe("20260102-000000-new");
		expect(latestRunId(cwd, { predicate: (l) => l.runId === "20260101-000000-old" })).toBe("20260101-000000-old");
	});

	test("a missing runs directory is an empty list, not a throw", () => {
		expect(listRunIds(makeProject())).toEqual([]);
		expect(latestRunId(makeProject())).toBeUndefined();
	});
});
