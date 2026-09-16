import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createAgentSession, createBashTool, createReadTool, DefaultResourceLoader, ModelRuntime,
	SessionManager, SettingsManager, type AgentSession, type ExtensionError, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { applyPatch } from "diff";
import { afterEach, describe, expect, it } from "vitest";
import type { ReadToolDetailsExt } from "../../src/types.js";

type Stream = Awaited<ReturnType<AgentSession["agent"]["streamFunction"]>>;
type Assistant = Awaited<ReturnType<Stream["result"]>>;
type ToolResult = Extract<AgentSession["messages"][number], { role: "toolResult" }>;
const packageRoot = resolve(__dirname, "../../..");
const model: NonNullable<AgentSession["model"]> = {
	id: "scripted-boundary", name: "scripted-boundary", api: "openai-completions", provider: "openai",
	baseUrl: "http://invalid.invalid", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function metadata(result: ToolResult) {
	return (result.details as ReadToolDetailsExt | undefined)?.readcache;
}

async function fixture(extension?: ExtensionFactory) {
	const root = await mkdtemp(join(tmpdir(), "pi-runtime-boundary-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const sessions: AgentSession[] = [];
	cleanups.push(async () => {
		for (const session of sessions) session.dispose();
		await rm(root, { recursive: true, force: true });
	});
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(cwd, ".pi", "rtk-config.json"), JSON.stringify({ enabled: true, techniques: { ansiStripping: true } }));
	const errors: ExtensionError[] = [];
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false,
	});
	let serial = 0;
	async function open(manager = SessionManager.create(cwd, sessionDir)) {
		const settingsManager = SettingsManager.inMemory({
			packages: [packageRoot], compaction: { enabled: false }, retry: { enabled: false },
		});
		const loader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true,
			noContextFiles: true, ...(extension ? { extensionFactories: [extension] } : {}),
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		const { session } = await createAgentSession({
			cwd, agentDir, modelRuntime, model, thinkingLevel: "off", settingsManager,
			resourceLoader: loader, sessionManager: manager, tools: ["read", "bash", "readcache_refresh"],
		});
		sessions.push(session);
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		// Only assistant output is scripted; Pi executes, intercepts and persists every tool result.
		let queued: Assistant["content"] | undefined;
		let calls = 0;
		session.agent.streamFunction = () => {
			if (++calls > 2) throw new Error("Unexpected extra assistant turn");
			const content = queued ?? [{ type: "text" as const, text: "done" }];
			queued = undefined;
			const stopReason = content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
			const message: Assistant = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id, content,
				stopReason,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now(),
			};
			const stream: Pick<Stream, typeof Symbol.asyncIterator | "result"> = {
				async *[Symbol.asyncIterator]() {
					yield { type: "done" as const, reason: stopReason, message };
				},
				result: async () => message,
			};
			return stream as Stream;
		};
		async function runBatch(requests: Array<{ name: string; args: Record<string, unknown> }>): Promise<ToolResult[]> {
			const ids = requests.map(() => `boundary-${++serial}`);
			queued = requests.map((request, index) => ({ type: "toolCall", id: ids[index]!, name: request.name, arguments: request.args }));
			calls = 0;
			await session.agent.prompt(`Execute ${ids.join(",")}`);
			expect(calls).toBe(2);
			expect(errors).toEqual([]);
			return ids.map((id) => {
				const result = session.messages.find((message): message is ToolResult => message.role === "toolResult" && message.toolCallId === id);
				if (!result) throw new Error(`Missing persisted result ${id}`);
				expect(result.isError).toBe(false);
				const persisted = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id);
				expect(persisted).toMatchObject({ type: "message", message: result });
				return result;
			});
		}
		async function run(name: string, args: Record<string, unknown>): Promise<ToolResult> {
			return (await runBatch([{ name, args }]))[0]!;
		}
		return { session, manager, loader, run, runBatch };
	}
	const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}: original payload α\t  `);
	const path = join(cwd, "sample.txt");
	await writeFile(path, lines.join("\n"));
	return { cwd, path, lines, sessionDir, errors, open, ...await open() };
}

describe("real Pi loader, tool middleware and persisted replay (scripted assistant, no inference)", () => {
	it("loads both package-manifest entrypoints and owns each tool/command once", async () => {
		const f = await fixture();
		const extensions = f.loader.getExtensions().extensions;
		expect(extensions.map((extension) => extension.resolvedPath).sort()).toEqual([
			join(packageRoot, "index.ts"), join(packageRoot, "readcache", "index.ts"),
		].sort());
		expect(extensions.flatMap((extension) => [...extension.tools.keys()]).sort()).toEqual(["read", "readcache_refresh"]);
		expect(extensions.flatMap((extension) => [...extension.commands.keys()]).sort()).toEqual([
			"readcache-refresh", "readcache-status", "rtk-clear", "rtk-off", "rtk-on", "rtk-stats", "rtk-toggle-ansiStripping", "rtk-what",
		].sort());
		expect(f.session.agent.state.tools.map((tool) => tool.name).sort()).toEqual(["bash", "read", "readcache_refresh"]);
		expect(f.session.agent.state.tools.find((tool) => tool.name === "read")?.executionMode).toBe("sequential");
		expect(f.session.extensionRunner.getCommandDiagnostics()).toEqual([]);
		expect(f.errors).toEqual([]);
	}, 20000);

	it("delivers exact reference text through full → unchanged → diff → refresh → full and bypass", async () => {
		const f = await fixture();
		const reference = await createReadTool(f.cwd).execute("reference", { path: f.path });
		const full = await f.run("read", { path: f.path });
		expect(metadata(full)?.mode).toBe("full");
		expect(full.content).toEqual(reference.content);
		const unchanged = await f.run("read", { path: f.path });
		expect(metadata(unchanged)?.mode).toBe("unchanged");
		expect(unchanged.content).toEqual([{ type: "text", text: "[readcache: unchanged, 60 lines]" }]);
		const original = f.lines.join("\n");
		f.lines[30] = "replacement β\t  ";
		const current = f.lines.join("\n");
		await writeFile(f.path, current);
		const diff = await f.run("read", { path: f.path });
		expect(metadata(diff)?.mode).toBe("diff");
		const block = diff.content[0];
		expect(block?.type).toBe("text");
		if (block?.type !== "text") throw new Error("Missing diff text");
		expect(block.text.split("\n")[0]).toBe("[readcache: 1 lines changed of 60]");
		expect(applyPatch(original, block.text.slice(block.text.indexOf("\n") + 1))).toBe(current);
		expect(metadata(await f.run("read", { path: f.path }))?.mode).toBe("unchanged");
		await f.run("readcache_refresh", { path: f.path });
		expect(f.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "pi-readcache")).toHaveLength(1);
		const refreshed = await f.run("read", { path: f.path });
		expect(metadata(refreshed)?.mode).toBe("full");
		const currentReference = await createReadTool(f.cwd).execute("reference", { path: f.path });
		expect(refreshed.content).toEqual(currentReference.content);
		const bypass = await f.run("read", { path: f.path, bypass_cache: true });
		expect(metadata(bypass)?.mode).toBe("full");
		expect(bypass.content).toEqual(currentReference.content);
	}, 20000);

	it("strips actual bash ANSI output without changing non-ANSI bytes", async () => {
		const f = await fixture();
		const command = "printf '\\033[31mred\\033[0m\\tβ  \\nplain\\n'";
		const raw = await createBashTool(f.cwd).execute("reference", { command });
		expect(raw.content).toEqual([{ type: "text", text: "\u001b[31mred\u001b[0m\tβ  \nplain\n" }]);
		const result = await f.run("bash", { command });
		expect(result.content).toEqual([{ type: "text", text: "red\tβ  \nplain\n" }]);
		expect(result.details).toEqual(raw.details);
	}, 20000);

	it.each(["full", "unchanged", "diff"] as const)("rejects replaced or dropped %s content despite surviving omitted details", async (mode) => {
		let replacement: ToolResult["content"] | undefined;
		let intercepted: unknown;
		const f = await fixture((pi) => {
			pi.on("tool_result", (event) => {
				if (event.toolName !== "read" || replacement === undefined) return;
				intercepted = structuredClone(event.details);
				return { content: replacement };
			});
		});
		let runtime = f;
		for (const content of [[{ type: "text" as const, text: "[middleware removed content]" }], []]) {
			replacement = undefined;
			await runtime.run("readcache_refresh", { path: f.path });
			if (mode !== "full") await runtime.run("read", { path: f.path });
			if (mode === "diff") {
				f.lines[30] += " changed";
				await writeFile(f.path, f.lines.join("\n"));
			}
			replacement = content;
			const changed = await runtime.run("read", { path: f.path });
			expect(metadata(changed)?.mode).toBe(mode);
			expect(changed.details).toEqual(intercepted);
			expect(changed.content).toEqual(content);
			replacement = undefined;
			const file = runtime.manager.getSessionFile();
			if (!file) throw new Error("Missing intercepted session file");
			runtime.session.dispose();
			runtime = { ...f, ...await f.open(SessionManager.open(file, f.sessionDir)) };
			const next = await runtime.run("read", { path: f.path });
			expect(metadata(next)?.mode).toBe("full");
			expect(next.content).toEqual((await createReadTool(f.cwd).execute("reference", { path: f.path })).content);
		}
	}, 20000);

	it("does not hide reversions when middleware removes readcache details", async () => {
		let removeDetails = false;
		const f = await fixture((pi) => {
			pi.on("tool_result", (event) => event.toolName === "read" && removeDetails ? { details: {} } : undefined);
		});
		const original = f.lines.join("\n");
		await f.run("read", { path: f.path });
		f.lines[30] = "visible changed content";
		await writeFile(f.path, f.lines.join("\n"));
		removeDetails = true;
		const changed = await f.run("read", { path: f.path });
		expect(changed.details).toEqual({});
		const block = changed.content[0];
		if (block?.type !== "text") throw new Error("Expected changed file output");
		expect(applyPatch(original, block.text.slice(block.text.indexOf("\n") + 1))).toBe(f.lines.join("\n"));
		removeDetails = false;
		await writeFile(f.path, original);
		const restored = await f.run("read", { path: f.path });
		expect(metadata(restored)?.mode).toBe("full");
		expect(restored.content).toEqual([{ type: "text", text: original }]);
	}, 20000);

	it("re-anchors text after the same path was displayed as an image", async () => {
		const f = await fixture();
		const original = f.lines.join("\n");
		await f.run("read", { path: f.path });
		await writeFile(f.path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5uS1QAAAAASUVORK5CYII=", "base64"));
		const image = await f.run("read", { path: f.path });
		expect(image.content).toEqual((await createReadTool(f.cwd).execute("reference", { path: f.path })).content);
		expect(metadata(image)).toBeUndefined();
		await writeFile(f.path, original);
		const restored = await f.run("read", { path: f.path });
		expect(metadata(restored)?.mode).toBe("full");
		expect(restored.content).toEqual([{ type: "text", text: original }]);
	}, 20000);

	it("re-anchors after reopening an actual compacted session context", async () => {
		const f = await fixture();
		await f.run("read", { path: f.path });
		const lastAssistant = f.manager.getLeafId();
		if (!lastAssistant) throw new Error("Missing assistant leaf");
		f.manager.appendCompaction("No file bytes retained", lastAssistant, 100);
		const file = f.manager.getSessionFile();
		if (!file) throw new Error("Missing compacted session file");
		f.session.dispose();
		const resumed = await f.open(SessionManager.open(file, f.sessionDir));
		expect(resumed.session.messages.some((message) => message.role === "toolResult" && message.toolName === "read")).toBe(false);
		const result = await resumed.run("read", { path: f.path });
		expect(metadata(result)?.mode).toBe("full");
		expect(result.content).toEqual((await createReadTool(f.cwd).execute("reference", { path: f.path })).content);
	}, 20000);

	it("does not hide a newer sibling observation behind an older marker in a parallel batch", async () => {
		let armed = false;
		let original = "";
		let release!: () => void;
		const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
		const f = await fixture((pi) => {
			pi.on("tool_result", async (event) => {
				if (armed && event.toolName === "read" && event.input.bypass_cache === true) {
					await writeFile(String(event.input.path), original);
					release();
				}
			});
		});
		original = f.lines.join("\n");
		await f.run("read", { path: f.path });
		f.lines[30] = "visible sibling version B";
		const versionB = f.lines.join("\n");
		await writeFile(f.path, versionB);
		const tool = f.session.agent.state.tools.find((candidate) => candidate.name === "read");
		if (!tool) throw new Error("Missing read tool");
		const execute = tool.execute.bind(tool);
		tool.execute = async (...args) => {
			if ((args[1] as { bypass_cache?: boolean }).bypass_cache !== true) await gate;
			return execute(...args);
		};
		armed = true;
		const [first, second] = await f.runBatch([
			{ name: "read", args: { path: f.path, bypass_cache: true } },
			{ name: "read", args: { path: f.path } },
		]);
		expect(first!.content).toEqual([{ type: "text", text: versionB }]);
		expect(metadata(second!)?.mode).not.toBe("unchanged");
		if (metadata(second!)?.mode === "diff") {
			const block = second!.content[0];
			if (block?.type !== "text") throw new Error("Missing sibling patch");
			expect(applyPatch(versionB, block.text.slice(block.text.indexOf("\n") + 1))).toBe(original);
		} else {
			expect(second!.content).toEqual([{ type: "text", text: original }]);
		}
	}, 20000);

	it("does not trust an executed but uncommitted registered read", async () => {
		const f = await fixture();
		const tool = f.session.agent.state.tools.find((tool) => tool.name === "read");
		if (!tool) throw new Error("Missing registered read override");
		const discarded = await tool.execute("discarded", { path: f.path });
		expect((discarded.details as ReadToolDetailsExt).readcache?.mode).toBe("full");
		const delivered = await f.run("read", { path: f.path });
		expect(metadata(delivered)?.mode).toBe("full");
		expect(delivered.content).toEqual(discarded.content);
		expect(metadata(await f.run("read", { path: f.path }))?.mode).toBe("unchanged");
	}, 20000);

	it("reopens persisted results/invalidation and discards trust across real tree navigation", async () => {
		const f = await fixture();
		await f.run("read", { path: f.path });
		const file = f.manager.getSessionFile();
		if (!file) throw new Error("Missing session file");
		const before = f.manager.buildSessionContext().messages;
		f.session.dispose();
		const resumed = await f.open(SessionManager.open(file, f.sessionDir));
		expect(resumed.manager.buildSessionContext().messages).toEqual(before);
		expect(resumed.session.messages).toEqual(before);
		expect(metadata(await resumed.run("read", { path: f.path }))?.mode).toBe("unchanged");
		await resumed.run("readcache_refresh", { path: f.path });
		expect(await readFile(file, "utf8")).toContain('"customType":"pi-readcache"');
		resumed.session.dispose();
		const invalidated = await f.open(SessionManager.open(file, f.sessionDir));
		expect(metadata(await invalidated.run("read", { path: f.path }))?.mode).toBe("full");
		const firstUser = invalidated.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
		if (!firstUser) throw new Error("Missing navigation target");
		expect(await invalidated.session.navigateTree(firstUser.id, { summarize: false })).toMatchObject({ cancelled: false });
		expect(invalidated.manager.buildSessionContext().messages.some((message) => message.role === "toolResult" && message.toolName === "read")).toBe(false);
		const branched = await invalidated.run("read", { path: f.path });
		expect(metadata(branched)?.mode).toBe("full");
		expect(branched.content).toEqual((await createReadTool(f.cwd).execute("reference", { path: f.path })).content);
	}, 20000);
});
