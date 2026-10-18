import { describe, expect, test } from "bun:test";
import { PROFILES, resolveConfig } from "../src/config";
import { assemble, assembleStrict, BudgetError, budgetFor, capNotes } from "../src/context";
import { type ComposeInputs, composeParts, type MissionInputs, proposeParts } from "../src/editor";

const small = PROFILES.small;

describe("context.assemble — the budget choke point", () => {
	test("mandatory parts over budget raise (never truncate)", () => {
		const huge = { name: "digests", text: "x".repeat(small.composeMission + 10) };
		expect(() => assemble("compose", [huge], small)).toThrow(BudgetError);
		try {
			assemble("compose", [huge], small);
		} catch (err) {
			const e = err as BudgetError;
			expect(e.stage).toBe("compose");
			expect(e.budget).toBe(small.composeMission);
			expect(e.actual).toBeGreaterThan(small.composeMission);
			expect(e.message).toContain("over its");
		}
	});

	test("a mission inside budget reports used ≤ budget", () => {
		const mission = assemble(
			"propose",
			[
				{ name: "task", text: "fix the failing check" },
				{ name: "digests", text: "y".repeat(1000) },
			],
			small,
		);
		expect(mission.used).toBeLessThanOrEqual(mission.budget);
		expect(mission.budget).toBe(small.proposeMission);
		expect(mission.dropped).toEqual([]);
		expect(mission.text.startsWith("# rsi-stage: propose")).toBe(true);
		expect(mission.text).toContain("## task");
	});

	test("optional parts are dropped whole, never sliced, and the drop is announced", () => {
		const parts = [
			{ name: "task", text: "t" },
			{ name: "opt-a", text: "a".repeat(6_000), optional: true },
			{ name: "opt-b", text: "b".repeat(6_000), optional: true },
			{ name: "opt-c", text: "c".repeat(6_000), optional: true },
		];
		const mission = assemble("propose", parts, small); // propose budget = 16 000
		expect(mission.used).toBeLessThanOrEqual(mission.budget);
		expect(mission.dropped).toEqual(["opt-c"]);
		expect(mission.text).toContain("## dropped-over-budget");
		expect(mission.text).toContain("## opt-a");
		expect(mission.text).toContain("## opt-b");
		// whole-or-nothing: no slice of the dropped part ever appears
		expect(mission.text).not.toContain("## opt-c");
		expect(mission.text).not.toContain("cccccccccc");
	});

	test("an optional part that fits is included in full", () => {
		const mission = assemble(
			"reflect",
			[
				{ name: "task", text: "t" },
				{ name: "library index", text: "small index", optional: true },
			],
			small,
		);
		expect(mission.text).toContain("## library index");
		expect(mission.dropped).toEqual([]);
		expect(mission.used).toBeLessThanOrEqual(small.reflectMission);
	});

	test("optional parts never raise, even when the drop-notice itself will not fit", () => {
		const budget = small.proposeMission;
		// Mandatory content already fills nearly the whole budget, so the dropped
		// part's own notice cannot be appended — optional content must still never fail the stage.
		const mission = assemble(
			"propose",
			[
				{ name: "task", text: "x".repeat(budget - 40) },
				{ name: "library lessons", text: "y".repeat(5_000), optional: true },
			],
			small,
		);
		expect(mission.used).toBeLessThanOrEqual(mission.budget);
		expect(mission.dropped).toContain("library lessons");
		expect(mission.text).not.toContain("library lessons");
		expect(mission.text).not.toContain("yyyyyyyyyy");
	});

	test("assembleStrict promotes optional parts to mandatory (they then raise when over budget)", () => {
		const parts = [
			{ name: "task", text: "t" },
			{ name: "library index", text: "z".repeat(small.proposeMission), optional: true },
		];
		expect(assemble("propose", parts, small).dropped).toEqual(["library index"]);
		expect(() => assembleStrict("propose", parts, small)).toThrow(BudgetError);
	});

	test("per-stage budgets come from the profile", () => {
		expect(budgetFor("propose", small)).toBe(small.proposeMission);
		expect(budgetFor("compose", small)).toBe(small.composeMission);
		expect(budgetFor("reflect", small)).toBe(small.reflectMission);
		expect(budgetFor("select", small)).toBe(small.selectMission);
		expect(budgetFor("compose", PROFILES.large)).toBe(64_000);
	});

	test("notes are capped at the stage budget", () => {
		const capped = capNotes("n".repeat(small.notes + 50), small);
		expect([...capped].length).toBe(small.notes);
		expect(capped.endsWith("…")).toBe(true);
		const short = capNotes("short note", small);
		expect(short).toBe("short note");
	});
});

describe("mission eviction order — best optional parts declared first", () => {
	const cfg = resolveConfig({ profile: "small" }, {} as NodeJS.ProcessEnv);
	const inputs: MissionInputs = {
		task: "run the verifier after every edit",
		domain: "demo",
		surface: { "AGENTS.md": "# demo" },
		evidence: [],
		digests: [],
		libraryIndex: "INDEX",
		libraryLessons: ["lesson body"],
	};

	test("proposeParts declares library lessons before the index (assemble drops from the tail)", () => {
		const parts = proposeParts("propose-inv", inputs, cfg);
		const lessons = parts.findIndex((p) => p.name === "library lessons");
		const index = parts.findIndex((p) => p.name === "library index");
		expect(lessons).toBeGreaterThan(-1);
		expect(index).toBeGreaterThan(lessons);
	});

	test("composeParts declares library lessons before the index", () => {
		const parts = composeParts({ ...inputs, contrast: [], decisionNotes: [] } satisfies ComposeInputs, cfg);
		const lessons = parts.findIndex((p) => p.name === "library lessons");
		const index = parts.findIndex((p) => p.name === "library index");
		expect(lessons).toBeGreaterThan(-1);
		expect(index).toBeGreaterThan(lessons);
	});
});
