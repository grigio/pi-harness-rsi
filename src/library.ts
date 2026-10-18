/**
 * Harnessing-level library (PLAN-rsi.md §8): per-domain entries holding the
 * adopted surface snapshot, a validated `EXPERIENCE.md` lesson and a generated
 * `INDEX.md`.
 *
 * Retrieval by construction: a domain directory only ever holds same-domain
 * entries — no vector store, no retrieval model (small-model-safe).
 * Reflection writes *nothing* when evidence is insufficient.
 */

import { join } from "node:path";
import type { RsiConfig } from "./config";
import { charLen, exists, listFiles, readTextIf, sanitizeSegment, slugify, writeText } from "./util";
import { writeSurface, type Surface } from "./surface";

/** Fixed lesson caps (not profile-dependent — they are small on purpose). */
export const LESSON_CAPS = { cue: 200, lesson: 600, evidence: 400 } as const;

export interface Experience {
	cue: string;
	lesson: string;
	evidence: string;
	confidence: string;
	task?: string;
	adoptedAt?: string;
	label?: string;
}

export interface EntryInfo {
	slug: string;
	cue: string;
	lesson: string;
	adoptedAt?: string;
}

export function libraryRoot(repoRoot: string, cfg: Pick<RsiConfig, "libraryDir">): string {
	return cfg.libraryDir.startsWith("/") ? cfg.libraryDir : join(repoRoot, cfg.libraryDir);
}

export function domainDir(repoRoot: string, cfg: Pick<RsiConfig, "libraryDir">, domain: string): string {
	return join(libraryRoot(repoRoot, cfg), sanitizeSegment(domain));
}

export function entryDir(repoRoot: string, cfg: Pick<RsiConfig, "libraryDir">, domain: string, taskSlug: string): string {
	return join(domainDir(repoRoot, cfg, domain), slugify(taskSlug));
}

// ---------------------------------------------------------------------------
// EXPERIENCE.md
// ---------------------------------------------------------------------------

export interface LessonValidation {
	ok: boolean;
	errors: string[];
	value?: Experience;
}

/** Field-level validation: caps, presence, confidence vocabulary. */
export function validateExperience(exp: Partial<Experience>): LessonValidation {
	const errors: string[] = [];
	const cue = (exp.cue ?? "").trim();
	const lesson = (exp.lesson ?? "").trim();
	const evidence = (exp.evidence ?? "").trim();
	const confidence = (exp.confidence ?? "").trim().toLowerCase() || "medium";

	if (!cue) errors.push("cue is empty — reflection needs a trigger that fires later");
	if (!lesson) errors.push("lesson is empty — nothing to teach the next task");
	if (!evidence) errors.push("evidence is empty — a lesson without evidence is not transferable");
	if (charLen(cue) > LESSON_CAPS.cue) errors.push(`cue is ${charLen(cue)} chars, over ${LESSON_CAPS.cue}`);
	if (charLen(lesson) > LESSON_CAPS.lesson) errors.push(`lesson is ${charLen(lesson)} chars, over ${LESSON_CAPS.lesson}`);
	if (charLen(evidence) > LESSON_CAPS.evidence) errors.push(`evidence is ${charLen(evidence)} chars, over ${LESSON_CAPS.evidence}`);
	if (!["low", "medium", "high"].includes(confidence)) errors.push(`confidence "${confidence}" is not one of low|medium|high`);

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, errors: [], value: { cue, lesson, evidence, confidence } };
}

export function experiencePath(dir: string): string {
	return join(dir, "EXPERIENCE.md");
}

export function writeExperience(dir: string, exp: Experience): void {
	const body = [
		"---",
		`cue: ${oneLine(exp.cue)}`,
		`lesson: ${oneLine(exp.lesson)}`,
		`evidence: ${oneLine(exp.evidence)}`,
		`confidence: ${exp.confidence}`,
		...(exp.task ? [`task: ${oneLine(exp.task)}`] : []),
		...(exp.adoptedAt ? [`adopted: ${exp.adoptedAt}`] : []),
		...(exp.label ? [`label: ${oneLine(exp.label)}`] : []),
		"---",
		"",
		`# ${exp.task ?? "entry"}`,
		"",
		`- **cue:** ${exp.cue}`,
		`- **lesson:** ${exp.lesson}`,
		`- **evidence:** ${exp.evidence}`,
		`- **confidence:** ${exp.confidence}`,
		"",
	].join("\n");
	writeText(experiencePath(dir), body);
}

