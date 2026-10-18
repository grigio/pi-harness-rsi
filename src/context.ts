/**
 * Mission assembly + budget enforcement — the single choke point (PLAN-rsi.md §7.1).
 *
 * Rules:
 *  - every stage declares a char budget from the active profile;
 *  - assembling over budget **raises** — it never silently truncates, because
 *    silent truncation is what fabricates false defects (Harness² `obs_trunc`);
 *  - *optional* parts (library bodies, extra digests) are dropped **whole** when
 *    they do not fit, and the drop is recorded in the mission header so the
 *    editor still gets a pointer instead of a slice.
 */

import type { Budgets, RsiConfig } from "./config";
import { charLen, extractTag } from "./util";

export type MissionStage = "propose" | "compose" | "reflect" | "select";

export interface MissionPart {
	name: string;
	text: string;
	/** Optional parts are dropped whole when they do not fit (never truncated). */
	optional?: boolean;
}

export interface AssembledMission {
	stage: MissionStage;
	text: string;
	used: number;
	budget: number;
	dropped: string[];
}

export class BudgetError extends Error {
	readonly stage: MissionStage;
	readonly budget: number;
	readonly actual: number;

	constructor(stage: MissionStage, budget: number, actual: number, culprit: string) {
		super(
			`stage "${stage}" assembled to ${actual} chars, over its ${budget} budget ` +
				`(culprit: ${culprit}) — reduce the mission, do not truncate it`,
		);
		this.name = "BudgetError";
		this.stage = stage;
		this.budget = budget;
		this.actual = actual;
	}
}

export function budgetFor(stage: MissionStage, budgets: Budgets): number {
	switch (stage) {
		case "propose":
			return budgets.proposeMission;
		case "compose":
			return budgets.composeMission;
		case "reflect":
			return budgets.reflectMission;
		case "select":
			return budgets.selectMission;
	}
}

/**
 * Assemble a mission from parts under `stage`'s budget.
 * Mandatory parts that do not fit raise; optional parts are dropped whole.
 */
export function assemble(stage: MissionStage, parts: readonly MissionPart[], budgets: Budgets): AssembledMission {
	const budget = budgetFor(stage, budgets);
	const dropped: string[] = [];

	const header = `# rsi-stage: ${stage}`;
	const chunkOf = (part: MissionPart): string => `## ${part.name}\n${part.text}`;
	const noticeOf = (names: string[]): string =>
		`## dropped-over-budget\n${names.join(", ")} — pointers only; open the files, do not guess their content`;

	// Pass 1: header + mandatory parts must fit, otherwise the stage is rejected.
	let mandatoryTotal = charLen(header);
	for (const part of parts) {
		if (part.optional) continue;
		mandatoryTotal += charLen(chunkOf(part)) + 2;
	}
	if (mandatoryTotal > budget) {
		const worst = parts
			.filter((p) => !p.optional)
			.map((p) => `${p.name} (${charLen(p.text)})`)
			.sort()
			.join(", ");
		throw new BudgetError(stage, budget, mandatoryTotal, worst || "header");
	}

	// Pass 2: mandatory text.
	let text = header;
	for (const part of parts) {
		if (part.optional) continue;
		text = `${text}\n\n${chunkOf(part)}`;
	}

	// Pass 3: optional parts, whole-or-nothing, reserving room for the drop notice.
	for (const part of parts) {
		if (!part.optional) continue;
		const size = charLen(chunkOf(part)) + 2;
		const without = charLen(text);
		if (without + size <= budget) {
			text = `${text}\n\n${chunkOf(part)}`;
			continue;
		}
		// Does not fit: record the whole-part drop, but only if the notice still fits.
		const names = [...dropped, part.name];
		if (without + charLen(noticeOf(names)) + 2 > budget) {
			throw new BudgetError(stage, budget, without + charLen(noticeOf(names)) + 2, `${part.name} + drop-notice`);
		}
		dropped.push(part.name);
	}

	if (dropped.length > 0) {
		text = `${text}\n\n${noticeOf(dropped)}`;
	}

	const used = charLen(text);
	if (used > budget) throw new BudgetError(stage, budget, used, "header");

	return { stage, text, used, budget, dropped };
}

/**
 * Assemble without optional parts ever being able to fit — used by tests and by
 * stages that must not depend on optional content (P0 characterization).
 */
export function assembleStrict(stage: MissionStage, parts: readonly MissionPart[], budgets: Budgets): AssembledMission {
	return assemble(
		stage,
		parts.map((p) => ({ ...p, optional: false })),
		budgets,
	);
}

/** `<notes>`/`<why>` note cap — parser side of the notes budget. */
export function capNotes(notes: string, budgets: Budgets): string {
	const max = budgets.notes;
	if (charLen(notes) <= max) return notes;
	return `${[...notes].slice(0, max - 1).join("")}…`;
}

/** Config convenience: budgets of the active profile with overrides applied. */
export function budgetsOf(cfg: Pick<RsiConfig, "budgets">): Budgets {
	return cfg.budgets;
}

/** Re-export so callers only import `context` for anything budget-shaped. */
export { extractTag };
