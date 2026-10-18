/**
 * SurfaceSpec (README “The editable surface”): the editable harness surface — AGENTS.md,
 * `.pi/skills/<name>/{SKILL.md,scripts/**}` and `.pi/prompts/*.md`.
 *
 * Edit contract: *omitted-is-inherited* — a proposal emits only changed files
 * and the applied candidate is `base ⊕ delta`.
 *
 * Every `validate()` error message is verbatim retry feedback for the editor,
 * so they are written as instructions, not as stack traces.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RsiConfig } from "./config";
import { forbiddenMatch, forbiddenError, scanTripwire, tripwireError } from "./guard";
import { charLen, ensureDir, exists, globToRegExp, hash12, listFiles, readTextIf, toPosix, writeText } from "./util";

/** posix-relative surface path → file content. */
export type Surface = Record<string, string>;

export type SurfaceOp = "write" | "delete";

export interface SurfaceFileChange {
	path: string;
	op: SurfaceOp;
	content?: string;
}

export interface SurfaceDelta {
	files: SurfaceFileChange[];
	notes?: string;
}

export interface SurfaceDiff {
	added: string[];
	removed: string[];
	modified: string[];
	unchanged: string[];
	/** Char delta of the always-on file (positive = more always-on context). */
	alwaysOnDelta: number;
	/** Net char delta across the whole surface. */
	charsDelta: number;
}

export interface ValidationReport {
	errors: string[];
	warnings: string[];
}

/** Prefixes that may ever appear in a delta. Everything else is off-surface. */
const RE_PROMPT = /^\.pi\/prompts\/[^/]+\.md$/;
const RE_SKILL_MD = /^\.pi\/skills\/([^/]+)\/SKILL\.md$/;
const RE_SKILL_SCRIPT = /^\.pi\/skills\/([^/]+)\/scripts\/.+$/;
const RE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MAX_FILES_PER_SKILL = 20;
const MAX_PROMPT_FILES = 20;

export const SURFACE_DIRS = [".pi/skills", ".pi/prompts"] as const;

/**
 * Path whitelist. Returns a verbatim error string when the path may not be
 * edited, otherwise undefined.
 */
export function isAllowedPath(path: string): string | undefined {
	const p = toPosix(path).trim();
	if (p.length === 0) return "empty path — every delta entry needs a surface-relative path";
	if (p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p)) {
		return `absolute path "${path}" — surface paths are relative to the project root`;
	}
	const segments = p.split("/");
	if (segments.includes("..")) return `path traversal ".." in "${path}" — surface paths stay inside the project`;
	if (p === "AGENTS.md") return undefined;
	if (RE_PROMPT.test(p)) return undefined;
	const skillMd = p.match(RE_SKILL_MD);
	if (skillMd) return checkSkillName(skillMd[1], p);
	const skillScript = p.match(RE_SKILL_SCRIPT);
	if (skillScript) return checkSkillName(skillScript[1], p);
	return (
		`off-surface path "${path}" — allowed: AGENTS.md, .pi/prompts/<name>.md, ` +
		`.pi/skills/<name>/SKILL.md, .pi/skills/<name>/scripts/**`
	);
}

function checkSkillName(name: string, path: string): string | undefined {
	if (!RE_SKILL_NAME.test(name) || name.length > 64) {
		return `invalid skill directory "${name}" in "${path}" — use lowercase letters, numbers and hyphens (max 64)`;
	}
	return undefined;
}

/** Skill directory name for a surface path, or undefined. */
export function skillDirOf(path: string): string | undefined {
	const m = path.match(RE_SKILL_MD) ?? path.match(RE_SKILL_SCRIPT);
	return m?.[1];
}

export function isAlwaysOn(path: string): boolean {
	return path === "AGENTS.md";
}

/** Read the surface out of a working tree (live tree or sandbox). */
export function readSurface(root: string, cfg?: Pick<RsiConfig, "forbiddenGlobs">): Surface {
	const surface: Surface = {};
	const agents = join(root, "AGENTS.md");
	if (exists(agents)) surface["AGENTS.md"] = readTextIf(agents) ?? "";

	const candidates = listFiles(root, { excludeDirs: [".git", "node_modules", ".pi/harness", "dist", "build", ".cache"] });
	for (const rel of candidates) {
		if (rel === "AGENTS.md") continue;
		if (isAllowedPath(rel) !== undefined) continue;
		if (cfg && forbiddenMatch(rel, cfg) !== undefined) continue;
		const abs = join(root, rel);
		try {
			surface[rel] = readFileSync(abs, "utf8");
		} catch {
			// unreadable file — ignored, validate() reports a missing AGENTS.md if it matters
		}
	}
	return surface;
}

