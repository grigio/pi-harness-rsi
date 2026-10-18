/**
 * Small dependency-free helpers shared by every rsi module.
 *
 * Everything here must stay deterministic: tests pin digest shapes and mission
 * sizes, and the fake loop has to be byte-stable across runs.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** Character count (Unicode code points). Budgets in PLAN-rsi.md are chars, not UTF-16 units. */
export function charLen(s: string): number {
	return [...s].length;
}

/** First 12 hex chars of sha256 — stable short identity for strings/surfaces. */
export function hash12(s: string): string {
	return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

export function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

export function writeText(path: string, content: string): void {
	ensureDir(dirname(path));
	writeFileSync(path, content, "utf8");
}

export function readText(path: string): string {
	return readFileSync(path, "utf8");
}

export function readTextIf(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export function exists(path: string): boolean {
	return existsSync(path);
}

export function rmrf(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

/** Convert an OS path to the posix-ish form used in surface keys and globs. */
export function toPosix(p: string): string {
	return p.split(sep).join("/");
}

/** Relative path from `root` to `target`, posix form. Throws outside root. */
export function relPosix(root: string, target: string): string {
	const r = toPosix(relative(root, target));
	if (r === "" || r.startsWith("..") || r.startsWith("/")) {
		throw new Error(`path escapes root: ${target} (root ${root})`);
	}
	return r;
}

export interface ListOptions {
	/** Directory / file names (any depth) skipped entirely. */
	excludeDirs?: string[];
	/** Exact posix-relative paths skipped. */
	excludePaths?: string[];
	maxFiles?: number;
}

/** Recursive file listing, posix-relative, sorted. Directories first-class excluded by name. */
export function listFiles(root: string, opts: ListOptions = {}): string[] {
	const excludeDirs = new Set(opts.excludeDirs ?? []);
	const excludePaths = new Set(opts.excludePaths ?? []);
	const maxFiles = opts.maxFiles ?? 20000;
	const out: string[] = [];

	const walk = (dir: string): void => {
		if (out.length >= maxFiles) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			if (out.length >= maxFiles) break;
			const abs = join(dir, entry.name);
			const rel = toPosix(relative(root, abs));
			if (excludePaths.has(rel)) continue;
			if (entry.isDirectory()) {
				if (excludeDirs.has(entry.name)) continue;
				walk(abs);
			} else if (entry.isFile()) {
				out.push(rel);
			}
		}
	};

	walk(root);
	return out.sort();
}

/** Copy a tree, honouring `excludeDirs` (used for non-git sandboxes). */
export function copyDir(src: string, dst: string, opts: ListOptions = {}): void {
	const files = listFiles(src, opts);
	for (const rel of files) {
		const to = join(dst, rel);
		mkdirSync(dirname(to), { recursive: true });
		copyFileSync(join(src, rel), to);
	}
}

/** Middle-eliding truncation that never silently rewrites a mission (used for excerpts only). */
export function truncateMiddle(s: string, max: number): string {
	if (charLen(s) <= max) return s;
	const head = Math.ceil((max - 1) / 2);
	const tail = Math.floor((max - 1) / 2);
	return `${[...s].slice(0, head).join("")}…${[...s].slice(-tail).join("")}`;
}

export function truncateEnd(s: string, max: number, marker = "…[truncated]"): string {
	if (charLen(s) <= max) return s;
	const keep = Math.max(0, max - charLen(marker));
	return [...s].slice(0, keep).join("") + marker;
}

export function slugify(s: string, max = 48): string {
	const slug = s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/g, "");
	return slug.length > 0 ? slug : "task";
}

/** Single path segment — domains must never reach the filesystem as a path. */
export function sanitizeSegment(s: string): string {
	const clean = s
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 64);
	return clean.length > 0 ? clean : "default";
}

export function nowRunId(task: string): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp =
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
		`-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
	return `${stamp}-${slugify(task, 24)}`;
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-randomness (anonymized selection must be reproducible)
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function seedFromString(s: string): number {
	return parseInt(hash12(s).slice(0, 8), 16);
}

/** Fisher–Yates driven by a seeded PRNG. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
	const rnd = mulberry32(seed);
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** Line-level Jaccard — mode-collapse detector for composed candidates. */
export function jaccardLines(a: string, b: string): number {
	const norm = (s: string) =>
		new Set(
			s
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 0),
		);
	const A = norm(a);
	const B = norm(b);
	if (A.size === 0 && B.size === 0) return 1;
	let inter = 0;
	for (const line of A) if (B.has(line)) inter++;
	return inter / (A.size + B.size - inter);
}

// ---------------------------------------------------------------------------
// Globs (forbidden-path guardrails)
// ---------------------------------------------------------------------------

const globCache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
	const cached = globCache.get(glob);
	if (cached) return cached;
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				if (glob[i + 2] === "/") {
					out += "(?:[^/]+/)*";
					i += 2;
				} else {
					out += ".*";
					i += 1;
				}
			} else {
				out += "[^/]*";
			}
		} else if (c === "?") {
			out += "[^/]";
		} else if ("\\^$.|+()[]{}".includes(c)) {
			out += `\\${c}`;
		} else {
			out += c;
		}
	}
	const re = new RegExp(`^${out}$`);
	globCache.set(glob, re);
	return re;
}

export function matchGlob(path: string, glob: string): boolean {
	return globToRegExp(glob).test(path);
}

export function matchesAnyGlob(path: string, globs: readonly string[]): string | undefined {
	for (const g of globs) if (matchGlob(path, g)) return g;
	return undefined;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/** Content between `<tag>` and `</tag>` (last match wins), trimmed. */
export function extractTag(text: string, tag: string): string | undefined {
	const re = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "g");
	const matches = [...text.matchAll(re)];
	if (matches.length === 0) return undefined;
	const whole = matches[matches.length - 1][0];
	return whole.slice(tag.length + 2, -(tag.length + 3)).trim();
}

/** Strip an optional ```/```json fence from an inline payload. */
export function stripFence(s: string): string {
	const trimmed = s.trim();
	const m = trimmed.match(/^```(?:json|js|javascript|ts|typescript)?\n([\s\S]*?)\n```$/);
	return (m ? m[1] : trimmed).trim();
}

export function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/** Run `fn` over `items` with at most `limit` in flight (maxParallel). */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}
