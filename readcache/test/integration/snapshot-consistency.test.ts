import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type AgentToolResult, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyPatch } from "diff";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashText, loadObject } from "../../src/object-store.js";
import { createReadOverrideTool } from "../../src/tool.js";
import type { ReadToolDetailsExt } from "../../src/types.js";

const hooks = vi.hoisted(() => ({ afterBaseline: undefined as (() => Promise<void>) | undefined }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		createReadTool: (...args: Parameters<typeof actual.createReadTool>) => {
			const tool = actual.createReadTool(...args);
			if (args[1]?.operations) return tool;
			return {
				...tool,
				execute: async (...params: Parameters<typeof tool.execute>) => {
					const result = await tool.execute(...params);
					await hooks.afterBaseline?.();
					return result;
				},
			};
		},
	};
});

afterEach(() => { hooks.afterBaseline = undefined; });

function appendResult(ctx: ExtensionContext, result: AgentToolResult<ReadToolDetailsExt | undefined>) {
	(ctx.sessionManager as SessionManager).appendMessage({
		role: "toolResult", toolCallId: "read", toolName: "read", content: result.content,
		details: result.details, isError: false, timestamp: Date.now(),
	});
}

describe("integration: snapshot consistency", () => {
	it.each([false, true])("renders the same snapshot it hashes when a file changes during a read (bypass=%s)", async (bypass_cache) => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-snapshot-"));
		const path = join(cwd, "sample.txt");
		await writeFile(path, "old version\nnever trust as new");
		const current = "new version\nactually shown";
		hooks.afterBaseline = () => writeFile(path, current);
		const ctx = { cwd, sessionManager: SessionManager.inMemory(cwd) } as unknown as ExtensionContext;
		const tool = createReadOverrideTool();
		const result = await tool.execute("race", { path, bypass_cache }, undefined, undefined, ctx);
		expect(result.content).toEqual([{ type: "text", text: current }]);
		expect(result.details?.readcache?.servedHash).toBe(hashText(current));
		appendResult(ctx, result);
		hooks.afterBaseline = undefined;
		const again = await tool.execute("again", { path }, undefined, undefined, ctx);
		expect(again.details?.readcache?.mode).toBe("unchanged");
	});

	it("uses snapshot truncation coverage if the file grows during a read", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-snapshot-growth-"));
		const path = join(cwd, "sample.txt");
		await writeFile(path, "old short version");
		const lines = Array.from({ length: 320 }, (_, index) => `new line ${index + 1}: ${"é".repeat(220)}`);
		hooks.afterBaseline = () => writeFile(path, lines.join("\n"));
		const ctx = { cwd, sessionManager: SessionManager.inMemory(cwd) } as unknown as ExtensionContext;
		const tool = createReadOverrideTool();
		const result = await tool.execute("growth", { path }, undefined, undefined, ctx);
		expect(result.details?.truncation?.truncated).toBe(true);
		const shown = result.details!.truncation!.outputLines;
		expect(result.details?.readcache?.scopeKey).toBe(`r:1:${shown}`);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining(lines[0]!) });
		hooks.afterBaseline = undefined;
		const tail = await tool.execute("tail", { path, offset: shown + 1, limit: 1 }, undefined, undefined, ctx);
		expect(tail.details?.readcache?.mode).toBe("full");
		expect(tail.content[0]).toMatchObject({ text: expect.stringContaining(lines[shown]!) });
	});

	it("renders a consistent snapshot on changed-content fallback", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-snapshot-fallback-"));
		const path = join(cwd, "sample.txt");
		await writeFile(path, "original anchor");
		const ctx = { cwd, sessionManager: SessionManager.inMemory(cwd) } as unknown as ExtensionContext;
		const tool = createReadOverrideTool();
		const anchor = await tool.execute("anchor", { path }, undefined, undefined, ctx);
		appendResult(ctx, anchor);
		await writeFile(path, "intermediate version");
		hooks.afterBaseline = () => writeFile(path, "final version");
		const result = await tool.execute("fallback", { path }, undefined, undefined, ctx);
		expect(result.details?.readcache?.mode).toBe("baseline_fallback");
		expect(result.content).toEqual([{ type: "text", text: "final version" }]);
		expect(result.details?.readcache?.servedHash).toBe(hashText("final version"));
	});

	it("preserves UTF-8 BOM bytes in stored anchors and patch roundtrips", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-snapshot-bom-"));
		const path = join(cwd, "sample.txt");
		const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}: original payload`);
		const initial = `\uFEFF${lines.join("\n")}\n`;
		await writeFile(path, initial);
		const ctx = { cwd, sessionManager: SessionManager.inMemory(cwd) } as unknown as ExtensionContext;
		const tool = createReadOverrideTool();
		const first = await tool.execute("bom", { path }, undefined, undefined, ctx);
		appendResult(ctx, first);
		expect(await loadObject(cwd, first.details!.readcache!.servedHash)).toBe(initial);
		lines[0] = "changed first line";
		const current = `\uFEFF${lines.join("\n")}\n`;
		await writeFile(path, current);
		const changed = await tool.execute("bom-change", { path }, undefined, undefined, ctx);
		expect(changed.details?.readcache?.mode).toBe("diff");
		const block = changed.content[0];
		if (block?.type !== "text") throw new Error("Expected patch text");
		expect(applyPatch(initial, block.text.split("\n").slice(1).join("\n"))).toBe(current);
	});
});
