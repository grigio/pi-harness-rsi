import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config";
import {
	finalAssistantText,
	parseChoice,
	parseEdits,
	parseExperience,
	ReplyParseError,
	sessionFailure,
} from "../src/editor";

const cfg = resolveConfig({ profile: "small" }, {} as NodeJS.ProcessEnv);

describe("editor.parseEdits — the fail-closed reply boundary", () => {
	test("parses <edits> JSON plus <notes>", () => {
		const reply = [
			"<notes>added a verifier step</notes>",
			'<edits>{"files":[{"path":"AGENTS.md","op":"write","content":"# x"}]}</edits>',
		].join("\n");
		const parsed = parseEdits(reply, cfg);
		expect(parsed.notes).toBe("added a verifier step");
		expect(parsed.delta.files).toEqual([{ path: "AGENTS.md", op: "write", content: "# x" }]);
	});

	test("falls back to a fenced ```json block when <edits> is absent", () => {
		const reply = '<notes>n</notes>\n```json\n{"files":[{"path":".pi/prompts/p.md","op":"delete"}]}\n```';
		const parsed = parseEdits(reply, cfg);
		expect(parsed.delta.files).toEqual([{ path: ".pi/prompts/p.md", op: "delete" }]);
	});

	test("a closing fence on the last JSON line is still a fenced block", () => {
		// Regression: requiring a newline before ``` made a valid reply fall back
		// to the base surface, wasting the one retry and inflating kept_base.
		const reply = '<notes>n</notes>\n```json\n{"files":[{"path":"AGENTS.md","op":"write","content":"# x"}]}```';
		expect(parseEdits(reply, cfg).delta.files).toEqual([{ path: "AGENTS.md", op: "write", content: "# x" }]);
	});

	test("a reply with neither block is rejected with an actionable message", () => {
		expect(() => parseEdits("I made some changes, trust me.", cfg)).toThrow(ReplyParseError);
		try {
			parseEdits("I made some changes.", cfg);
		} catch (err) {
			expect((err as Error).message).toContain("<edits>");
			expect((err as Error).message).toContain("json");
		}
	});

	test("a fenced json block whose content contains a ``` fence still parses", () => {
		// Real failure (run 20261019-133713): the compose editor wrote an
		// `AGENTS.md` that documents a ```bash example. The non-greedy fence regex
		// closed the payload at that inner fence, truncating the JSON mid-string
		// ("Unterminated string") — two failed attempts, then a fallback to the
		// base surface instead of the improvement.
		const content = "# AGENTS\n\nRun the check:\n\n```bash\nnode verify.mjs\n```\n";
		const reply = [
			"<notes>added a verifier habit</notes>",
			"```json",
			JSON.stringify({ files: [{ path: "AGENTS.md", op: "write", content }] }),
			"```",
		].join("\n");
		const parsed = parseEdits(reply, cfg);
		expect(parsed.delta.files).toEqual([{ path: "AGENTS.md", op: "write", content }]);
	});

	test("invalid JSON is rejected verbatim", () => {
		expect(() => parseEdits('<edits>{"files": [}</edits>', cfg)).toThrow(/not valid JSON/);
	});

	test("files must be an array", () => {
		expect(() => parseEdits('<edits>{"files": {}}</edits>', cfg)).toThrow(/"files" array/);
	});

	test("write without string content is rejected; delete is not", () => {
		expect(() => parseEdits('<edits>{"files":[{"path":"AGENTS.md","op":"write"}]}</edits>', cfg)).toThrow(
			/without string content/,
		);
		const del = parseEdits('<edits>{"files":[{"path":".pi/prompts/x.md","op":"delete"}]}</edits>', cfg);
		expect(del.delta.files[0]?.op).toBe("delete");
	});

	test("an unknown op is rejected", () => {
		expect(() => parseEdits('<edits>{"files":[{"path":"AGENTS.md","op":"patch"}]}</edits>', cfg)).toThrow(
			/invalid file entry/,
		);
	});

	test("notes are capped at the notes budget", () => {
		const reply = `<notes>${"n".repeat(cfg.budgets.notes + 100)}</notes>\n<edits>{"files":[]}</edits>`;
		const parsed = parseEdits(reply, cfg);
		expect([...parsed.notes].length).toBe(cfg.budgets.notes);
	});
});

describe("editor.parseChoice — selector reply", () => {
	test("accepts a fenced choice and a bare token", () => {
		expect(parseChoice("```choice\nc2\n```", ["c0", "c1", "c2"])).toBe("c2");
		expect(parseChoice("c0", ["c0", "c1"])).toBe("c0");
	});

	test("accepts a closing fence that shares its line with the id", () => {
		expect(parseChoice("```choice\nc1```", ["c0", "c1"])).toBe("c1");
	});

	test("an out-of-pool id is rejected with the pool listed", () => {
		expect(() => parseChoice("```choice\nc9\n```", ["c0", "c1"])).toThrow(ReplyParseError);
		try {
			parseChoice("```choice\nc9\n```", ["c0", "c1"]);
		} catch (err) {
			expect((err as Error).message).toContain("c0, c1");
		}
	});
});

describe("editor.parseExperience — reflection reply", () => {
	test("`none` means no lesson", () => {
		expect(parseExperience("<experience>none</experience>")).toBeUndefined();
		expect(parseExperience("<experience>NONE</experience>")).toBeUndefined();
	});

	test("parses a JSON object", () => {
		const reply =
			'<experience>{"cue":"before editing","lesson":"run the verifier","evidence":"digest ref0","confidence":"high"}</experience>';
		expect(parseExperience(reply)).toEqual({
			cue: "before editing",
			lesson: "run the verifier",
			evidence: "digest ref0",
			confidence: "high",
		});
	});

	test("recovers the pretty-printed multi-line fake object", () => {
		const reply = [
			"<experience>",
			'{"cue": "when tests fail",',
			' "lesson": "read the digest first",',
			' "evidence": "errors: bash exit=1",',
			' "confidence": "medium"}',
			"</experience>",
		].join("\n");
		expect(parseExperience(reply)?.lesson).toBe("read the digest first");
	});

	test("a missing required key yields undefined (nothing speculative is written)", () => {
		expect(parseExperience('<experience>{"cue":"c","lesson":"l"}</experience>')).toBeUndefined();
		expect(parseExperience("<experience>garbage</experience>")).toBeUndefined();
		expect(parseExperience("no tags here")).toBeUndefined();
	});
});

describe("editor.finalAssistantText — last assistant message wins", () => {
	test("ignores tool results and returns the final assistant text", () => {
		const jsonl = [
			JSON.stringify({ type: "message", message: { role: "assistant", content: "first" } }),
			JSON.stringify({ type: "message", message: { role: "user", content: "prompt" } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "second" }] } }),
			"not json",
			"",
		].join("\n");
		expect(finalAssistantText(jsonl)).toBe("second");
	});

	test("an empty session yields the empty string", () => {
		expect(finalAssistantText("")).toBe("");
	});
});

describe("editor.sessionFailure — a provider error is not an unparsable reply", () => {
	test("reports the provider's own message for an errored assistant turn", () => {
		const line = JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: '429: {"type":"FreeUsageLimitError","message":"Rate limit exceeded."}',
			},
		});
		expect(sessionFailure(`${line}\n`)).toContain("Rate limit exceeded");
	});

	test("is undefined for a normal empty/complete turn", () => {
		const stopped = JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [], stopReason: "stop" },
		});
		expect(sessionFailure(`${stopped}\n`)).toBeUndefined();
		expect(sessionFailure("")).toBeUndefined();
	});
});
