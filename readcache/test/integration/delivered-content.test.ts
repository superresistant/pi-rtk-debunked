import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool, SessionManager, type AgentToolResult, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createReadOverrideTool } from "../../src/tool.js";
import type { ReadToolDetailsExt } from "../../src/types.js";

function appendResult(session: SessionManager, result: AgentToolResult<ReadToolDetailsExt | undefined>) {
	session.appendMessage({
		role: "toolResult", toolCallId: "read", toolName: "read", content: result.content,
		details: result.details, isError: false, timestamp: Date.now(),
	});
}

describe("integration: delivered content", () => {
	it.each(["full", "range", "diff", "baseline_fallback", "unchanged"])("re-anchors after middleware replaces a successful %s result", async (mode) => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-delivered-"));
		const path = join(cwd, "sample.txt");
		const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}: original payload`);
		await writeFile(path, lines.join("\n"));
		const session = SessionManager.inMemory(cwd);
		const ctx = { cwd, sessionManager: session } as unknown as ExtensionContext;
		const tool = createReadOverrideTool();
		const params = mode === "range" ? { path, offset: 5, limit: 5 } : { path };
		let result = await tool.execute("initial", params, undefined, undefined, ctx);
		if (mode !== "full" && mode !== "range") {
			appendResult(session, result);
			if (mode === "diff") {
				lines[20] = "changed payload";
				await writeFile(path, lines.join("\n"));
			}
			if (mode === "baseline_fallback") await writeFile(path, "replacement file");
			result = await tool.execute("target", params, undefined, undefined, ctx);
		}
		expect(result.details?.readcache?.mode).toBe(mode === "range" ? "full" : mode);
		appendResult(session, { ...result, content: [{ type: "text", text: "[content removed by middleware]" }] });
		const next = await tool.execute("next", params, undefined, undefined, ctx);
		expect(next.details?.readcache?.mode).toBe("full");
		const baseline = await createReadTool(cwd).execute("baseline", params);
		expect(next.content).toEqual(baseline.content);
	});

	it("does not trust an empty successful result or an unverified historical result", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-missing-content-"));
		const path = join(cwd, "sample.txt");
		await writeFile(path, "never shown");
		for (const historical of [false, true]) {
			const session = SessionManager.inMemory(cwd);
			const ctx = { cwd, sessionManager: session } as unknown as ExtensionContext;
			const first = await createReadOverrideTool().execute("first", { path }, undefined, undefined, ctx);
			const meta = { ...first.details!.readcache! };
			if (historical) delete (meta as { outputHash?: string }).outputHash;
			appendResult(session, { ...first, content: historical ? first.content : [], details: { readcache: meta } });
			const next = await createReadOverrideTool().execute("next", { path }, undefined, undefined, ctx);
			expect(next.details?.readcache?.mode).toBe("full");
			expect(next.content).toEqual([{ type: "text", text: "never shown" }]);
		}
	});

	it("does not suppress reads using results that have not committed to the session", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-readcache-uncommitted-"));
		const path = join(cwd, "sample.txt");
		await writeFile(path, "must be shown");
		const session = SessionManager.inMemory(cwd);
		const ctx = { cwd, sessionManager: session } as unknown as ExtensionContext;
		const tool = createReadOverrideTool();
		await tool.execute("discarded", { path }, undefined, undefined, ctx);
		const second = await tool.execute("second", { path }, undefined, undefined, ctx);
		expect(second.details?.readcache?.mode).toBe("full");
		expect(second.content).toEqual([{ type: "text", text: "must be shown" }]);
		appendResult(session, second);
		const third = await tool.execute("third", { path }, undefined, undefined, ctx);
		expect(third.details?.readcache?.mode).toBe("unchanged");
	});
});
