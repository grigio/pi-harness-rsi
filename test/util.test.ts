import { describe, expect, test } from "bun:test";
import {
	charLen,
	globToRegExp,
	jaccardLines,
	mapLimit,
	matchesAnyGlob,
	matchGlob,
	sanitizeSegment,
	seededShuffle,
	segmentError,
	slugify,
	truncateEnd,
	truncateMiddle,
} from "../src/util";

describe("util.gltobs — globToRegExp / matchGlob", () => {
	test("`*` stays inside one path segment, `**` crosses it", () => {
		expect(matchGlob("src/a.ts", "src/*.ts")).toBe(true);
		expect(matchGlob("src/nested/a.ts", "src/*.ts")).toBe(false);
		expect(matchGlob("src/nested/a.ts", "src/**")).toBe(true);
		expect(matchGlob("a/b/c.ts", "a/**")).toBe(true);
	});

	test("`**/` matches zero or more leading directories", () => {
		expect(matchGlob("x.test.ts", "**/*.test.ts")).toBe(true);
		expect(matchGlob("a/b/x.test.ts", "**/*.test.ts")).toBe(true);
		expect(matchGlob("a/b/x.spec.ts", "**/*.test.ts")).toBe(false);
	});

	test("`?` is a single, non-slash character", () => {
		expect(matchGlob("a1.ts", "a?.ts")).toBe(true);
		expect(matchGlob("a12.ts", "a?.ts")).toBe(false);
		expect(matchGlob("a/.ts", "a?.ts")).toBe(false);
	});

	test("regex metacharacters are escaped, anchors are exact", () => {
		expect(matchGlob("package.json", "package.json")).toBe(true);
		expect(matchGlob("packageXjson", "package.json")).toBe(false);
		expect(matchGlob("a+b", "a+b")).toBe(true);
		expect(globToRegExp("**/*.test.ts") instanceof RegExp).toBe(true);
	});

	test("matchesAnyGlob returns the first matching pattern", () => {
		expect(matchesAnyGlob("test/x.test.ts", ["tests/**", "**/*.test.ts"])).toBe("**/*.test.ts");
		expect(matchesAnyGlob("src/a.ts", ["tests/**", "**/*.test.ts"])).toBeUndefined();
	});

	test("results are cached by pattern (same RegExp identity)", () => {
		expect(globToRegExp("cache-me/**")).toBe(globToRegExp("cache-me/**"));
	});
});

describe("util path safety — slugify / sanitizeSegment", () => {
	test("slugify produces a filesystem-safe slug", () => {
		expect(slugify("Fix The Failing Check!")).toBe("fix-the-failing-check");
		expect(slugify("  --already--dashed-- ")).toBe("already-dashed");
		expect(slugify("", 10)).toBe("task");
		expect(slugify("!!!", 10)).toBe("task");
		expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(48);
	});

	test("sanitizeSegment never yields a path traversal or a separator", () => {
		for (const raw of ["../../etc/passwd", "..", ".", "a/b\\c", "Ünïcode", ""]) {
			const out = sanitizeSegment(raw);
			expect(out.length).toBeGreaterThan(0);
			expect(out.includes("/")).toBe(false);
			expect(out.includes("\\")).toBe(false);
			expect(out.startsWith(".")).toBe(false);
			expect(out.startsWith("-")).toBe(false);
		}
	});

	test("charLen counts code points, not UTF-16 units", () => {
		expect(charLen("a😀b")).toBe(3);
	});
});

describe("util.truncate — never silently overruns the cap", () => {
	test("truncateMiddle and truncateEnd respect the cap", () => {
		const long = "x".repeat(1000);
		expect(charLen(truncateMiddle(long, 100))).toBe(100);
		expect(charLen(truncateEnd(long, 100))).toBe(100);
		expect(truncateMiddle("short", 100)).toBe("short");
		expect(truncateEnd("short", 100)).toBe("short");
	});
});

