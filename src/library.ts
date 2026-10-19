/**
 * Harnessing-level library: per-domain entries holding the
 * adopted surface snapshot, a validated `EXPERIENCE.md` lesson and a generated
 * `INDEX.md`.
 *
 * Retrieval by construction: a domain directory only ever holds same-domain
 * entries — no vector store, no retrieval model (small-model-safe).
 * Reflection writes *nothing* when evidence is insufficient.
 */

import { renameSync } from "node:fs";
import { join } from "node:path";
import type { RsiConfig } from "./config";
import { type Surface, writeSurface } from "./surface";
import { charLen, ensureDir, exists, listFiles, readTextIf, sanitizeSegment, slugify, writeText } from "./util";

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
	/** Set when a newer same-cue lesson replaced this one (`by <slug> (<date>)`). */
	superseded?: string;
}

export interface EntryInfo {
	slug: string;
	cue: string;
	lesson: string;
	adoptedAt?: string;
	superseded?: string;
}

export function libraryRoot(repoRoot: string, cfg: Pick<RsiConfig, "libraryDir">): string {
	return cfg.libraryDir.startsWith("/") ? cfg.libraryDir : join(repoRoot, cfg.libraryDir);
}

export function domainDir(repoRoot: string, cfg: Pick<RsiConfig, "libraryDir">, domain: string): string {
	return join(libraryRoot(repoRoot, cfg), sanitizeSegment(domain));
}

export function entryDir(
	repoRoot: string,
	cfg: Pick<RsiConfig, "libraryDir">,
	domain: string,
	taskSlug: string,
): string {
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
	if (charLen(lesson) > LESSON_CAPS.lesson)
		errors.push(`lesson is ${charLen(lesson)} chars, over ${LESSON_CAPS.lesson}`);
	if (charLen(evidence) > LESSON_CAPS.evidence)
		errors.push(`evidence is ${charLen(evidence)} chars, over ${LESSON_CAPS.evidence}`);
	if (!["low", "medium", "high"].includes(confidence))
		errors.push(`confidence "${confidence}" is not one of low|medium|high`);

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
		...(exp.superseded ? [`superseded: ${oneLine(exp.superseded)}`] : []),
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
	if (!fields.cue || !fields.lesson || !fields.evidence) return undefined;
	return {
		cue: fields.cue,
		lesson: fields.lesson,
		evidence: fields.evidence,
		confidence: fields.confidence ?? "medium",
		task: fields.task,
		adoptedAt: fields.adopted,
		label: fields.label,
		superseded: fields.superseded,
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
			.map((rel) => rel.split("/")[0] as string)
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
			.map((rel) => rel.split("/")[0] as string);
	} catch {
		return [];
	}
	for (const slug of slugs) {
		const exp = readExperience(join(dir, slug));
		if (!exp) continue;
		out.push({ slug, cue: exp.cue, lesson: exp.lesson, adoptedAt: exp.adoptedAt, superseded: exp.superseded });
	}
	return out.sort((a, b) => (a.adoptedAt ?? "").localeCompare(b.adoptedAt ?? ""));
}

