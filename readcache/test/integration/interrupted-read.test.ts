import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearReplayRuntimeState, createReplayRuntimeState } from "../../src/replay.js";
import { createReadOverrideTool } from "../../src/tool.js";

const hooks = vi.hoisted(() => ({ onPersist: undefined as (() => Promise<void>) | undefined }));
vi.mock("../../src/object-store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/object-store.js")>();
	return {
		...actual,
		persistObjectIfAbsent: async (...args: Parameters<typeof actual.persistObjectIfAbsent>) => {
			await hooks.onPersist?.();
			return actual.persistObjectIfAbsent(...args);
		},
	};
});

afterEach(() => { hooks.onPersist = undefined; });

function pausePersistence() {
	let reached!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { reached = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	hooks.onPersist = async () => { reached(); await gate; };
	return { entered, release };
}

describe("integration: interrupted reads", () => {
	it.each(["abort", "reset", "session switch"])("does not grant trust after %s during persistence", async (interruption) => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-interrupted-"));
		const path = join(cwd, "sample.txt");
		await writeFile(path, "content never delivered");
		const runtime = createReplayRuntimeState();
		const values = { cwd, sessionManager: SessionManager.inMemory(cwd) };
		const ctx = values as unknown as ExtensionContext;
		const controller = new AbortController();
		const tool = createReadOverrideTool(runtime);
		const pause = pausePersistence();
		const pending = tool.execute("interrupted", { path }, controller.signal, undefined, ctx);
		await pause.entered;
		if (interruption === "abort") controller.abort();
		if (interruption === "reset") clearReplayRuntimeState(runtime);
		if (interruption === "session switch") values.sessionManager = SessionManager.inMemory(cwd);
		const rejection = expect(pending).rejects.toThrow(/aborted|invalidated/i);
		pause.release();
		await rejection;
		for (const overlay of runtime.overlayBySession.values()) expect(overlay.knowledge.size).toBe(0);
		hooks.onPersist = undefined;
		const next = await tool.execute("next", { path }, undefined, undefined, ctx);
		expect(next.details?.readcache?.mode).toBe("full");
		expect(next.content).toEqual([{ type: "text", text: "content never delivered" }]);
	});

	it("does not advance a diff anchor when its persistence is interrupted", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-interrupted-diff-"));
		const path = join(cwd, "sample.txt");
		const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}: original payload`);
		await writeFile(path, lines.join("\n"));
		const sessionManager = SessionManager.inMemory(cwd);
		const ctx = { cwd, sessionManager } as unknown as ExtensionContext;
		const tool = createReadOverrideTool();
		const first = await tool.execute("anchor", { path }, undefined, undefined, ctx);
		sessionManager.appendMessage({
			role: "toolResult", toolCallId: "anchor", toolName: "read",
			content: first.content, details: first.details, isError: false, timestamp: Date.now(),
		});
		lines[20] = "changed payload";
		await writeFile(path, lines.join("\n"));
		const pause = pausePersistence();
		const controller = new AbortController();
		const pending = tool.execute("interrupted-diff", { path }, controller.signal, undefined, ctx);
		await pause.entered;
		controller.abort();
		const rejection = expect(pending).rejects.toThrow(/aborted/i);
		pause.release();
		await rejection;
		hooks.onPersist = undefined;
		const next = await tool.execute("next", { path }, undefined, undefined, ctx);
		expect(next.details?.readcache?.mode).toBe("diff");
	});

	it("allows ordinary leaf advancement while a successful read is pending", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-pending-leaf-"));
		const path = join(cwd, "sample.txt");
		await writeFile(path, "delivered content");
		const sessionManager = SessionManager.inMemory(cwd);
		const ctx = { cwd, sessionManager } as unknown as ExtensionContext;
		const tool = createReadOverrideTool();
		const pause = pausePersistence();
		const pending = tool.execute("pending", { path }, undefined, undefined, ctx);
		await pause.entered;
		sessionManager.appendMessage({
			role: "toolResult", toolCallId: "parallel", toolName: "bash",
			content: [{ type: "text", text: "other tool completed" }], isError: false, timestamp: Date.now(),
		});
		pause.release();
		const result = await pending;
		expect(result.details?.readcache?.mode).toBe("full");
		expect(result.content).toEqual([{ type: "text", text: "delivered content" }]);
		sessionManager.appendMessage({
			role: "toolResult", toolCallId: "pending", toolName: "read",
			content: result.content, details: result.details, isError: false, timestamp: Date.now(),
		});
		hooks.onPersist = undefined;
		const next = await createReadOverrideTool().execute("next", { path }, undefined, undefined, ctx);
		expect(next.details?.readcache?.mode).toBe("unchanged");
	});
});
