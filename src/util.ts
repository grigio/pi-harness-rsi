/**
 * Small dependency-free helpers shared by every rsi module.
 *
 * Everything here must stay deterministic: tests pin digest shapes and mission
 * sizes, and the fake loop has to be byte-stable across runs.
 */

import { createHash } from "node:crypto";
import {
	copyFileSync,
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** Character count (Unicode code points). Budgets are chars, not UTF-16 units. */
export function charLen(s: string): number {
	return [...s].length;
}

/**
 * Validate a *single* path segment that comes from user input (a run id or a
 * surface label) before it is joined into a filesystem path.
 *
 * `join(runDir, "surfaces", `${label}.json`)` with a label of
 * `../../../../evil` resolves outside the run directory, so an unvalidated
 * `/rsi adopt <label>` could read — and adopt — any JSON file on disk. Returns
 * an error string, or undefined when the segment is safe.
 */
export function segmentError(value: string, what = "segment"): string | undefined {
	if (value.length === 0) return `${what} is empty`;
	if (value.length > 128) return `${what} is too long (${value.length} chars, max 128)`;
	if (value.includes("/") || value.includes("\\")) return `${what} must not contain a path separator: "${value}"`;
	if (value.includes("\u0000")) return `${what} contains a NUL byte`;
	if (value === "." || value === ".." || value.includes("..")) return `${what} must not contain "..": "${value}"`;
	if (!/^[A-Za-z0-9._-]+$/.test(value)) {
		return `${what} may only contain letters, digits, dot, underscore and hyphen: "${value}"`;
	}
	return undefined;
}

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

/**
 * Write a file through a temporary sibling + `rename`, so a reader (or a crash)
 * never observes a half-written file. Used for the run ledger, status and report:
 * a truncated `ledger.json` makes the run unreadable, and retention is documented
 * to keep what it cannot account for.
 */
export function writeTextAtomic(path: string, content: string): void {
	ensureDir(dirname(path));
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, content, "utf8");
	try {
		renameSync(tmp, path);
	} catch {
		// Windows cannot rename over an existing file: replace it explicitly.
		rmSync(path, { force: true });
		renameSync(tmp, path);
	}
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
	// Multi-segment entries (e.g. `.pi/harness`) cannot match a directory name;
	// match them against the repo-relative path so nested trees really are skipped.
	const excludeScoped = [...excludeDirs].filter((d) => d.includes("/"));
	const excludePaths = new Set(opts.excludePaths ?? []);
	const maxFiles = opts.maxFiles ?? 20000;
	const out: string[] = [];

	const excludedDir = (name: string, rel: string): boolean => {
		if (excludeDirs.has(name)) return true;
		return excludeScoped.some((d) => rel === d || rel.startsWith(`${d}/`));
	};

	const walk = (dir: string): void => {
		if (out.length >= maxFiles) return;
		let entries: Dirent[];
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
				if (excludedDir(entry.name, rel)) continue;
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
		const tmp = out[i];
		out[i] = out[j] as T;
		out[j] = tmp as T;
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
		const c = glob.charAt(i);
		if (c === "*") {
			if (glob.charAt(i + 1) === "*") {
				if (glob.charAt(i + 2) === "/") {
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
	const whole = matches[matches.length - 1]?.[0] ?? "";
	return whole.slice(tag.length + 2, -(tag.length + 3)).trim();
}

/** Strip an optional ```/```json fence from an inline payload. */
export function stripFence(s: string): string {
	const trimmed = s.trim();
	// Tolerant of a closing fence that shares its line with the last token.
	const m = trimmed.match(/^```(?:json|js|javascript|ts|typescript)?[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/);
	return (m ? (m[1] ?? "") : trimmed).trim();
}

/**
 * Run `fn` over `items` with at most `limit` in flight (maxParallel).
 *
 * Failure is fail-fast *and* fail-quiet: the first rejection stops the workers
 * from picking up new items (previously they kept draining the queue, so a
 * `/rsi stop` rejection left children burning budget with nobody awaiting
 * them), and in-flight promises are awaited before the error propagates so no
 * sandbox is cleaned up from under a live child.
 */
export async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	let failure: unknown;
	const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
		for (;;) {
			if (failure !== undefined) return;
			const i = next++;
			if (i >= items.length) return;
			try {
				results[i] = await fn(items[i] as T, i);
			} catch (err) {
				if (failure === undefined) failure = err;
				return;
			}
		}
	});
	await Promise.all(workers);
	if (failure !== undefined) throw failure;
	return results;
}
