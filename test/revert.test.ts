import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config";
import { adoptSurface, resolveRevertTarget, writeLessonIfValid } from "../src/library";
import { heldRunLock } from "../src/lock";
import { revertAdopted } from "../src/loop";
import { readSurface } from "../src/surface";

const cfg = resolveConfig({ profile: "small" }, { PI_RSI_FAKE: "1" } as NodeJS.ProcessEnv);

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

/** A committed git project so `workingTreeStatus` is meaningful. */
function repo(): string {
	const cwd = mkdtempSync(join(tmpdir(), "rsi-revert-"));
	writeFileSync(join(cwd, "AGENTS.md"), "# A\n");
	git(cwd, "init");
	git(cwd, "add", "-A");
	git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base");
	return cwd;
}

function lesson(cwd: string): void {
	writeLessonIfValid(cwd, cfg, {
		domain: "demo",
		slug: "tighten-checks",
		experience: {
			cue: "run the verifier after every edit",
			lesson: "paste the exit code",
			evidence: "digest ref0 showed the failure",
			confidence: "high",
		},
	});
	adoptSurface(cwd, cfg, {
		domain: "demo",
		slug: "tighten-checks",
		liveBefore: { "AGENTS.md": "# A\n" },
		adopted: { "AGENTS.md": "# B\n" },
	});
	writeFileSync(join(cwd, "AGENTS.md"), "# B\n");
	git(cwd, "add", "-A");
	git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "adopt");
}

describe("/rsi revert — same guards as adoption (dirty tree, lock, rollback)", () => {
	test("refuses to clobber uncommitted work without --force", async () => {
		const cwd = repo();
		lesson(cwd);
		writeFileSync(join(cwd, "AGENTS.md"), "# C uncommitted\n");

		const refused = await revertAdopted({ cwd, cfg, domain: "demo", slug: "tighten-checks" });
		expect(refused.ok).toBe(false);
		expect(refused.message).toMatch(/uncommitted changes/);
		expect(readSurface(cwd, cfg)["AGENTS.md"]).toBe("# C uncommitted\n");
		// the refusal must not leave a lock behind
		expect(heldRunLock(cwd)).toBeUndefined();
	});

	test("--force restores the previous surface and releases the lock", async () => {
		const cwd = repo();
		lesson(cwd);
		writeFileSync(join(cwd, "AGENTS.md"), "# C uncommitted\n");

		const forced = await revertAdopted({ cwd, cfg, domain: "demo", slug: "tighten-checks", force: true });
		expect(forced.ok).toBe(true);
		expect(readSurface(cwd, cfg)["AGENTS.md"]).toBe("# A\n");
		expect(heldRunLock(cwd)).toBeUndefined();
	});

	test("a snapshot already matching the live tree is a no-op", async () => {
		const cwd = repo();
		lesson(cwd);
		// live == previous (# A). Rewind without a dirty-tree change.
		writeFileSync(join(cwd, "AGENTS.md"), "# A\n");
		git(cwd, "add", "-A");
		git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "back");
		const result = await revertAdopted({ cwd, cfg, domain: "demo", slug: "tighten-checks" });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("nothing to restore");
	});

	test("resolveRevertTarget scans for the newest entry when no target is given", () => {
		const cwd = repo();
		lesson(cwd);
		const resolved = resolveRevertTarget(cwd, cfg, {});
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.target.domain).toBe("demo");
			expect(resolved.target.slug).toBe("tighten-checks");
		}
	});
});