export function readExperience(dir: string): Experience | undefined {
	const text = readTextIf(experiencePath(dir));
	if (!text) return undefined;
	const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	const fields: Record<string, string> = {};
	for (const line of (fm?.[1] ?? "").split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	if (!fields["cue"] || !fields["lesson"] || !fields["evidence"]) return undefined;
	return {
		cue: fields["cue"],
		lesson: fields["lesson"],
		evidence: fields["evidence"],
		confidence: fields["confidence"] ?? "medium",
		task: fields["task"],
		adoptedAt: fields["adopted"],
		label: fields["label"],
	};
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// INDEX.md
// ---------------------------------------------------------------------------

export function listDomains(repoRoot: string, cfg: Pick<RsiConfig, "libraryDir">): string[] {
	const root = libraryRoot(repoRoot, cfg);
	if (!exists(root)) return [];
	try {
		return listFiles(root)
			.filter((rel) => rel.endsWith("/EXPERIENCE.md") || rel === "EXPERIENCE.md")
			.map((rel) => rel.split("/")[0])
			.filter((d, i, arr) => arr.indexOf(d) === i)
			.sort();
	} catch {
		return [];
	}
}

export function listEntries(repoRoot: string, cfg: Pick<RsiConfig, "libraryDir">, domain: string): EntryInfo[] {
	const dir = domainDir(repoRoot, cfg, domain);
	if (!exists(dir)) return [];
	const out: EntryInfo[] = [];
	let slugs: string[] = [];
	try {
		slugs = listFiles(dir)
			.filter((rel) => rel.endsWith("/EXPERIENCE.md"))
			.map((rel) => rel.split("/")[0]);
	} catch {
		return [];
	}
	for (const slug of slugs) {
		const exp = readExperience(join(dir, slug));
		if (!exp) continue;
		out.push({ slug, cue: exp.cue, lesson: exp.lesson, adoptedAt: exp.adoptedAt });
	}
	return out.sort((a, b) => (a.adoptedAt ?? "").localeCompare(b.adoptedAt ?? ""));
}

/** Regenerate `INDEX.md` from disk (never hand-edited). Returns the text. */
export function regenerateIndex(repoRoot: string, cfg: Pick<RsiConfig, "libraryDir">, domain: string): string {
	const entries = listEntries(repoRoot, cfg, domain);
	const lines = [
		`# ${sanitizeSegment(domain)} library`,
		"",
		`${entries.length} adopted entr${entries.length === 1 ? "y" : "ies"} — regenerate with /rsi-library`,
		"",
		...entries.map((e) => `- **${e.slug}** — ${e.cue} → ${e.lesson}${e.adoptedAt ? ` (${e.adoptedAt})` : ""}`),
		"",
	];
	const text = lines.join("\n");
	writeText(join(domainDir(repoRoot, cfg, domain), "INDEX.md"), text);
	return text;
}

export function readIndex(repoRoot: string, cfg: Pick<RsiConfig, "libraryDir">, domain: string): string | undefined {
	return readTextIf(join(domainDir(repoRoot, cfg, domain), "INDEX.md"));
}

// ---------------------------------------------------------------------------
// Lesson retrieval (top-≤3 by cue overlap, most recent as fallback)
// ---------------------------------------------------------------------------

export function loadLessons(
	repoRoot: string,
	cfg: Pick<RsiConfig, "libraryDir">,
	domain: string,
	task: string,
	max = 3,
): { index?: string; lessons: string[] } {
	const index = readIndex(repoRoot, cfg, domain);
	const entries = listEntries(repoRoot, cfg, domain);
	if (entries.length === 0) return { lessons: [] };

	const tokens = new Set(
		task
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((t) => t.length > 4),
	);
	const scored = entries
		.map((e, i) => {
			const haystack = `${e.cue} ${e.lesson}`.toLowerCase();
			let score = 0;
			for (const token of tokens) if (haystack.includes(token)) score++;
			return { entry: e, score, order: i };
		})
		.sort((a, b) => b.score - a.score || b.order - a.order);

	const picked = scored.filter((s) => s.score > 0).slice(0, max);
	const finalPicks = picked.length > 0 ? picked : scored.slice(0, max);

	const lessons: string[] = [];
	for (const { entry } of finalPicks) {
		const exp = readExperience(join(domainDir(repoRoot, cfg, domain), entry.slug));
		if (exp) lessons.push(renderLesson(entry.slug, exp));
	}
	return { index, lessons };
}

export function renderLesson(slug: string, exp: Experience): string {
	return [
		`### ${slug}`,
		`path: ${slug}/EXPERIENCE.md`,
		`cue: ${exp.cue}`,
		`lesson: ${exp.lesson}`,
		`evidence: ${exp.evidence} (confidence: ${exp.confidence})`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Adoption / revert
// ---------------------------------------------------------------------------

export interface AdoptionResult {
	entryDir: string;
	previousRestored: boolean;
}

/**
 * Snapshot the adopted surface into the library and keep the *previous* live
 * surface as `previous/` so `/rsi-revert` can restore it. Writes nothing until
 * the human adoption gate has passed (P6).
 */
export function adoptSurface(
	repoRoot: string,
	cfg: Pick<RsiConfig, "libraryDir">,
	opts: { domain: string; slug: string; liveBefore: Surface; adopted: Surface },
): AdoptionResult {
	const dir = entryDir(repoRoot, cfg, opts.domain, opts.slug);
	const current = join(dir, "surface");
	const previous = join(dir, "previous");

	// `previous/` is always the live surface from before this adoption —
	// that is what `/rsi-revert` restores.
	writeSurface(previous, opts.liveBefore, { prune: true });
	writeSurface(current, opts.adopted, { prune: true });
	return { entryDir: dir, previousRestored: true };
}

export function surfaceFromDir(dir: string): Surface {
	const surface: Surface = {};
	if (!exists(dir)) return surface;
	for (const rel of listFiles(dir)) {
		const content = readTextIf(join(dir, rel));
		if (content !== undefined) surface[rel] = content;
	}
	return surface;
}

export interface RevertResult {
	ok: boolean;
	domain?: string;
	slug?: string;
	restored: string;
	message: string;
}

/**
 * Restore a previously adopted surface into the live tree.
 * With no slug, the most recently adopted entry in `domain` (or the whole
 * library when `domain` is omitted) is used.
 */
export function revertSurface(
	repoRoot: string,
	cfg: Pick<RsiConfig, "libraryDir">,
	live: Surface,
	opts: { domain?: string; slug?: string },
): RevertResult {
	const domains = opts.domain ? [sanitizeSegment(opts.domain)] : listDomains(repoRoot, cfg);
	for (const domain of [...domains].reverse()) {
		const entries = listEntries(repoRoot, cfg, domain);
		const slugs = opts.slug ? [slugify(opts.slug)] : entries.map((e) => e.slug).reverse();
		for (const slug of slugs) {
			const previousDir = join(entryDir(repoRoot, cfg, domain, slug), "previous");
			const snapshot = surfaceFromDir(previousDir);
			if (Object.keys(snapshot).length === 0) continue;
			writeSurface(repoRoot, snapshot, { prune: true });
			return {
				ok: true,
				domain,
				slug,
				restored: Object.keys(snapshot).sort().join(", "),
				message: `restored previous surface for ${domain}/${slug}`,
			};
		}
	}
	return { ok: false, restored: "", message: "no previous surface snapshot found in the library" };
}

/** Write the loop's EXPERIENCE.md only when validation passes (else write nothing). */
export function writeLessonIfValid(
	repoRoot: string,
	cfg: Pick<RsiConfig, "libraryDir">,
	opts: { domain: string; slug: string; experience: Partial<Experience>; label?: string },
): { written: boolean; errors: string[] } {
	const validation = validateExperience(opts.experience);
	if (!validation.ok || !validation.value) return { written: false, errors: validation.errors };
	const dir = entryDir(repoRoot, cfg, opts.domain, opts.slug);
	writeExperience(dir, {
		...validation.value,
		task: opts.slug,
		adoptedAt: new Date().toISOString().slice(0, 10),
		label: opts.label,
	});
	regenerateIndex(repoRoot, cfg, opts.domain);
	return { written: true, errors: [] };
}