describe("util.mapLimit — bounded concurrency, stable order", () => {
	test("results keep input order regardless of completion order", async () => {
		const items = [30, 5, 20, 1, 15];
		const out = await mapLimit(items, 2, async (ms, i) => {
			await new Promise((r) => setTimeout(r, ms));
			return `${i}:${ms}`;
		});
		expect(out).toEqual(["0:30", "1:5", "2:20", "3:1", "4:15"]);
	});

	test("never exceeds the concurrency limit", async () => {
		let inFlight = 0;
		let peak = 0;
		await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return 0;
		});
		expect(peak).toBeLessThanOrEqual(3);
	});

	test("an empty list resolves to an empty array", async () => {
		expect(await mapLimit([], 4, async () => 1)).toEqual([]);
	});
});

describe("util determinism — seeded shuffle + jaccard", () => {
	test("seededShuffle is reproducible and a permutation", () => {
		const a = seededShuffle([1, 2, 3, 4, 5], 42);
		const b = seededShuffle([1, 2, 3, 4, 5], 42);
		expect(a).toEqual(b);
		expect([...a].sort()).toEqual([1, 2, 3, 4, 5]);
	});

	test("jaccardLines: identical → 1, disjoint → 0, empty/empty → 1", () => {
		expect(jaccardLines("a\nb", "a\nb")).toBe(1);
		expect(jaccardLines("a", "b")).toBe(0);
		expect(jaccardLines("", "")).toBe(1);
		expect(jaccardLines("a\nb", "b\nc")).toBeCloseTo(1 / 3, 5);
	});
});

describe("util.segmentError — user-supplied path segments", () => {
	test("rejects traversal, separators, empties and overlong values", () => {
		expect(segmentError("final0")).toBeUndefined();
		expect(segmentError("a.b_c-d")).toBeUndefined();
		expect(segmentError("../../evil")).toContain("path separator");
		expect(segmentError("a/b")).toContain("path separator");
		expect(segmentError("a\\b")).toContain("path separator");
		expect(segmentError("..")).toContain("..");
		expect(segmentError("a..b")).toContain("..");
		expect(segmentError("")).toContain("empty");
		expect(segmentError("x".repeat(129))).toContain("too long");
		expect(segmentError("has space")).toContain("may only contain");
	});
});

describe("util.mapLimit — fail fast and quiet", () => {
	test("stops scheduling after the first failure and rejects others with the cause", async () => {
		let started = 0;
		let running = 0;
		let peakRunning = 0;
		const err = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
			started++;
			running++;
			peakRunning = Math.max(peakRunning, running);
			if (n === 2) {
				running--;
				throw new Error("boom");
			}
			await new Promise((r) => setTimeout(r, 20));
			running--;
			return n;
		}).catch((e: Error) => e);
		expect((err as Error).message).toBe("boom");
		// only the first batch ever started; no runaway siblings
		expect(started).toBe(2);
		expect(peakRunning).toBeLessThanOrEqual(2);
	});
});

describe("util.writeTextAtomic — a failed write leaves the old file intact", () => {
	test("an unreadable directory makes the write fail without truncating the file", async () => {
		const { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { writeTextAtomic } = await import("../src/util");

		const dir = mkdtempSync(join(tmpdir(), "rsi-atomic-"));
		const file = join(dir, "ledger.json");
		writeFileSync(file, '{"old":true}\n');
		chmodSync(dir, 0o555); // no new/tmp files may be created here
		try {
			expect(() => writeTextAtomic(file, '{"new":true}\n')).toThrow();
		} finally {
			chmodSync(dir, 0o755);
		}
		// The reader sees either the old content or the new one — never a truncated file.
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ old: true });
		// And no temporary sibling is left behind on the success path.
		writeTextAtomic(file, '{"new":true}\n');
		expect(readdirSync(dir)).toEqual(["ledger.json"]);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ new: true });
	});
});
