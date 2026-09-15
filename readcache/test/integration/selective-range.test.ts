import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SessionManager,
	type AgentToolResult,
	type ExtensionContext,
	type ReadToolDetails,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createReplayRuntimeState } from "../../src/replay.js";
import { createReadOverrideTool } from "../../src/tool.js";
import type { ReadToolDetailsExt } from "../../src/types.js";

function asContext(cwd: string, sessionManager: SessionManager): ExtensionContext {
	return {
		cwd,
		sessionManager,
	} as unknown as ExtensionContext;
}

function appendReadResult(
	sessionManager: SessionManager,
	toolCallId: string,
	result: AgentToolResult<ReadToolDetailsExt | undefined>,
): string {
	return sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: Date.now(),
	});
}

function getText(result: AgentToolResult<ReadToolDetails | undefined>): string {
	const block = result.content.find((content) => content.type === "text");
	if (!block || block.type !== "text") {
		throw new Error("Expected text content in read result");
	}
	return block.text;
}

describe("integration: selective range behavior", () => {
	it.each([
		{ name: "byte limit", total: 320, width: 220, offset: 1, limit: 320, bypass_cache: false },
		{ name: "line limit", total: 2200, width: 1, offset: 1, limit: 2200, bypass_cache: false },
		{ name: "offset range", total: 320, width: 220, offset: 31, limit: 220, bypass_cache: false },
		{ name: "bypassed byte limit", total: 320, width: 220, offset: 1, limit: 320, bypass_cache: true },
	])("trusts only emitted lines after $name truncation, live and on replay", async (fixture) => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-truncated-"));
		const lines = Array.from({ length: fixture.total }, (_, index) => `line ${index + 1}: ${"é".repeat(fixture.width)}`);
		await writeFile(join(cwd, "sample.txt"), lines.join("\n"), "utf-8");
		const sessionManager = SessionManager.inMemory(cwd);
		const ctx = asContext(cwd, sessionManager);
		const tool = createReadOverrideTool();
		const params = { path: "sample.txt", offset: fixture.offset, limit: fixture.limit, bypass_cache: fixture.bypass_cache };
		const first = await tool.execute("truncated", params, undefined, undefined, ctx);
		expect(first.details?.truncation?.truncated).toBe(true);
		const shown = first.details!.truncation!.outputLines;
		const nextLine = fixture.offset + shown;
		expect(getText(first)).not.toContain(lines[nextLine - 1]);

		const tailParams = { path: "sample.txt", offset: nextLine, limit: 1 };
		const liveTail = await tool.execute("live-tail", tailParams, undefined, undefined, ctx);
		expect(getText(liveTail)).toContain(lines[nextLine - 1]);
		expect(liveTail.details?.readcache?.mode).toBe("full");
		expect(first.details?.readcache).toMatchObject({
			scopeKey: `r:${fixture.offset}:${nextLine - 1}`,
			rangeStart: fixture.offset,
			rangeEnd: nextLine - 1,
		});

		appendReadResult(sessionManager, "truncated", first);
		const resumedTool = createReadOverrideTool();
		const replayTail = await resumedTool.execute("replay-tail", tailParams, undefined, undefined, ctx);
		expect(getText(replayTail)).toContain(lines[nextLine - 1]);
		expect(replayTail.details?.readcache?.mode).toBe("full");
		const covered = await resumedTool.execute("covered", {
			path: "sample.txt", offset: fixture.offset, limit: shown,
		}, undefined, undefined, ctx);
		expect(covered.details?.readcache?.mode).toBe("unchanged_range");
		const repeated = await resumedTool.execute("repeat", { ...params, bypass_cache: false }, undefined, undefined, ctx);
		expect(getText(repeated)).toContain(lines[fixture.offset - 1]);
		expect(repeated.details?.truncation?.truncated).toBe(true);
	});

	it("does not grant full trust after a truncated baseline fallback", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-truncated-fallback-"));
		const path = join(cwd, "sample.txt");
		const lines = Array.from({ length: 320 }, (_, index) => `line ${index + 1}`);
		await writeFile(path, lines.join("\n"), "utf-8");
		const sessionManager = SessionManager.inMemory(cwd);
		const ctx = asContext(cwd, sessionManager);
		const tool = createReadOverrideTool();
		const first = await tool.execute("initial", { path }, undefined, undefined, ctx);
		appendReadResult(sessionManager, "initial", first);
		const changed = lines.map((line) => `${line}: ${"é".repeat(220)}`);
		await writeFile(path, changed.join("\n"), "utf-8");
		const fallback = await tool.execute("fallback", { path }, undefined, undefined, ctx);
		expect(fallback.details?.readcache?.mode).toBe("baseline_fallback");
		expect(fallback.details?.truncation?.truncated).toBe(true);
		const nextLine = fallback.details!.truncation!.outputLines + 1;
		const tailParams = { path, offset: nextLine, limit: 1 };
		const tail = await tool.execute("tail", tailParams, undefined, undefined, ctx);
		expect(getText(tail)).toContain(changed[nextLine - 1]);
		appendReadResult(sessionManager, "fallback", fallback);
		const replayTail = await createReadOverrideTool().execute("replay-tail", tailParams, undefined, undefined, ctx);
		expect(getText(replayTail)).toContain(changed[nextLine - 1]);
	});

	it("repairs legacy overclaimed coverage without trusting its dependent markers", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-legacy-truncated-"));
		const lines = Array.from({ length: 320 }, (_, index) => `line ${index + 1}: ${"é".repeat(220)}`);
		await writeFile(join(cwd, "sample.txt"), lines.join("\n"), "utf-8");
		const sessionManager = SessionManager.inMemory(cwd);
		const ctx = asContext(cwd, sessionManager);
		const first = await createReadOverrideTool().execute("legacy", { path: "sample.txt" }, undefined, undefined, ctx);
		const nextLine = first.details!.truncation!.outputLines + 1;
		const meta = { ...first.details!.readcache!, scopeKey: "full" as const, rangeEnd: lines.length };
		appendReadResult(sessionManager, "legacy", { ...first, details: { ...first.details, readcache: meta } });
		appendReadResult(sessionManager, "bad-full-marker", {
			content: [{ type: "text", text: "[readcache: unchanged]" }],
			details: { readcache: { ...meta, mode: "unchanged", baseHash: meta.servedHash } },
		});
		appendReadResult(sessionManager, "bad-range-marker", {
			content: [{ type: "text", text: "[readcache: unchanged]" }],
			details: { readcache: { ...meta, mode: "unchanged_range", baseHash: meta.servedHash,
				scopeKey: `r:${nextLine}:${nextLine}`, rangeStart: nextLine, rangeEnd: nextLine } },
		});
		const replayTool = createReadOverrideTool();
		const tail = await replayTool.execute("tail", { path: "sample.txt", offset: nextLine, limit: 1 }, undefined, undefined, ctx);
		expect(getText(tail)).toContain(lines[nextLine - 1]);
		expect(tail.details?.readcache?.mode).toBe("full");
		const covered = await replayTool.execute("covered", { path: "sample.txt", limit: nextLine - 1 }, undefined, undefined, ctx);
		expect(covered.details?.readcache?.mode).toBe("unchanged_range");
	});

	it.each([false, true])("grants no trust when the first line exceeds the byte limit (bypass=%s)", async (bypass_cache) => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-longline-"));
		await writeFile(join(cwd, "sample.txt"), `${"x".repeat(52000)}\nnever shown`, "utf-8");
		const sessionManager = SessionManager.inMemory(cwd);
		const ctx = asContext(cwd, sessionManager);
		const tool = createReadOverrideTool();
		const first = await tool.execute("longline", { path: "sample.txt", bypass_cache }, undefined, undefined, ctx);
		expect(first.details?.truncation?.outputLines).toBe(0);
		expect(first.details?.readcache).toBeUndefined();
		const tailParams = { path: "sample.txt", offset: 2, limit: 1 };
		const tail = await tool.execute("tail", tailParams, undefined, undefined, ctx);
		expect(getText(tail)).toBe("never shown");
		appendReadResult(sessionManager, "longline", first);
		const replayTail = await createReadOverrideTool().execute("replay-tail", tailParams, undefined, undefined, ctx);
		expect(getText(replayTail)).toBe("never shown");
	});

	it("returns baseline slice on the first range read and unchanged_range on the second", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-range-"));
		const filePath = join(cwd, "sample.txt");
		const initialLines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
		await writeFile(filePath, initialLines.join("\n"), "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
		const tool = createReadOverrideTool(createReplayRuntimeState());
		const ctx = asContext(cwd, sessionManager);

		const firstRangeRead = await tool.execute("call-range-first", { path: "sample.txt:3-5" }, undefined, undefined, ctx);
		expect(firstRangeRead.details?.readcache?.mode).toBe("full");
		expect(getText(firstRangeRead)).toContain("line 3");
		expect(getText(firstRangeRead)).toContain("line 5");
		appendReadResult(sessionManager, "call-range-first", firstRangeRead);

		const secondRangeRead = await tool.execute(
			"call-range-second",
			{ path: "sample.txt:3-5" },
			undefined,
			undefined,
			ctx,
		);
		expect(secondRangeRead.details?.readcache?.mode).toBe("unchanged_range");
		expect(getText(secondRangeRead)).toContain("[readcache: unchanged in lines 3-5 of 12]");
	});

	it("keeps unchanged_range for outside edits and falls back when the requested range changed", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-range-"));
		const filePath = join(cwd, "sample.txt");
		const initialLines = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`);
		await writeFile(filePath, initialLines.join("\n"), "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
		const tool = createReadOverrideTool(createReplayRuntimeState());
		const ctx = asContext(cwd, sessionManager);

		const fullRead = await tool.execute("call-full", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(fullRead.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "call-full", fullRead);

		const firstRangeRead = await tool.execute("call-range-1", { path: "sample.txt:160-249" }, undefined, undefined, ctx);
		expect(firstRangeRead.details?.readcache?.mode).toBe("unchanged_range");
		appendReadResult(sessionManager, "call-range-1", firstRangeRead);

		const editedLines = [...initialLines];
		editedLines[299] = "line 300 updated";
		await writeFile(filePath, editedLines.join("\n"), "utf-8");

		const unchangedRange = await tool.execute("call-range-2", { path: "sample.txt:160-249" }, undefined, undefined, ctx);
		expect(unchangedRange.details?.readcache?.mode).toBe("unchanged_range");
		expect(getText(unchangedRange)).toContain("changes exist outside this range");
		appendReadResult(sessionManager, "call-range-2", unchangedRange);

		const changedRange = await tool.execute("call-range-3", { path: "sample.txt:100-349" }, undefined, undefined, ctx);
		expect(changedRange.details?.readcache?.mode).toBe("baseline_fallback");
		expect(getText(changedRange)).toContain("line 300 updated");
	});

	it("treats line insertions before a requested range as range-changed fallback", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-range-"));
		const filePath = join(cwd, "sample.txt");
		const initialLines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
		await writeFile(filePath, initialLines.join("\n"), "utf-8");

		const sessionManager = SessionManager.inMemory(cwd);
		const tool = createReadOverrideTool(createReplayRuntimeState());
		const ctx = asContext(cwd, sessionManager);

		const firstRead = await tool.execute("call-insert-1", { path: "sample.txt" }, undefined, undefined, ctx);
		expect(firstRead.details?.readcache?.mode).toBe("full");
		appendReadResult(sessionManager, "call-insert-1", firstRead);

		const shifted = ["inserted header line", ...initialLines];
		await writeFile(filePath, shifted.join("\n"), "utf-8");

		const shiftedRangeRead = await tool.execute(
			"call-insert-2",
			{ path: "sample.txt:100-120" },
			undefined,
			undefined,
			ctx,
		);
		expect(shiftedRangeRead.details?.readcache?.mode).toBe("baseline_fallback");
		expect(getText(shiftedRangeRead)).toContain("line 99");
	});
});
