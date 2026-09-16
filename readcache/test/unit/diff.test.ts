import { applyPatch } from "diff";
import { describe, expect, it } from "vitest";
import { computeUnifiedDiff, isDiffUseful } from "../../src/diff.js";

describe("diff", () => {
	it("computes deterministic unified diffs for full-scope changes", () => {
		const baseText = ["line 1", "line 2", "line 3"].join("\n");
		const currentText = ["line 1", "line 2 updated", "line 3"].join("\n");

		const diff = computeUnifiedDiff(baseText, currentText, "sample.txt");
		expect(diff).toBeDefined();
		expect(diff?.diffText).toContain("--- a/sample.txt");
		expect(diff?.diffText).toContain("+++ b/sample.txt");
		expect(diff?.diffText).toContain("@@ -1,3 +1,3 @@");
		expect(diff?.diffText).toContain("-line 2");
		expect(diff?.diffText).toContain("+line 2 updated");
		expect(diff?.changedLines).toBe(1);
		expect(diff?.diffText.startsWith("===")).toBe(false);
	});

	it.each([
		{ name: "blank trailing context", blankContext: true, replacement: "changed", newline: "\n", finalNewline: true },
		{ name: "trailing spaces", blankContext: false, replacement: "after  ", newline: "\n", finalNewline: true },
		{ name: "trailing tab", blankContext: false, replacement: "after\t", newline: "\n", finalNewline: true },
		{ name: "CRLF", blankContext: false, replacement: "after  ", newline: "\r\n", finalNewline: true },
		{ name: "missing final newline", blankContext: false, replacement: "after  ", newline: "\n", finalNewline: false },
	])("preserves $name in useful patch roundtrips", (fixture) => {
		const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}: original content payload`);
		if (fixture.blankContext) lines.splice(27, 3, "", "", "");
		const ending = fixture.finalNewline ? fixture.newline : "";
		const baseText = lines.join(fixture.newline) + ending;
		lines[fixture.blankContext ? 26 : 29] = fixture.replacement;
		const currentText = lines.join(fixture.newline) + ending;
		const diff = computeUnifiedDiff(baseText, currentText, "sample.txt")!;
		expect(isDiffUseful(diff.diffText, baseText, currentText)).toBe(true);
		expect(applyPatch(baseText, diff.diffText)).toBe(currentText);
	});

	it("counts changed content that resembles patch file headers", () => {
		const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}: original payload`);
		lines[15] = "--old content";
		const baseText = lines.join("\n");
		lines[15] = "++new content";
		const currentText = lines.join("\n");
		const diff = computeUnifiedDiff(baseText, currentText, "sample.txt")!;
		expect(isDiffUseful(diff.diffText, baseText, currentText)).toBe(true);
		expect(applyPatch(baseText, diff.diffText)).toBe(currentText);
		expect(diff).toMatchObject({ addedLines: 1, removedLines: 1, changedLines: 1 });
	});

	it("returns undefined when there are no line-level hunks", () => {
		const diff = computeUnifiedDiff("same\ntext", "same\ntext", "sample.txt");
		expect(diff).toBeUndefined();
	});

	it("gates diff usefulness by size ratio and file thresholds", () => {
		const usefulDiff = computeUnifiedDiff("a\nb\nc", "a\nB\nc", "sample.txt");
		expect(usefulDiff).toBeDefined();
		expect(
			isDiffUseful(usefulDiff?.diffText ?? "", "a\nb\nc", "a\nB\nc", {
				maxFileBytes: 1024,
				maxFileLines: 100,
				maxDiffToBaseRatio: 100,
				maxDiffToBaseLineRatio: 100,
			}),
		).toBe(true);

		const notUsefulByRatio = isDiffUseful("@@\n" + "x".repeat(200), "small", "small", {
			maxFileBytes: 1024,
			maxFileLines: 100,
			maxDiffToBaseRatio: 1,
			maxDiffToBaseLineRatio: 100,
		});
		expect(notUsefulByRatio).toBe(false);

		const notUsefulByLineRatio = isDiffUseful("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b", "a", "b", {
			maxFileBytes: 1024,
			maxFileLines: 100,
			maxDiffToBaseRatio: 100,
			maxDiffToBaseLineRatio: 1,
		});
		expect(notUsefulByLineRatio).toBe(false);

		const notUsefulByLineLimit = isDiffUseful("@@ -1 +1 @@\n-a\n+b", "a\n".repeat(200), "b\n".repeat(200), {
			maxFileBytes: 1024 * 1024,
			maxFileLines: 50,
			maxDiffToBaseRatio: 2,
			maxDiffToBaseLineRatio: 100,
		});
		expect(notUsefulByLineLimit).toBe(false);
	});
});