/** Regenerate `INDEX.md` from disk (never hand-edited). Returns the text. */
export function regenerateIndex(repoRoot: string, cfg: Pick<RsiConfig, "libraryDir">, domain: string): string {
	const entries = listEntries(repoRoot, cfg, domain);
	const lines = [
		`# ${sanitizeSegment(domain)} library`,
		"",
		`${entries.length} adopted entr${entries.length === 1 ? "y" : "ies"} — regenerate with /rsi library`,
		"",
		...entries.map(
			(e) =>
				`- **${e.slug}** — ${e.cue} → ${e.lesson}${e.adoptedAt ? ` (${e.adoptedAt})` : ""}${
					e.superseded ? ` — **superseded** ${e.superseded}` : ""
				}`,
		),
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
	// Superseded lessons are kept on disk for auditability but never served:
	// retrieval must not feed the editor a stale contradiction.
	const entries = listEntries(repoRoot, cfg, domain).filter((e) => !e.superseded);
	if (entries.length === 0) return { index, lessons: [] };

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
	const lines = [
		`### ${slug}`,
		`path: ${slug}/EXPERIENCE.md`,
		`cue: ${exp.cue}`,
		`lesson: ${exp.lesson}`,
		`evidence: ${exp.evidence} (confidence: ${exp.confidence})`,
	];
	// Freshness signal (README “retrieval with staleness”): the editor weighs
	// a dated lesson differently from an undated one. Costs ~14 chars per lesson.
	if (exp.adoptedAt) lines.push(`adopted: ${exp.adoptedAt}`);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Temporal supersession
// ---------------------------------------------------------------------------

/** Cue tokens for overlap scoring (lowercase, >2 chars). */
export function cueTokens(cue: string): Set<string> {
	return new Set(
		cue
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((t) => t.length > 2),
	);
}

/**
 * Mark older same-domain entries whose cue describes the same trigger as the
 * lesson just written ("this fact replaced that one"). Conservative by design:
 * ≥2 shared cue tokens *and* ≥50 % overlap of the smaller cue, never the entry
 * just written, never an already-superseded entry. Marked entries keep their
 * EXPERIENCE.md (auditability) but stop entering missions. The caller owns
 * `regenerateIndex()` afterwards.
 */
export function markSupersededEntries(
	repoRoot: string,
	cfg: Pick<RsiConfig, "libraryDir">,
	opts: { domain: string; slug: string; cue: string },
): string[] {
	const fresh = cueTokens(opts.cue);
	if (fresh.size === 0) return [];
	const marked: string[] = [];
	for (const entry of listEntries(repoRoot, cfg, opts.domain)) {
		if (entry.slug === opts.slug || entry.superseded) continue;
		const old = cueTokens(entry.cue);
		if (old.size === 0) continue;
		const shared = [...fresh].filter((t) => old.has(t)).length;
		if (shared < 2 || shared / Math.min(fresh.size, old.size) < 0.5) continue;
		const dir = join(domainDir(repoRoot, cfg, opts.domain), entry.slug);
		const exp = readExperience(dir);
		if (!exp) continue;
		writeExperience(dir, { ...exp, superseded: `by ${opts.slug} (${new Date().toISOString().slice(0, 10)})` });
		marked.push(entry.slug);
	}
	return marked;
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
 * surface as `previous/` so `/rsi revert` can restore it. Writes nothing until
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

	// Archive the outgoing `previous/` before it is overwritten: without this
	// each adoption destroyed the one state `/rsi revert` needs beyond the last
	// step, so a second adoption made the original surface unrecoverable except
	// through git. `history/` is audit-only; `/rsi revert` still restores the
	// most recent `previous/`.
	if (exists(previous)) {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		ensureDir(join(dir, "history"));
		try {
			renameSync(previous, join(dir, "history", stamp));
		} catch {
			// best-effort: a failed archive must not block the adoption itself
		}
	}

	// `previous/` is always the live surface from before this adoption —
	// that is what `/rsi revert` restores.
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

export interface RevertTarget {
	domain: string;
	slug: string;
	snapshot: Surface;
}

export type RevertResolution = { ok: true; target: RevertTarget } | { ok: false; message: string };

/**
 * Resolve *which* library entry `/rsi revert` means, without touching the live
 * tree. Split out so the command layer can apply the snapshot inside the same
 * guarded transaction as adoption (dirty check, run lock, rollback) instead of
 * writing straight to the tree.
 *
 * With no slug, the most recently adopted entry in `domain` (or the whole
 * library when `domain` is omitted) is used. An explicit target must resolve or
 * fail loudly: silently reverting some other entry is the kind of surprise a
 * restore command must never spring.
 */
export function resolveRevertTarget(
	repoRoot: string,
	cfg: Pick<RsiConfig, "libraryDir">,
	opts: { domain?: string; slug?: string },
): RevertResolution {
	const domains = opts.domain ? [sanitizeSegment(opts.domain)] : listDomains(repoRoot, cfg);
	const explicit = opts.slug !== undefined;
	const emptyTargets: string[] = [];
	for (const domain of [...domains].reverse()) {
		const entries = listEntries(repoRoot, cfg, domain);
		const slugs = opts.slug ? [slugify(opts.slug)] : entries.map((e) => e.slug).reverse();
		for (const slug of slugs) {
			const dir = entryDir(repoRoot, cfg, domain, slug);
			// An explicit slug with no entry directory is a typo, not an empty
			// snapshot: report it as such instead of restoring something else.
			if (opts.slug && !exists(dir)) continue;
			const snapshot = surfaceFromDir(join(dir, "previous"));
			if (Object.keys(snapshot).length === 0) {
				emptyTargets.push(`${domain}/${slug}`);
				continue;
			}
			return { ok: true, target: { domain, slug, snapshot } };
		}
		if (explicit) break;
	}
	if (emptyTargets.length > 0) {
		// The first adoption onto a tree with no surface at all snapshots an
		// empty `previous/` — there is nothing to restore, and saying so is
		// more useful than "not found".
		return {
			ok: false,
			message:
				`${emptyTargets.join(", ")} was adopted onto an empty surface, so there is no previous ` +
				`state to restore — use git to undo that first adoption`,
		};
	}
	if (explicit && opts.domain) {
		return {
			ok: false,
			message: `no library entry ${opts.domain}/${opts.slug} — /rsi library ${opts.domain} lists what exists`,
		};
	}
	return { ok: false, message: "no previous surface snapshot found in the library" };
}

/** Write the loop's EXPERIENCE.md only when validation passes (else write nothing). */
export function writeLessonIfValid(
	repoRoot: string,
	cfg: Pick<RsiConfig, "libraryDir">,
	opts: { domain: string; slug: string; experience: Partial<Experience>; label?: string },
): { written: boolean; errors: string[]; superseded: string[] } {
	const validation = validateExperience(opts.experience);
	if (!validation.ok || !validation.value) return { written: false, errors: validation.errors, superseded: [] };
	const dir = entryDir(repoRoot, cfg, opts.domain, opts.slug);
	writeExperience(dir, {
		...validation.value,
		task: opts.slug,
		adoptedAt: new Date().toISOString().slice(0, 10),
		label: opts.label,
	});
	const superseded = markSupersededEntries(repoRoot, cfg, {
		domain: opts.domain,
		slug: opts.slug,
		cue: validation.value.cue,
	});
	regenerateIndex(repoRoot, cfg, opts.domain);
	return { written: true, errors: [], superseded };
}
