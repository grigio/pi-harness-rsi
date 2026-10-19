import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config";
import { copyDir, exists, listFiles } from "../src/util";
import { cleanupSandboxes, prepareSandbox, runToken, runVerifier, sandboxId } from "../src/worktree";

function freshCwd(): string {
	return mkdtempSync(join(tmpdir(), "rsi-worktree-"));
}

const cfg = resolveConfig({ profile: "small" }, {} as NodeJS.ProcessEnv);

describe("non-git sandbox (copy) is byte-faithful", () => {
	test("copyDir copies binary files unchanged (no utf8 round-trip)", () => {
		const src = freshCwd();
		const dst = freshCwd();
		const binary = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x0a, 0xc3, 0x28]);
		writeFileSync(join(src, "asset.bin"), binary);
		writeFileSync(join(src, "notes.txt"), "hello\n");
		copyDir(src, dst, { excludeDirs: ["node_modules"] });
		expect(readFileSync(join(dst, "asset.bin")).equals(binary)).toBe(true);
		expect(readFileSync(join(dst, "notes.txt"), "utf8")).toBe("hello\n");
	});

	test("prepareSandbox(forceCopy) copies the live tree and stages the surface", () => {
		const cwd = freshCwd();
		const binary = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00]);
		writeFileSync(join(cwd, "src.bin"), binary);
		writeFileSync(join(cwd, "AGENTS.md"), "# old\n");
		mkdirSync(join(cwd, ".pi", "harness"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "harness", "keep-me"), ""); // must be excluded from the copy

		const sandbox = prepareSandbox(cwd, cfg, {
			id: "sb-copy",
			forceCopy: true,
			copySource: cwd,
		});
		try {
			expect(sandbox.kind).toBe("copy");
			expect(readFileSync(join(sandbox.path, "src.bin")).equals(binary)).toBe(true);
			// .pi/harness is excluded from non-git copies
			expect(listFiles(sandbox.path).some((f) => f.startsWith(".pi/harness"))).toBe(false);

			// staging replaces the surface and prunes dropped surface files
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "old.md"), "# old prompt\n");
			sandbox.stage({ "AGENTS.md": "# new\n", ".pi/prompts/new.md": "# new prompt\n" });
			expect(readFileSync(join(sandbox.path, "AGENTS.md"), "utf8")).toBe("# new\n");
			expect(exists(join(sandbox.path, ".pi", "prompts", "new.md"))).toBe(true);
			expect(exists(join(sandbox.path, ".pi", "prompts", "old.md"))).toBe(false);
		} finally {
			sandbox.cleanup();
		}
		expect(exists(sandbox.path)).toBe(false);
	});
});

describe("cleanupSandboxes protects live run sandboxes", () => {
	test("a sandbox whose name carries the run token survives pruning", () => {
		const cwd = freshCwd();
		const root = join(cwd, cfg.worktreeRoot);
		const mine = sandboxId("run-a", "final0");
		const other = sandboxId("run-b", "final0");
		mkdirSync(join(root, mine), { recursive: true });
		mkdirSync(join(root, other), { recursive: true });
		// Age both past the stale threshold.
		const old = Date.now() - 60 * 60 * 1000;
		utimesSync(join(root, mine), new Date(old), new Date(old));
		utimesSync(join(root, other), new Date(old), new Date(old));

		const result = cleanupSandboxes(cwd, cfg, { protect: ["run-a"], staleMs: 1000 });
		expect(exists(join(root, mine))).toBe(true);
		expect(exists(join(root, other))).toBe(false);
		expect(result.dirs).toBe(1);

		// Without protection both go.
		mkdirSync(join(root, other), { recursive: true });
		utimesSync(join(root, other), new Date(old), new Date(old));
		cleanupSandboxes(cwd, cfg, { staleMs: 1000 });
		expect(exists(join(root, mine))).toBe(false);
	});

	test("sandbox ids are unique per label within a run", () => {
		expect(sandboxId("run-a", "final0")).not.toBe(sandboxId("run-a", "final1"));
		expect(sandboxId("run-a", "final0")).not.toBe(sandboxId("run-b", "final0"));
		expect(sandboxId("run-a", "final0").startsWith(`${runToken("run-a")}-`)).toBe(true);
	});
});

describe("runVerifier is async and abortable (no event-loop freeze)", () => {
	test("a passing verifier reports exit=0 with its tail", async () => {
		const cwd = freshCwd();
		const evidence = await runVerifier(cwd, { verifier: "echo all-good; exit 0", stageTimeoutMs: 10_000 });
		expect(evidence?.exit).toBe(0);
		expect(evidence?.line).toContain("exit=0");
		expect(evidence?.line).toContain("all-good");
	});

	test("a failing verifier reports its exit code", async () => {
		const cwd = freshCwd();
		const evidence = await runVerifier(cwd, { verifier: "echo boom >&2; exit 3", stageTimeoutMs: 10_000 });
		expect(evidence?.exit).toBe(3);
		expect(evidence?.line).toContain("exit=3");
	});

	test("an aborted verifier is killed and reported as aborted", async () => {
		const cwd = freshCwd();
		const controller = new AbortController();
		const promise = runVerifier(cwd, { verifier: "sleep 30", stageTimeoutMs: 30_000 }, controller.signal);
		controller.abort();
		const evidence = await promise;
		expect(evidence?.line).toContain("aborted");
		expect(evidence?.exit).toBeUndefined();
	});
});
