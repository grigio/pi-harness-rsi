/**
 * Editor job runners (PLAN-rsi.md §6.1, §7.3): propose (INV/DOM), compose,
 * select, reflect.
 *
 * The editor is answer-only: it runs with read-only tools in the run directory
 * (never in a solver sandbox) and replies with fixed tags — `<notes>`, `<edits>`,
 * `<experience>`, ```choice. Missions are templates with slots assembled through
 * `context.assemble()`, so every stage carries a declared char budget.
 *
 * Anti-Goodhart (P5): missions never contain a rubric, a score or a judge
 * verdict. Verifier output arrives as *behavioural evidence* inside digests.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RsiConfig } from "./config";
import { assemble, budgetFor, capNotes, type AssembledMission, type MissionPart } from "./context";
import { fakeEditorReply, type FakeEditorContext, type FakeStage } from "./fake";
import { findSessionFile, spawnPi, buildChildArgs } from "./probe";
import { renderFileMap, summarizeDiff, type Surface, type SurfaceDelta, type SurfaceDiff } from "./surface";
import { extractTag, readTextIf, stripFence, writeText } from "./util";

export type EditorStage = "propose-inv" | "propose-dom" | "compose" | "select" | "reflect";

export interface EditorRun {
	ok: boolean;
	reply: string;
	usd: number;
	wallMs: number;
	error?: string;
	/** Assembled mission (already budget-checked) — kept for characterization. */
	mission: AssembledMission;
	missionPath: string;
}

/** Fixed instructions appended to every editor mission. */
export function replyRules(stage: EditorStage, cfg: RsiConfig): string {
	const notes = cfg.budgets.notes;
	if (stage === "select") {
		return [
			"Reply format (exact):",
			"- a fenced block ```choice containing exactly one candidate id (e.g. c0),",
			`- then <why>…</why> with at most ${notes} characters.`,
			"Rules: judge the deliverables, never a rubric; do not mention scores, graders or judges.",
		].join("\n");
	}
	if (stage === "reflect") {
		return [
			"Reply format (exact):",
			"- <experience> containing one JSON object with keys cue, lesson, evidence, confidence,",
			`- then <notes>…</notes> with at most ${notes} characters.`,
			"Rules: write nothing speculative — evidence must come from the digests or the diff on disk.",
			"If the evidence does not support a transferable lesson, reply with <experience>none</experience>.",
		].join("\n");
	}
	return [
		"Reply format (exact):",
		`- <notes>…</notes> with at most ${notes} characters (decision rationale),`,
		"- then one fenced ```json block containing {\"files\": [ {\"path\": …, \"op\": \"write\"|\"delete\", \"content\": …} ]}.",
		"Rules:",
		"- Emit only changed files (omitted-is-inherited): the applied surface is current ⊕ your delta.",
		"- Paths must be inside the surface: AGENTS.md, .pi/prompts/<name>.md, .pi/skills/<name>/SKILL.md, .pi/skills/<name>/scripts/**.",
		"- Read evidence files with grep/read; do not answer from this message alone.",
		"- Do not mention rubrics, graders, scores or judges; change behaviour, not graders.",
	].join("\n");
}

/**
 * Lever prompt from the packaged skill files (PLAN-rsi.md §12). The skills are
 * deliberately *not* declared in the package manifest, so pi never advertises
 * them in the user's system prompt — they cost context only inside a mission.
 */
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

export function leverInstructions(stage: EditorStage): string {
	const header = stage === "propose-inv" ? "INV" : stage === "propose-dom" ? "DOM" : stage.toUpperCase();
	const file = stage === "reflect" ? "harness-reflect/SKILL.md" : "harness-editor/SKILL.md";
	const text = readTextIf(join(SKILLS_DIR, file));
	if (text) {
		const section = extractSection(text, `## ${header}`);
		if (section) return section;
	}
	return fallbackLever(header);
}