/** Write a surface into a tree. `prune` removes previously-surface files that are absent now. */
export function writeSurface(root: string, surface: Surface, opts: { prune?: boolean } = {}): void {
	if (opts.prune) {
		const existing = listFiles(root, { excludeDirs: [".git", "node_modules", ".pi/harness"] });
		for (const rel of existing) {
			if (isAllowedPath(rel) !== undefined) continue;
			if (rel in surface) continue;
			try {
				rmSync(join(root, rel), { force: true });
			} catch {
				// best-effort prune
			}
		}
	}
	for (const [path, content] of Object.entries(surface)) {
		writeText(join(root, path), content);
	}
	ensureDir(root);
}

/** `base ⊕ delta`. Unknown ops throw (fail closed to the previous surface). */
export function applyDelta(base: Surface, delta: SurfaceDelta): Surface {
	const out: Surface = { ...base };
	for (const change of delta.files ?? []) {
		if (!change || typeof change.path !== "string" || (change.op !== "write" && change.op !== "delete")) {
			throw new Error(`invalid delta entry ${JSON.stringify(change)} — expected {path, op: "write"|"delete", content}`);
		}
		if (change.op === "delete") {
			delete out[change.path];
			continue;
		}
		if (typeof change.content !== "string") {
			throw new Error(`delta entry "${change.path}" has op "write" but no string content`);
		}
		out[change.path] = change.content;
	}
	return out;
}

export function isEmptyDelta(delta: SurfaceDelta): boolean {
	return !delta.files || delta.files.length === 0;
}

export function diffSurface(base: Surface, cand: Surface): SurfaceDiff {
	const diff: SurfaceDiff = { added: [], removed: [], modified: [], unchanged: [], alwaysOnDelta: 0, charsDelta: 0 };
	const paths = new Set([...Object.keys(base), ...Object.keys(cand)]);
	for (const path of [...paths].sort()) {
		const inBase = path in base;
		const inCand = path in cand;
		if (!inBase && inCand) diff.added.push(path);
		else if (inBase && !inCand) diff.removed.push(path);
		else if (inBase && inCand && base[path] !== cand[path]) diff.modified.push(path);
		else diff.unchanged.push(path);
	}
	diff.alwaysOnDelta = charLen(cand["AGENTS.md"] ?? "") - charLen(base["AGENTS.md"] ?? "");
	diff.charsDelta =
		Object.values(cand).reduce((n, c) => n + charLen(c), 0) - Object.values(base).reduce((n, c) => n + charLen(c), 0);
	return diff;
}

/** Stable identity of a surface (ordering-independent). */
export function surfaceHash(surface: Surface): string {
	const keys = Object.keys(surface).sort();
	const canonical = keys.map((k) => `${k}\n${surface[k]}`).join("\u0000");
	return hash12(canonical);
}

export interface FrontmatterReport {
	ok: boolean;
	name?: string;
	description?: string;
	body: string;
	errors: string[];
}

/** Minimal `---\nkey: value\n---` parser (Agent Skills frontmatter). */
export function parseFrontmatter(text: string): FrontmatterReport {
	const errors: string[] = [];
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) {
		return { ok: false, body: text, errors: ["missing YAML frontmatter (`---` … `---`) at top of SKILL.md"] };
	}
	const fields: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
		if (key) fields[key] = value;
	}
	if (!fields["name"]) errors.push("frontmatter is missing `name:`");
	if (!fields["description"]) errors.push("frontmatter is missing `description:` (pi will not load the skill without it)");
	return {
		ok: errors.length === 0,
		name: fields["name"],
		description: fields["description"],
		body: m[2] ?? "",
		errors,
	};
}

/**
 * Full validation of a candidate surface. Errors block probing (P3: fail closed
 * to the base surface); warnings are surfaced but never block.
 */
