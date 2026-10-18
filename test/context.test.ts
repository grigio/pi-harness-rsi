import { describe, expect, test } from "bun:test";
import { BudgetError, assemble, budgetFor, capNotes } from "../src/context";
import { PROFILES } from "../src/config";

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