function extractSection(text: string, header: string): string | undefined {
	const start = text.indexOf(header);
	if (start === -1) return undefined;
	const rest = text.slice(start + header.length);
	const next = rest.search(/\n## /);
	const body = next === -1 ? rest : rest.slice(0, next);
	const trimmed = body.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function fallbackLever(header: string): string {
	const levers: Record<string, string> = {
		INV: "Edit procedure only (AGENTS.md): ordered, imperative steps that would have prevented the observed failures.",
		DOM: "Edit practitioner knowledge only (a .pi/skills/<name>/ skill) and name it in AGENTS.md.",
		COMPOSE: "Merge the contrastive digests: keep what the evidence supports, drop unmotivated advice, do not duplicate rules.",
		SELECT: "Pick the deliverable that best satisfies the task; names and identities are withheld.",
		REFLECT: "Write cue/lesson/evidence/confidence from disk evidence, or reply <experience>none</experience>.",
	};
	return levers[header] ?? "Follow the reply format exactly.";
}

export interface MissionInputs {
	task: string;
	domain: string;
	/** Current surface snapshot (the base for omitted-is-inherited). */
	surface: Surface;
	/** Relative pointers to evidence files that exist on disk. */
	evidence: string[];
	/** Digest texts (already capped at the digest budget). */
	digests: string[];
	/** Library index text, when entries exist (optional part). */
	libraryIndex?: string;
	/** Library lesson bodies, ≤3 (optional part). */
	libraryLessons?: string[];
	/** Carried notes from earlier stages (sequential mode). */
	carry?: string;
}

/** Propose mission parts — assembled under the `propose` budget by the caller. */
export function proposeParts(stage: EditorStage, inputs: MissionInputs, cfg: RsiConfig): MissionPart[] {
	const lever = stage === "propose-inv" ? "INV (procedure)" : "DOM (practitioner knowledge)";
	const parts: MissionPart[] = [
		{
			name: "task",
			text: `${inputs.task}\n\ndomain: ${inputs.domain}   lever: ${lever}`,
		},
		{ name: "lever instructions", text: leverInstructions(stage) },
		{
			name: "reply rules",
			text: replyRules(stage, cfg),
		},
		{
			name: "current surface file map",
			text: renderFileMap(inputs.surface).join("\n"),
		},
		{
			name: "current AGENTS.md (verbatim, this is the file you edit)",
			text: inputs.surface["AGENTS.md"] ?? "(missing)",
		},
		{
			name: "evidence file map",
			text: inputs.evidence.length > 0 ? inputs.evidence.join("\n") : "(none)",
		},
	];
	if (inputs.digests.length > 0) {
		parts.push({ name: "reference digests", text: inputs.digests.join("\n\n") });
	}
	if (inputs.carry) parts.push({ name: "carried notes", text: inputs.carry });
	if (inputs.libraryIndex) {
		parts.push({ name: "library index", text: inputs.libraryIndex, optional: true });
	}
	if (inputs.libraryLessons && inputs.libraryLessons.length > 0) {
		parts.push({ name: "library lessons", text: joinLessons(inputs.libraryLessons), optional: true });
	}
	return parts;
}

export interface ComposeInputs extends MissionInputs {
	/** `ref0 digest | candidate digest | candidate diff summary` triples. */
	contrast: string[];
	/** Verbatim `<notes>` from the propose stage (no answers, only rationale). */
	decisionNotes: string[];
}

export function composeParts(inputs: ComposeInputs, cfg: RsiConfig): MissionPart[] {
	const parts: MissionPart[] = [
		{ name: "task", text: `${inputs.task}\n\ndomain: ${inputs.domain}   lever: COMPOSE` },
		{ name: "lever instructions", text: leverInstructions("compose") },
		{ name: "reply rules", text: replyRules("compose", cfg) },
		{ name: "current surface file map", text: renderFileMap(inputs.surface).join("\n") },
		{ name: "current AGENTS.md (verbatim)", text: inputs.surface["AGENTS.md"] ?? "(missing)" },
		{ name: "contrastive digests (reference vs candidates)", text: inputs.contrast.join("\n\n") },
		{ name: "candidate diffs", text: inputs.evidence.join("\n") },
	];
	if (inputs.decisionNotes.length > 0) {
		parts.push({ name: "decision notes", text: inputs.decisionNotes.join("\n") });
	}
	if (inputs.carry) parts.push({ name: "carried notes", text: inputs.carry, optional: true });
	if (inputs.libraryIndex) parts.push({ name: "library index", text: inputs.libraryIndex, optional: true });
	if (inputs.libraryLessons && inputs.libraryLessons.length > 0) {
		parts.push({ name: "library lessons", text: joinLessons(inputs.libraryLessons), optional: true });
	}
	return parts;
}

export interface ReflectInputs {
	task: string;
	domain: string;
	/** Diff summary of base vs adopted surface. */
	diffSummary: string;
	/** Compose `<notes>` from the run. */
	composeNotes: string[];
	/** Ledger/counters context (small). */
	record: string;
}

export function reflectParts(inputs: ReflectInputs, cfg: RsiConfig): MissionPart[] {
	return [
		{ name: "task", text: `${inputs.task}\n\ndomain: ${inputs.domain}   lever: REFLECT` },
		{ name: "lever instructions", text: leverInstructions("reflect") },
		{ name: "reply rules", text: replyRules("reflect", cfg) },
		{ name: "adoption record", text: inputs.record },
		{ name: "base vs adopted diff", text: inputs.diffSummary },
		{ name: "compose notes", text: inputs.composeNotes.length > 0 ? inputs.composeNotes.join("\n") : "(none)" },
	];
}

export interface SelectInputs {
	task: string;
	/** `c0 → <excerpt>` blocks, each already capped at the excerpt budget. */
	candidates: string[];
}

export function selectParts(inputs: SelectInputs, cfg: RsiConfig): MissionPart[] {
	return [
		{ name: "task", text: inputs.task },
		{ name: "lever instructions", text: leverInstructions("select") },
		{ name: "reply rules", text: replyRules("select", cfg) },
		{ name: "anonymized candidates", text: inputs.candidates.join("\n\n") },
	];
}

function joinLessons(lessons: readonly string[]): string {
	return lessons.join("\n\n");
}

/** Assemble + persist a mission (characterization artifacts live in `missions/`). */
export function buildMission(
	stage: EditorStage,
	missionStage: "propose" | "compose" | "reflect" | "select",
	parts: MissionPart[],
	cfg: RsiConfig,
	runDir: string,
	label: string,
): { mission: AssembledMission; path: string } {
	const mission = assemble(missionStage, parts, cfg.budgets);
	const path = join(runDir, "missions", `${missionStage}-${label}.md`);
	writeText(path, mission.text);
	return { mission, path };
}

// ---------------------------------------------------------------------------
// Reply parsing — every failure message is verbatim retry feedback (P3)
// ---------------------------------------------------------------------------

export interface ParsedEdits {
	notes: string;
	delta: SurfaceDelta;
}

export class ReplyParseError extends Error {}

export function parseEdits(reply: string, cfg: RsiConfig): ParsedEdits {
	const raw = extractTag(reply, "edits");
	const jsonPayload = raw ?? fencedJson(reply);
	if (!jsonPayload) {
		throw new ReplyParseError(
			`no <edits>…</edits> block and no fenced \`\`\`json object found in the reply — reply with <notes>…</notes> followed by a \`\`\`json block containing {"files": [...]}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFence(jsonPayload));
	} catch (err) {
		throw new ReplyParseError(`edits block is not valid JSON: ${(err as Error).message} — reply with a single {"files": [...]} object`);
	}
	const obj = parsed as { files?: unknown; notes?: unknown };
	if (!obj || !Array.isArray(obj.files)) {
		throw new ReplyParseError(`edits JSON must be an object with a "files" array — got ${JSON.stringify(parsed).slice(0, 200)}`);
	}
	const files: SurfaceDelta["files"] = [];
	for (const entry of obj.files) {
		const e = entry as { path?: unknown; op?: unknown; content?: unknown };
		if (typeof e?.path !== "string" || (e.op !== "write" && e.op !== "delete")) {
			throw new ReplyParseError(`invalid file entry ${JSON.stringify(entry).slice(0, 160)} — each entry needs {"path": string, "op": "write"|"delete", "content"?: string}`);
		}
		if (e.op === "write" && typeof e.content !== "string") {
			throw new ReplyParseError(`file entry "${e.path}" has op "write" without string content`);
		}
		files.push({ path: e.path, op: e.op, ...(e.op === "write" ? { content: e.content as string } : {}) });
	}
	const notes = capNotes(typeof obj.notes === "string" ? obj.notes : extractTag(reply, "notes") ?? "", cfg.budgets);
	return { notes, delta: { files, notes } };
}

function fencedJson(reply: string): string | undefined {
	const m = reply.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
	return m ? m[1] : undefined;
}

export interface ParsedExperience {
	cue: string;
	lesson: string;
	evidence: string;
	confidence: string;
}

/** `none` (or anything unparsable-but-explicit) means "no reflection written". */
export function parseExperience(reply: string): ParsedExperience | undefined {
	const raw = extractTag(reply, "experience");
	if (!raw || raw.toLowerCase() === "none") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFence(raw));
	} catch {
		// Tolerate the pretty-printed multi-line fake: try to join key/value lines.
		parsed = parseLooseExperience(raw);
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const obj = parsed as Record<string, unknown>;
	const str = (k: string): string => (typeof obj[k] === "string" ? (obj[k] as string).trim() : "");
	const result = { cue: str("cue"), lesson: str("lesson"), evidence: str("evidence"), confidence: str("confidence") };
	if (!result.cue || !result.lesson || !result.evidence) return undefined;
	return result;
}

/** The fake editor emits `{"cue": "…",` across lines — recover it deterministically. */
function parseLooseExperience(raw: string): unknown {
	const compact = raw.replace(/\s*\n\s*/g, "").replace(/,(\s*[}\]])/g, "$1");
	try {
		return JSON.parse(compact);
	} catch {
		return undefined;
	}
}

export function parseChoice(reply: string, pool: readonly string[]): string {
	const fence = reply.match(/```(?:choice)?\s*\n([\s\S]*?)\n```/);
	const candidate = (fence?.[1] ?? reply).trim().split(/\s+/)[0] ?? "";
	if (pool.includes(candidate)) return candidate;
	throw new ReplyParseError(
		`\`\`\`choice must contain exactly one of ${pool.join(", ")} — got "${candidate.slice(0, 40)}"`,
	);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface RunEditorOptions {
	stage: EditorStage;
	mission: AssembledMission;
	missionPath: string;
	runDir: string;
	cfg: RsiConfig;
	/** Attempt number (0-based); drives the deterministic fake. */
	attempt: number;
	fake: Omit<FakeEditorContext, "attempt" | "scenario" | "validationError">;
	signal?: AbortSignal;
}

/** One editor attempt: fake reply, or a read-only child `pi` session. */
export async function runEditor(opts: RunEditorOptions): Promise<EditorRun> {
	const { cfg, runDir, mission } = opts;

	if (cfg.fake) {
		const reply = fakeEditorReply({
			...opts.fake,
			stage: opts.stage as FakeStage,
			attempt: opts.attempt,
			scenario: cfg.fakeScenario,
		});
		return { ok: true, reply, usd: 0, wallMs: 1, mission, missionPath: opts.missionPath };
	}

	const sessionDir = join(runDir, "sessions", `editor-${opts.stage}-${opts.attempt}`);
	const args = buildChildArgs({
		sessionDir,
		prompt: mission.text,
		tools: cfg.editorTools,
		model: cfg.editorModel ?? cfg.solverModel,
		thinking: cfg.thinking,
		editor: true,
	});
	const run = await spawnPi(args, { cwd: runDir, cfg, signal: opts.signal });
	const sessionFile = findSessionFile(sessionDir);
	const jsonl = sessionFile ? readTextIf(sessionFile) ?? "" : "";
	const reply = finalAssistantText(jsonl);

	if (run.code !== 0 && reply.length === 0) {
		return {
			ok: false,
			reply: "",
			usd: 0,
			wallMs: run.wallMs,
			error: run.error ?? run.stderr.slice(-400) ?? `editor child exited ${run.code}`,
			mission,
			missionPath: opts.missionPath,
		};
	}
	return { ok: true, reply, usd: usdOfSession(jsonl), wallMs: run.wallMs, mission, missionPath: opts.missionPath };
}

function usdOfSession(jsonl: string): number {
	let total = 0;
	for (const line of jsonl.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const entry = JSON.parse(line) as { type: string; message?: { usage?: { cost?: { total?: number } } }; usage?: { cost?: { total?: number } } };
			const cost = entry.message?.usage?.cost?.total ?? (entry.type === "usage" ? entry.usage?.cost?.total : undefined);
			if (typeof cost === "number") total += cost;
		} catch {
			// ignore malformed lines
		}
	}
	return total;
}

/** Last assistant text block — the editor's answer. */
export function finalAssistantText(jsonl: string): string {
	let last = "";
	for (const line of jsonl.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const entry = JSON.parse(line) as {
				type: string;
				message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> };
			};
			if (entry.type !== "message" || !entry.message || entry.message.role !== "assistant") continue;
			const content = entry.message.content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.filter((b) => b?.type === "text" && typeof b.text === "string")
								.map((b) => b.text as string)
								.join("\n")
						: "";
			if (text.trim().length > 0) last = text;
		} catch {
			// ignore
		}
	}
	return last;
}

export { budgetFor, summarizeDiff };
export type { SurfaceDiff };
