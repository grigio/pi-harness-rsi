import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config";
import { loadLessons, readExperience, readIndex, writeLessonIfValid } from "../src/library";

const cfg = resolveConfig({}, {} as NodeJS.ProcessEnv);

function makeRepo(): string {
	return mkdtempSync(join(tmpdir(), "rsi-lib-"));
}

const lesson = (cue: string, text: string) => ({
	cue,
	lesson: text,
	evidence: "digest ref0 showed the failure",
	confidence: "high",
});

describe("library freshness + temporal supersession", () => {
	test("rendered lessons carry a freshness date (staleness signal for the editor)", () => {
		const cwd = makeRepo();
		writeLessonIfValid(cwd, cfg, {
			domain: "demo",
			slug: "verifier-first",
			experience: lesson("run the verifier after every edit", "paste the exit code"),
		});
		const { lessons } = loadLessons(cwd, cfg, "demo", "verifier after edit");
		expect(lessons.length).toBe(1);
		expect(lessons[0]).toContain("adopted: ");
	});

	test("a newer same-cue lesson supersedes the older one; retrieval stops serving it", () => {
		const cwd = makeRepo();
		writeLessonIfValid(cwd, cfg, {
			domain: "demo",
			slug: "old",
			experience: lesson("run the verifier after every edit and re-read the file", "re-read the edited file"),
		});
		writeLessonIfValid(cwd, cfg, {
			domain: "demo",
			slug: "new",
			experience: lesson("run the verifier after every edit", "paste the exit code verbatim"),
		});

		const old = readExperience(join(cwd, ".pi", "harness", "library", "demo", "old"));
		expect(old?.superseded).toContain("by new");
		// auditability: the old lesson stays on disk with its evidence intact
		expect(old?.lesson).toBe("re-read the edited file");

		const { lessons } = loadLessons(cwd, cfg, "demo", "verifier after every edit");
		expect(lessons.length).toBe(1);
		expect(lessons[0]).toContain("### new");

		expect(readIndex(cwd, cfg, "demo")).toContain("superseded");
	});

	test("different cues never supersede; both lessons stay served", () => {
		const cwd = makeRepo();
		writeLessonIfValid(cwd, cfg, {
			domain: "demo",
			slug: "wifi",
			experience: lesson("wi-fi drops after suspend resume", "reload iwlwifi"),
		});
		writeLessonIfValid(cwd, cfg, {
			domain: "demo",
			slug: "auth",
			experience: lesson("login endpoint needs rate limit headers", "add the limiter"),
		});
		expect(readExperience(join(cwd, ".pi", "harness", "library", "demo", "wifi"))?.superseded).toBeUndefined();
		expect(loadLessons(cwd, cfg, "demo", "anything at all").lessons.length).toBe(2);
	});

	test("re-adopting the same slug never self-supersedes", () => {
		const cwd = makeRepo();
		const cue = "run the verifier after every edit";
		writeLessonIfValid(cwd, cfg, { domain: "demo", slug: "stable", experience: lesson(cue, "v1") });
		writeLessonIfValid(cwd, cfg, { domain: "demo", slug: "stable", experience: lesson(cue, "v2") });
		const exp = readExperience(join(cwd, ".pi", "harness", "library", "demo", "stable"));
		expect(exp?.superseded).toBeUndefined();
		expect(exp?.lesson).toBe("v2");
	});
});
