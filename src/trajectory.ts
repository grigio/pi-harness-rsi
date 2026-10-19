/**
 * Session JSONL → fixed-shape, capped digest (the trajectory artifact of “Context budgets”).
 *
 * Only digests enter missions. Full JSONL and deliverables stay on disk and the
 * mission carries a file map; the editor is told to grep, not to answer from the
 * message. That is the single largest context lever for small models.
 *
 * The digest is a *budgeted* artifact: `cap` is a hard limit enforced here, and
 * sections are dropped lowest-priority-first instead of being sliced mid-line.
 */

import { charLen, hash12, truncateEnd, truncateMiddle } from "./util";

export interface SessionMessage {
	role: string;
	content?: string | ContentBlock[];
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	usage?: { cost?: { total?: number }; totalTokens?: number };
	model?: string;
}

export interface ContentBlock {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

export interface SessionEntry {
	type: string;
	message?: SessionMessage;
	usage?: { cost?: { total?: number }; totalTokens?: number };
}

export interface SessionSummary {
	models: string[];
	/** Ordered tool executions — the digest's timeline (calls paired with their results). */
	steps: Array<{ tool: string; isError: boolean; brief: string; call?: string; exit?: number }>;
	turns: number;
	usd: number;
	totalTokens: number;
}

/** Concatenated `text` blocks of a message (string content is returned as-is). */
function textOf(message: SessionMessage | undefined): string {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
}

/** `toolCall` blocks of an assistant message, normalized for pairing. */
function toolCallsOf(
	message: SessionMessage | undefined,
): Array<{ id?: string; toolName: string; call: string; brief: string }> {
	const content = message?.content;
	if (!Array.isArray(content)) return [];
	return content
		.filter((b) => b && b.type === "toolCall" && typeof b.name === "string")
		.map((b) => ({
			id: b.id,
			toolName: b.name as string,
			// Rework identity: the payload counts for edit/write (see callIdentity).
			call: callIdentity(b.name as string, b.arguments),
			// Human-readable window for the digest: never a JSON blob.
			brief: briefOf(b.arguments),
		}));
}

/**
 * Parse a child pi session JSONL into the shape digests and ledgers need.
 * Assistant `toolCall` blocks are paired with their `toolResult` entries by id,
 * so `steps` counts executions once (a call without a result — aborted run —
 * is still recorded, which is exactly the signal `first_divergence` wants).
 */
export function summarizeSession(jsonl: string): SessionSummary {
	const models = new Set<string>();
	const steps: SessionSummary["steps"] = [];
	const pending = new Map<string, { tool: string; call: string; brief: string }>();
	let turns = 0;
	let usd = 0;
	let totalTokens = 0;

	for (const line of jsonl.split("\n")) {
		if (line.trim().length === 0) continue;
		let entry: SessionEntry;
		try {
			entry = JSON.parse(line) as SessionEntry;
		} catch {
			continue;
		}
		if (entry.type === "usage" && entry.usage) {
			if (typeof entry.usage.cost?.total === "number") usd += entry.usage.cost.total;
			if (typeof entry.usage.totalTokens === "number") totalTokens += entry.usage.totalTokens;
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const m = entry.message;
		if (typeof m.usage?.cost?.total === "number") usd += m.usage.cost.total;
		if (typeof m.usage?.totalTokens === "number") totalTokens += m.usage.totalTokens;

		if (m.role === "assistant") {
			turns++;
			if (typeof m.model === "string" && m.model.length > 0) models.add(m.model);
			for (const call of toolCallsOf(m)) {
				if (call.id) pending.set(call.id, { tool: call.toolName, call: call.call, brief: call.brief });
			}
			continue;
		}

		if (m.role === "toolResult") {
			const id = m.toolCallId ?? "";
			const awaited = pending.get(id);
			if (id) pending.delete(id);
			const raw = textOf(m);
			const exit = matchExit(raw);
			steps.push({
				tool: m.toolName ?? awaited?.tool ?? "unknown",
				call: awaited?.call ?? "",
				isError: m.isError === true || (exit !== undefined && exit !== 0),
				// The call's arguments are the useful window when the result is noise.
				brief: raw.trim().length > 0 ? raw : (awaited?.brief ?? ""),
				exit,
			});
		}
	}

	// Aborted calls (no result) still belong to the timeline.
	for (const orphan of pending.values()) {
		steps.push({
			tool: orphan.tool,
			call: orphan.call,
			isError: true,
			brief: "<no result: run ended before this call returned>",
		});
	}

	return { models: [...models], steps, turns, usd, totalTokens };
}

function matchExit(text: string): number | undefined {
	const m = text.match(/(?:exit(?: code)?|returned)\s*[:=]?\s*(-?\d+)/i);
	if (!m) return undefined;
	const n = Number(m[1]);
	return Number.isFinite(n) ? n : undefined;
}

export interface DigestInput {
	label: string;
	sessionJsonl: string;
	/** Wall-clock of the child process, seconds (optional). */
	wallSeconds?: number;
	/** `verifier: …` evidence line — behavioural evidence, never a score. */
	verifier?: string;
	/** `git-diff: …` stat line, when the sandbox is a git worktree. */
	diffStat?: string;
	/** Relative deliverable paths touched by the run. */
	deliverables?: string[];
	/** Hard cap (profile budget). */
	cap: number;
	/** Trailing hint the mission relies on (file map pointer). */
	pointer?: string;
}

export interface DigestResult {
	text: string;
	/** True when sections were dropped to satisfy `cap`. */
	capped: boolean;
	dropped: string[];
}

/**
 * Build a fixed-shape digest:
 *
 * ```
 * # digest: ref0 (model=x, 214s, turns=18)
 * tools: bash×9 (2 err) edit×3 read×6
 * errors:
 *   1. bash @step=3 exit=1  window: "FAIL …"
 * deliverable: src/foo.ts | git-diff: +41 −12
 * verifier: tsc exit=0; npm test exit=1
 * first_divergence: @step=3 hypothesis: bash failed first
 * rework: 3 consecutive identical grep calls
 * ```
 */
export function digest(input: DigestInput): DigestResult {
	const summary = summarizeSession(input.sessionJsonl);
	const cap = input.cap;
	const dropped: string[] = [];

	const model = summary.models[0] ?? "unknown";
	const wall = input.wallSeconds !== undefined ? `${Math.round(input.wallSeconds)}s` : "n/a";
	const header = `# digest: ${input.label} (model=${model}, ${wall}, turns=${summary.turns})`;

	// tools line
	const counts = new Map<string, { total: number; errors: number }>();
	for (const step of summary.steps) {
		const cur = counts.get(step.tool) ?? { total: 0, errors: 0 };
		cur.total++;
		if (step.isError) cur.errors++;
		counts.set(step.tool, cur);
	}
	const toolsLine =
		"tools: " +
		([...counts.entries()]
			.sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
			.map(([tool, c]) => `${tool}×${c.total}${c.errors > 0 ? ` (${c.errors} err)` : ""}`)
			.join(" ") || "none");

	// errors section (max 3, each with a bounded window)
	const errorSteps = summary.steps.map((s, i) => ({ ...s, index: i })).filter((s) => s.isError);
	const errorsLines = ["errors:"];
	if (errorSteps.length === 0) {
		errorsLines.push("  none");
	} else {
		for (const [n, step] of errorSteps.slice(0, 3).entries()) {
			const window = truncateMiddle(step.brief.replace(/\s+/g, " ").trim(), 160);
			const why = step.exit !== undefined && step.exit !== 0 ? `exit=${step.exit}` : "isError";
			errorsLines.push(`  ${n + 1}. ${step.tool} ${why} @step=${step.index}  window: "${window}"`);
		}
		if (errorSteps.length > 3) errorsLines.push(`  … ${errorSteps.length - 3} more in the session file`);
	}

	// first divergence: first error, else first repeated no-op, else none
	let divergence = "first_divergence: none";
	if (errorSteps.length > 0) {
		const firstError = errorSteps[0] as (typeof errorSteps)[number];
		divergence = `first_divergence: @step=${firstError.index} hypothesis: ${firstError.tool} failed first — the rest of the run reacts to it`;
	} else {
		const repeat = longestDuplicateRun(summary.steps);
		if (repeat) {
			divergence = `first_divergence: @step=${repeat.start} hypothesis: repeated ${repeat.tool} call without new information`;
		}
	}

	// rework
	const dup = longestDuplicateRun(summary.steps);
	const rework =
		dup && dup.length >= 2 ? `rework: ${dup.length} consecutive identical ${dup.tool} calls` : "rework: none";

	// deliverable + verifier (evidence, not score)
	const deliverable =
		input.deliverables && input.deliverables.length > 0
			? `deliverable: ${input.deliverables.slice(0, 6).join(", ")}${input.deliverables.length > 6 ? ` (+${input.deliverables.length - 6})` : ""}` +
				(input.diffStat ? ` | git-diff: ${input.diffStat}` : "")
			: input.diffStat
				? `deliverable: git-diff: ${input.diffStat}`
				: "deliverable: none recorded";
	const verifier = input.verifier
		? `verifier: ${truncateMiddle(input.verifier.replace(/\s+/g, " ").trim(), 400)}`
		: undefined;
	const pointer = input.pointer ? `full session: ${input.pointer}` : undefined;

	// Priority order: header, tools, errors, deliverable, verifier, divergence, rework, pointer.
	const sections: Array<{ name: string; lines: string[] }> = [
		{ name: "tools", lines: [toolsLine] },
		{ name: "errors", lines: errorsLines },
		{ name: "deliverable", lines: [deliverable] },
		...(verifier ? [{ name: "verifier", lines: [verifier] }] : []),
		{ name: "first_divergence", lines: [divergence] },
		{ name: "rework", lines: [rework] },
		...(pointer ? [{ name: "pointer", lines: [pointer] }] : []),
	];

	let text = header;
	let capped = false;
	for (const section of sections) {
		const chunk = section.lines.join("\n");
		const candidate = `${text}\n${chunk}`;
		if (charLen(candidate) <= cap) {
			text = candidate;
		} else {
			capped = true;
			dropped.push(section.name);
			// keep a pointer that the section exists in the session file
			const stub = `…[${section.name} dropped: over ${cap}-char digest budget]`;
			if (charLen(`${text}\n${stub}`) <= cap) text = `${text}\n${stub}`;
			else {
				capped = true;
				break;
			}
		}
	}

	if (charLen(text) > cap) {
		text = truncateEnd(text, cap, "…[digest capped]");
		capped = true;
	}

	return { text, capped, dropped };
}

interface DuplicateRun {
	tool: string;
	length: number;
	start: number;
}

/** Longest run of consecutive identical tool calls (same tool + same arguments). */
function longestDuplicateRun(steps: SessionSummary["steps"]): DuplicateRun | undefined {
	let best: DuplicateRun | undefined;
	let runStart = 0;
	const key = (s: SessionSummary["steps"][number]): string => `${s.tool}\u0000${s.call || normalize(s.brief)}`;
	for (let i = 1; i <= steps.length; i++) {
		const prev = steps[i - 1];
		const cur = steps[i];
		const hasKey = (s: SessionSummary["steps"][number] | undefined): boolean =>
			s !== undefined && (s.call?.length ?? 0) > 0;
		const same =
			cur !== undefined && hasKey(prev) && hasKey(cur) && key(prev as SessionSummary["steps"][number]) === key(cur);
		if (same) continue;
		const length = i - runStart;
		if (length >= 2 && (!best || length > best.length)) {
			best = { tool: (steps[runStart] as SessionSummary["steps"][number]).tool, length, start: runStart };
		}
		runStart = i;
	}
	return best;
}

function normalize(s: string): string {
	return s.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Sum of provider-reported cost in a session (USD accounting for the ledger). */
export function sessionUsd(jsonl: string): number {
	return summarizeSession(jsonl).usd;
}

/** Tool call paths a run wrote/edited — used to harvest deliverables for selection. */
export function writtenPaths(jsonl: string, allowedPrefixes: readonly string[] = []): string[] {
	const paths = new Set<string>();
	for (const line of jsonl.split("\n")) {
		if (line.trim().length === 0) continue;
		let entry: SessionEntry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type !== "toolCall") continue;
			if (block.name !== "write" && block.name !== "edit") continue;
			const args = (block.arguments ?? {}) as { path?: string; file_path?: string };
			const path = args.path ?? args.file_path;
			if (typeof path !== "string" || path.length === 0) continue;
			if (allowedPrefixes.length > 0 && !allowedPrefixes.some((p) => path.includes(p))) continue;
			paths.add(path);
		}
	}
	return [...paths].sort();
}

/** Short stable description of tool arguments (digest "brief" for calls without results). */
function briefOf(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const key = typeof a.command === "string" ? a.command : typeof a.path === "string" ? a.path : JSON.stringify(a);
	return String(key).slice(0, 200);
}

/**
 * Identity of a tool call for rework detection.
 *
 * Keying `edit` on `arguments.path` alone made three *different* edits to the
 * same file look like "3 consecutive identical edit calls" — a fabricated
 * rework signal, and the digest is exactly the artifact the loop optimizes
 * against. For edit/write the payload is part of the identity; reads keep
 * path-only identity (re-reading one path really is the rework pattern).
 */
function callIdentity(tool: string, args: unknown): string {
	if (!args || typeof args !== "object") return briefOf(args);
	const a = args as Record<string, unknown>;
	const path = typeof a.path === "string" ? a.path : "";
	if (tool === "edit") {
		const edits = a.edits ?? a.oldString ?? a.newString ?? "";
		return `${path}\u0000${stableStringify(edits)}`;
	}
	if (tool === "write") return `${path}\u0000${hash12(typeof a.content === "string" ? a.content : "")}`;
	return briefOf(args);
}

/** JSON with sorted keys, so argument order cannot change an identity. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
