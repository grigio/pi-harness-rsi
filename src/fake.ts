/**
 * Deterministic fake substrate for `PI_RSI_FAKE=1`.
 *
 * Two entry points:
 *  - `fakeSessionJsonl()` — synthesizes a child-pi session file for a rollout,
 *    so digests, deliverables and USD accounting are exercised without any
 *    model call;
 *  - `fakeEditorReply()` — the editor's reply text (`<notes>` + `<edits>`),
 *    with an `invalid-first` scenario used to prove retry-then-fallback.
 *
 * Everything is a pure function of its inputs: byte-stable across runs, which
 * is what makes the golden/characterization tests meaningful.
 */

import { hash12 } from "./util";

export type FakeStage = "propose-inv" | "propose-dom" | "compose" | "select" | "reflect";

export interface FakeSessionInput {
	label: string;
	prompt: string;
	kind: "rollout" | "editor";
}

function iso(offsetMs: number): string {
	return new Date(1_700_000_000_000 + offsetMs).toISOString();
}

function costFor(label: string): number {
	const h = parseInt(hash12(label).slice(0, 6), 16);
	return ((h % 90) + 10) / 10_000; // 0.0010 … 0.0099 USD, deterministic
}

/**
 * A small but structurally valid pi session JSONL: header, user prompt, two
 * assistant turns with tool calls/results, and a closing assistant message.
 * Reference labels (`ref*`) get a failing check so digests carry error signal.
 */
export function fakeSessionJsonl(input: FakeSessionInput): string {
	const { label, prompt } = input;
	const isRef = /^ref/.test(label);
	const cost = costFor(label);
	const id = (n: number): string => `${label}-${n}`;
	const entries: unknown[] = [];

	entries.push({ type: "session", version: 3, id: `fake-${label}`, timestamp: iso(0), cwd: "/fake/sandbox" });
	entries.push({
		type: "message",
		id: id(0),
		parentId: null,
		timestamp: iso(10),
		message: { role: "user", content: prompt.slice(0, 4000), timestamp: 1_700_000_000_010 },
	});
	entries.push({
		type: "message",
		id: id(1),
		parentId: id(0),
		timestamp: iso(20),
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "Running the checks first." },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } },
			],
			api: "fake",
			provider: "fake",
			model: "fake-solver",
			usage: {
				input: 120,
				output: 24,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 144,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost / 4 },
			},
			stopReason: "toolUse",
			timestamp: 1_700_000_000_020,
		},
	});
	entries.push({
		type: "message",
		id: id(2),
		parentId: id(1),
		timestamp: iso(30),
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [
				{
					type: "text",
					text: isRef ? "FAIL src/foo.test.ts — expected 3, got 4\nexit code 1" : "PASS 14/14 checks\nexit code 0",
				},
			],
			isError: isRef,
			timestamp: 1_700_000_000_030,
		},
	});
	entries.push({
		type: "message",
		id: id(3),
		parentId: id(2),
		timestamp: iso(40),
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-2",
					name: "edit",
					arguments: { path: "src/index.ts", oldString: "a", newString: "b" },
				},
			],
			api: "fake",
			provider: "fake",
			model: "fake-solver",
			usage: {
				input: 260,
				output: 41,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 301,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost / 4 },
			},
			stopReason: "toolUse",
			timestamp: 1_700_000_000_040,
		},
	});
	entries.push({
		type: "message",
		id: id(4),
		parentId: id(3),
		timestamp: iso(50),
		message: {
			role: "toolResult",
			toolCallId: "call-2",
			toolName: "edit",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 1_700_000_000_050,
		},
	});
	entries.push({
		type: "message",
		id: id(5),
		parentId: id(4),
		timestamp: iso(60),
		message: {
			role: "assistant",
			content: [{ type: "text", text: isRef ? "The check still fails; diagnosing." : "All checks pass." }],
			api: "fake",
			provider: "fake",
			model: "fake-solver",
			usage: {
				input: 480,
				output: 60,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 540,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost / 2 },
			},
			stopReason: "stop",
			timestamp: 1_700_000_000_060,
		},
	});

	return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

export interface FakeEditorContext {
	stage: FakeStage;
	/** 0 = first attempt, 1 = retry after verbatim validator feedback. */
	attempt: number;
	domain: string;
	skillName: string;
	/** Current surface's always-on file (the fake extends it, never replaces it). */
	baseAgents: string;
	scenario: "valid" | "invalid-first" | "always-invalid";
	/** Verbatim validator error carried into the retry mission. */
	validationError?: string;
}

