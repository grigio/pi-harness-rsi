import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	captureIdentity,
	continuityPrompt,
	describeIdentity,
	requestsReplacement,
	subjectDrift,
	subjectTokens,
} from "../src/continuity";

function project(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "rsi-continuity-"));
	for (const [name, content] of Object.entries(files)) {
		const path = join(dir, name);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content);
	}
	return dir;
}

const heartHtml = `<!doctype html><html><head><title>Three.js Color Changing Heart</title></head>
<body><h1>Heart</h1><script>three.js</script></body></html>`;

const solarHtml = `<!doctype html><html><head><title>Interactive 3D Solar System</title></head>
<body><h1>Solar System</h1><script>three.js</script></body></html>`;

describe("project continuity (src/continuity.ts)", () => {
	test("subject tokens drop medium words, so a restyle is not a replacement", () => {
		expect(subjectTokens("Three.js Color Changing Heart")).toEqual(["color", "changing", "heart"]);
		expect(subjectTokens("Interactive 3D Solar System")).toEqual(["solar", "system"]);
	});

	test("identity is read from the files that name the project", () => {
		const dir = project({
			"index.html": heartHtml,
			"package.json": JSON.stringify({ name: "@acme/color-heart" }),
			"README.md": "# Color heart demo\n",
		});
		const identity = captureIdentity(dir);
		const kinds = identity.labels.map((label) => `${label.source}:${label.kind}`);
		expect(kinds).toContain("index.html:entrypoint-title");
		expect(kinds).toContain("index.html:entrypoint-heading");
		expect(kinds).toContain("package.json:metadata-name");
		expect(kinds).toContain("README.md:readme-heading");
		expect(describeIdentity(identity)).toContain("Color Changing Heart");
	});

	test("identity is ecosystem-agnostic (any manifest name, not just web)", () => {
		const rustBefore = captureIdentity(project({ "Cargo.toml": '[package]\nname = "inventory-service"\n' }));
		const rustAfter = captureIdentity(project({ "Cargo.toml": '[package]\nname = "analytics-dashboard"\n' }));
		expect(subjectDrift(rustBefore, rustAfter)).toContain("changed subject");

		const py = captureIdentity(project({ "pyproject.toml": '[project]\nname = "inventory-service"\n' }));
		expect(describeIdentity(py)).toContain("inventory-service");
	});

	test("replacing the subject is drift", () => {
		const before = captureIdentity(project({ "index.html": heartHtml }));
		const after = captureIdentity(project({ "index.html": solarHtml }));
		const drift = subjectDrift(before, after);
		expect(drift).toBeDefined();
		expect(drift).toContain("index.html");
		expect(drift).toContain("Heart");
		expect(drift).toContain("Solar System");
	});

	test("improving the same subject is not drift", () => {
		const before = captureIdentity(project({ "index.html": heartHtml }));
		const after = captureIdentity(
			project({
				"index.html": `<!doctype html><html><head><title>Interactive 3D Heart — Deluxe</title></head>
				<body><h1>Glowing Heart</h1></body></html>`,
			}),
		);
		expect(subjectDrift(before, after)).toBeUndefined();
	});

	test("deleting the file that named the project is drift", () => {
		const before = captureIdentity(project({ "index.html": heartHtml }));
		const after = captureIdentity(project({ "notes.txt": "hello" }));
		expect(subjectDrift(before, after)).toContain("no longer names the project");
	});

	test("a project with no explicit label cannot drift", () => {
		const before = captureIdentity(project({ "src/lib.ts": "export const x = 1;\n" }));
		const after = captureIdentity(project({ "src/lib.ts": "export const y = 2;\n" }));
		expect(subjectDrift(before, after)).toBeUndefined();
	});

	test("the solver is told to continue, not replace — unless --replace is explicit", () => {
		const identity = captureIdentity(project({ "index.html": heartHtml }));
		const guarded = continuityPrompt(identity, false);
		expect(guarded).toContain("already exists");
		expect(guarded).toContain("do not replace its subject");
		expect(guarded).toContain("Heart");
		expect(guarded).toContain("fails the run");

		const replace = continuityPrompt(identity, true);
		expect(replace).toContain("explicitly allowed");
		expect(replace).not.toContain("do not replace");
	});

	test("task wording is pre-flighted for explicit replacements", () => {
		// Regression wording from the incident, plus the generic forms.
		const web = captureIdentity(project({ "index.html": heartHtml }));
		expect(requestsReplacement("Turn index.html into a different demo", web)).toBe("turn the project into …");
		expect(requestsReplacement("turn the project into a CLI", web)).toBe("turn the project into …");
		expect(requestsReplacement("build a new app in this directory")).toBe("create a new project");
		expect(requestsReplacement("start a new project")).toBe("create a new project");
		expect(requestsReplacement("rewrite the page as a dashboard", web)).toBe("rewrite the project");
		expect(requestsReplacement("start over with a different layout")).toBe("start over");

		// Incremental work on the existing project is not a replacement.
		expect(requestsReplacement("improve the heart demo: make clicks cycle colors")).toBeUndefined();
		expect(requestsReplacement("keep the current subject and add a starfield behind it")).toBeUndefined();
		expect(requestsReplacement("rewrite the failing test helper")).toBeUndefined();
		expect(requestsReplacement("create a new test for the colour cycle")).toBeUndefined();
		// "turn … into" only fires when the object is the project or its artifact.
		expect(requestsReplacement("turn the flaky test into a deterministic one")).toBeUndefined();
	});
});
