/**
 * `buildChildArgs` decides what a child `pi` sees. Two invariants matter:
 * editors must stay answer-only (no project context/skills/prompts, no project
 * trust), and they must not disable *provider* extensions — `--no-extensions`
 * also unregisters providers such as `opencode-free`, so the configured model
 * silently falls back to an unrelated local one and the editor stops emitting
 * the reply format the loop requires.
 */

import { describe, expect, test } from "bun:test";
import { buildChildArgs } from "../src/probe";

const base = { sessionDir: "/tmp/s", prompt: "do it", tools: ["read"] };

describe("child pi arguments (src/probe.ts)", () => {
	test("an editor run is answer-only but keeps provider extensions", () => {
		const args = buildChildArgs({ ...base, editor: true });
		expect(args).toContain("--no-context-files");
		expect(args).toContain("--no-skills");
		expect(args).toContain("--no-prompt-templates");
		expect(args).toContain("--no-approve");
		// Regression: this dropped the provider extension and changed the model.
		expect(args).not.toContain("--no-extensions");
	});

	test("a solver run trusts its sandbox and forwards model/thinking", () => {
		const args = buildChildArgs({ ...base, model: "opencode-free/deepseek", thinking: "low" });
		expect(args).toContain("--approve");
		expect(args).toEqual(expect.arrayContaining(["--model", "opencode-free/deepseek", "--thinking", "low"]));
	});

	test("the prompt is the last argument, so it is never parsed as a flag", () => {
		const args = buildChildArgs({ ...base, prompt: "--verbose is not a flag" });
		expect(args.at(-1)).toBe("--verbose is not a flag");
	});
});