export function validate(surface: Surface, cfg: RsiConfig, opts: { where?: string } = {}): ValidationReport {
	const errors: string[] = [];
	const warnings: string[] = [];
	const where = opts.where ? `${opts.where}: ` : "";
	const budgets = cfg.budgets;

	// 1. Path whitelist (delta paths are surface paths, so this covers every key).
	for (const path of Object.keys(surface)) {
		const pathError = isAllowedPath(path);
		if (pathError) {
			errors.push(where + pathError);
			continue;
		}
		const forbidden = forbiddenMatch(path, cfg);
		if (forbidden) errors.push(where + forbiddenError(path, forbidden));
		const marker = scanTripwire(path, surface[path] ?? "");
		if (marker) errors.push(where + tripwireError(path, marker));
	}

	// 2. Always-on file.
	const agents = surface["AGENTS.md"];
	if (typeof agents !== "string") {
		errors.push(`${where}AGENTS.md is missing — the always-on file must always be present`);
	} else if (charLen(agents) > budgets.agentsMd) {
		errors.push(
			`${where}AGENTS.md is ${charLen(agents)} chars, over the ${budgets.agentsMd} budget (profile ${cfg.profile}) — cut it down to fit`,
		);
	}

	// 3. Skill files.
	const skillDirs = new Map<string, string[]>();
	for (const path of Object.keys(surface)) {
		const dir = skillDirOf(path);
		if (!dir) continue;
		skillDirs.set(dir, [...(skillDirs.get(dir) ?? []), path]);
	}

	for (const [dir, paths] of [...skillDirs.entries()].sort()) {
		const skillMdPath = `.pi/skills/${dir}/SKILL.md`;
		const content = surface[skillMdPath];
		if (typeof content !== "string") {
			errors.push(`${where}.pi/skills/${dir}/ has no SKILL.md — ship the skill file or drop the directory`);
			continue;
		}

		const fm = parseFrontmatter(content);
		for (const e of fm.errors) errors.push(`${where}${skillMdPath}: ${e}`);
		if (fm.name && fm.name !== dir) {
			errors.push(`${where}${skillMdPath}: frontmatter name "${fm.name}" must match directory "${dir}"`);
		}
		if (typeof fm.description === "string" && fm.description.length > 0) {
			if (charLen(fm.description) > budgets.skillDescription) {
				errors.push(
					`${where}${skillMdPath}: description is ${charLen(fm.description)} chars, over the ${budgets.skillDescription} budget — shorten it`,
				);
			}
		}
		const body = fm.body ?? "";
		if (charLen(body) > budgets.skillBodyWarn) {
			warnings.push(`${where}${skillMdPath}: body is ${charLen(body)} chars (warn cap ${budgets.skillBodyWarn})`);
		}

		// Every skill must be named in the always-on file, or it is dead weight.
		if (typeof agents === "string" && !agents.includes(dir)) {
			errors.push(
				`${where}skill "${dir}" is not named in AGENTS.md — add a trigger line mentioning "${dir}" so the always-on context can route to it`,
			);
		}

		// Referenced helpers must ship inside the skill directory.
		const referenced = new Set([...body.matchAll(/(?:\.\/)?scripts\/[\w./-]+/g)].map((m) => m[0].replace(/^\.\//, "")));
		for (const ref of referenced) {
			const full = `.pi/skills/${dir}/${ref}`;
			if (!(full in surface)) {
				errors.push(`${where}${skillMdPath}: references "${ref}" but the file is not part of the surface — ship it under scripts/ or drop the reference`);
			}
		}

		const scriptCount = paths.filter((p) => p.startsWith(`.pi/skills/${dir}/scripts/`)).length;
		if (scriptCount > MAX_FILES_PER_SKILL) {
			errors.push(`${where}skill "${dir}" ships ${scriptCount} scripts, over the ${MAX_FILES_PER_SKILL} file cap`);
		}
	}

	// 4. Prompt files.
	const promptFiles = Object.keys(surface).filter((p) => p.startsWith(".pi/prompts/"));
	if (promptFiles.length > MAX_PROMPT_FILES) {
		errors.push(`${where}${promptFiles.length} prompt files, over the ${MAX_PROMPT_FILES} file cap`);
	}

	return { errors, warnings };
}

/** File map lines for missions: `path  N chars`. Never includes content (P2). */
export function renderFileMap(surface: Surface, root = ""): string[] {
	const prefix = root ? root.replace(/\/$/, "") + "/" : "";
	return Object.keys(surface)
		.sort()
		.map((path) => `${prefix}${path}  ${charLen(surface[path])} chars`);
}

export function surfaceToJson(surface: Surface): string {
	const sorted: Surface = {};
	for (const path of Object.keys(surface).sort()) sorted[path] = surface[path];
	return JSON.stringify(sorted, null, "\t");
}

export function surfaceFromJson(text: string): Surface {
	const parsed = JSON.parse(text) as Surface;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("surface snapshot is not an object");
	for (const [path, content] of Object.entries(parsed)) {
		if (typeof content !== "string") throw new Error(`surface snapshot entry "${path}" is not a string`);
	}
	return parsed;
}

/** One-line summary used in status output and mission headers. */
export function summarizeDiff(diff: SurfaceDiff): string {
	return (
		`added ${diff.added.length}, removed ${diff.removed.length}, modified ${diff.modified.length}, ` +
		`always-on Δ ${diff.alwaysOnDelta >= 0 ? "+" : ""}${diff.alwaysOnDelta} chars, surface Δ ` +
		`${diff.charsDelta >= 0 ? "+" : ""}${diff.charsDelta} chars`
	);
}

/** Regex helper re-exported for tests (kept here because paths are its concern). */
export const pathGlob = globToRegExp;