const INV_SECTION = (domain: string): string =>
	[
		`## ${domain} procedure`,
		`1. Read the whole file before editing it; re-read it after every edit.`,
		`2. Run the verifier command and report its exit code verbatim in the summary.`,
		`3. On the first failing check, stop and diagnose — never mask or delete a failing check.`,
		`4. Keep the diff minimal: one behavioural change per file.`,
		"",
	].join("\n");

const SKILL_BODY = (domain: string): string =>
	[
		`# ${domain} notes`,
		``,
		`- Re-read files after editing; stale reads are the most common rework.`,
		`- Run the verifier before declaring done and paste the exact output.`,
		`- Prefer the smallest change that makes the check pass.`,
		`- When two tools produce the same output twice, stop and think instead of repeating.`,
		``,
		`Helper: \`scripts/check.sh\` runs the verifier and prints its exit code.`,
		"",
	].join("\n");

const SKILL_SCRIPT = (domain: string): string =>
	`#!/usr/bin/env bash\n# ${domain} verifier helper shipped with the skill\nset -euo pipefail\n${'echo "run your verifier here"'}\n`;

export function skillNameFor(domain: string): string {
	return `${domain}-notes`;
}

function skillFile(domain: string): string {
	const name = skillNameFor(domain);
	return [
		"---",
		`name: ${name}`,
		`description: Practitioner notes for ${domain} work. Use when a task touches ${domain} code, checks or reviews.`,
		"---",
		SKILL_BODY(domain),
	].join("\n");
}

/** Deterministic editor reply for the fake loop. */
export function fakeEditorReply(ctx: FakeEditorContext): string {
	if (ctx.stage === "reflect") {
		return [
			"<experience>",
			`{"cue": "${ctx.domain} checks failing after an edit",`,
			`"lesson": "re-read the edited file and run the verifier before the next edit",`,
			`"evidence": "reference runs repeated identical greps after an edit and never re-read the file",`,
			`"confidence": "medium"}`,
			"</experience>",
			"<notes>reflection written from digest evidence only</notes>",
		].join("\n");
	}

	if (ctx.stage === "select") {
		return ["```choice", "c0", "```", "<why>anonymized deliverable c0 showed the fewest failing checks</why>"].join(
			"\n",
		);
	}

	const agents = ctx.baseAgents.endsWith("\n") ? ctx.baseAgents : `${ctx.baseAgents}\n`;

	// invalid-first / always-invalid: the delta trips the path whitelist.
	// (`select` and `reflect` already returned above — they have no delta.)
	if (ctx.scenario === "always-invalid" || (ctx.scenario === "invalid-first" && ctx.attempt === 0)) {
		return replyWithEdits("proposing a file outside the surface (should be rejected)", [
			{ path: "../escape.md", op: "write", content: "not allowed" },
		]);
	}

	if (ctx.stage === "propose-inv") {
		return replyWithEdits("added a four-step procedure to the always-on file", [
			{ path: "AGENTS.md", op: "write", content: `${agents}\n${INV_SECTION(ctx.domain)}` },
		]);
	}

	if (ctx.stage === "propose-dom") {
		const withTrigger = `${agents}- Skill trigger: ${ctx.skillName} — load for ${ctx.domain} tasks (notes, checklists).\n`;
		return replyWithEdits("shipped a domain skill and named it in the always-on file", [
			{ path: "AGENTS.md", op: "write", content: withTrigger },
			{ path: `.pi/skills/${ctx.skillName}/SKILL.md`, op: "write", content: skillFile(ctx.domain) },
			{ path: `.pi/skills/${ctx.skillName}/scripts/check.sh`, op: "write", content: SKILL_SCRIPT(ctx.domain) },
		]);
	}

	// compose: merge both levers (procedure + skill), still under the always-on cap.
	const merged = `${agents}\n${INV_SECTION(ctx.domain)}- Skill trigger: ${ctx.skillName} — load for ${ctx.domain} tasks (notes, checklists).\n`;
	return replyWithEdits("composed the procedure and the domain skill", [
		{ path: "AGENTS.md", op: "write", content: merged },
		{ path: `.pi/skills/${ctx.skillName}/SKILL.md`, op: "write", content: skillFile(ctx.domain) },
		{ path: `.pi/skills/${ctx.skillName}/scripts/check.sh`, op: "write", content: SKILL_SCRIPT(ctx.domain) },
	]);
}

interface FakeFileChange {
	path: string;
	op: "write" | "delete";
	content?: string;
}

function replyWithEdits(notes: string, files: FakeFileChange[]): string {
	return [`<notes>${notes}</notes>`, "```json", JSON.stringify({ files }, null, "\t"), "```"].join("\n");
}
