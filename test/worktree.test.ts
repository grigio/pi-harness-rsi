import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config";
import { copyDir, exists, listFiles } from "../src/util";
import { prepareSandbox } from "../src/worktree";

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
