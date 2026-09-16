import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createReadTool, SessionManager,
	type AgentToolResult, type ExtensionAPI, type ExtensionContext, type ReadToolDetails, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { applyPatch } from "diff";
import { describe, expect, it } from "vitest";
import registerReadcache from "../../index.js";

type Selection = { offset?: number; limit?: number; bypass_cache?: boolean };
type Delivery = "commit" | "uncommitted" | "dropped" | "error" | "untracked";
type Visible = { lines: Map<number, string>; length: number | undefined };
const empty = (): Visible => ({ lines: new Map(), length: undefined });
const copy = (state: Visible): Visible => ({ lines: new Map(state.lines), length: state.length });

function text(result: AgentToolResult<unknown>): string {
	expect(result.content).toHaveLength(1);
	const block = result.content[0];
	if (block?.type !== "text") throw new Error("expected one text block");
	return block.text;
}

function reconstruct(state: Visible): string {
	expect(state.length, "diff/full marker requires a delivered full baseline").toBeDefined();
	return Array.from({ length: state.length! }, (_, i) => {
		expect(state.lines.has(i), `unseen baseline line ${i + 1}`).toBe(true);
		return state.lines.get(i)!;
	}).join("\n");
}

function random(seed: number): (max: number) => number {
	let state = seed >>> 0;
	return (max) => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) % max;
	};
}

async function machine(initial: string) {
	const cwd = await mkdtemp(join(tmpdir(), "readcache-state-machine-"));
	const path = join(cwd, "sample.txt");
	const sessionDir = join(cwd, "sessions");
	let session = SessionManager.create(cwd, sessionDir);
	session.appendMessage({
		role: "assistant", content: [{ type: "text", text: "deterministic fixture" }],
		api: "openai-responses", provider: "openai", model: "fixture",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: 1,
	});
	let visible = empty();
	let tools = new Map<string, ToolDefinition>();
	let hooks = new Map<string, () => void>();
	const checkpoints: { id: string; visible: Visible }[] = [];
	const trace: string[] = [];
	const counts = new Map<string, number>();
	const note = (action: string) => {
		trace.push(action);
		const key = action.split(" ")[0]!;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	};
	const save = () => checkpoints.push({ id: session.getLeafId()!, visible: copy(visible) });
	const install = () => {
		tools = new Map();
		hooks = new Map();
		registerReadcache({
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
			registerCommand: () => {},
			on: (event: string, handler: () => void) => hooks.set(event, handler),
			appendEntry: (customType: string, data: unknown) => session.appendCustomEntry(customType, data),
		} as unknown as ExtensionAPI);
	};
	const execute = (name: string, params: object) => tools.get(name)!.execute(
		`action-${trace.length}`, params, undefined, undefined,
		{ cwd, sessionManager: session } as unknown as ExtensionContext,
	);
	install();
	save();
	await writeFile(path, initial);

	return {
		trace, counts,
		async write(value: string | Buffer) {
			note(`write ${JSON.stringify(value).slice(0, 100)}`);
			await writeFile(path, value);
		},
		async read(selection: Selection = {}, delivery: Delivery = "commit", requireRaw = false) {
			note(`read ${JSON.stringify(selection)} ${delivery}`);
			const bytes = await readFile(path);
			const current = bytes.toString("utf8");
			const lines = current.split("\n");
			const start = (selection.offset ?? 1) - 1;
			const end = Math.min(lines.length, start + (selection.limit ?? lines.length));
			const baseline = await createReadTool(cwd).execute("oracle", { path, ...selection });
			const result = await execute("read", { path, ...selection });
			const output = text(result);
			const marker = /^\[readcache: unchanged(?:,| in lines )/.test(output);
			const diff = /^\[readcache: \d+ lines changed of \d+\]\n/.test(output);
			const next = copy(visible);
			if (requireRaw || selection.bypass_cache) {
				expect(marker || diff, "refresh/bypass must deliver raw bytes").toBe(false);
			}
			if (marker) {
				counts.set("marker", (counts.get("marker") ?? 0) + 1);
				if (start === 0 && end === lines.length) {
					expect(reconstruct(visible)).toBe(current);
				} else {
					for (let i = start; i < end; i++) {
						expect(visible.lines.get(i), `omitted unknown/stale line ${i + 1}`).toBe(lines[i]);
					}
				}
			} else if (diff) {
				counts.set("diff", (counts.get("diff") ?? 0) + 1);
				expect(start).toBe(0);
				expect(end).toBe(lines.length);
				const patch = output.slice(output.indexOf("\n") + 1);
				const applied = applyPatch(reconstruct(visible), patch, { fuzzFactor: 0 });
				expect(applied, "patch must apply to latest visible lines, not a hidden snapshot").not.toBe(false);
				expect(Buffer.from(applied as string)).toEqual(bytes);
				next.lines = new Map(lines.map((line, i) => [i, line]));
				next.length = lines.length;
			} else {
				expect(result.content).toEqual(baseline.content);
				expect((result.details as ReadToolDetails | undefined)?.truncation).toEqual(baseline.details?.truncation);
				const truncation = baseline.details?.truncation;
				const shown = truncation?.truncated ? truncation.outputLines : end - start;
				// Only the built-in's delivered prefix is evidence, never readcache metadata.
				for (let i = start; i < start + shown; i++) next.lines.set(i, lines[i]!);
				if (start === 0 && shown === lines.length) {
					next.lines = new Map(lines.map((line, i) => [i, line]));
					next.length = lines.length;
				}
			}
			if (delivery !== "uncommitted") {
				session.appendMessage({
					role: "toolResult", toolCallId: `action-${trace.length}`, toolName: "read",
					content: delivery === "dropped" ? [] : result.content,
					details: delivery === "untracked" ? {} : result.details, isError: delivery === "error", timestamp: trace.length + 1,
				});
				visible = delivery === "commit" || delivery === "untracked" ? next : empty();
				save();
			}
			return marker ? "marker" : diff ? "diff" : "raw";
		},
		async refresh(selection: Selection = {}) {
			note(`refresh ${JSON.stringify(selection)}`);
			await execute("readcache_refresh", { path, ...selection });
			// Exact refresh forgets a scope, not intersecting knowledge from other scopes.
			if (selection.offset === undefined && selection.limit === undefined) visible = empty();
			save();
		},
		branch(index: number) {
			const checkpoint = checkpoints[index % checkpoints.length]!;
			note(`branch checkpoint=${index % checkpoints.length}`);
			session.branch(checkpoint.id);
			hooks.get("session_tree")!();
			visible = copy(checkpoint.visible);
		},
		compact() {
			note("compact");
			session.appendCompaction("No file bytes retained in this summary", session.getLeafId()!, 100);
			hooks.get("session_compact")!();
			visible = empty();
			save();
		},
		resume() {
			note("resume");
			// Persist the selected branch even if navigation had no subsequent tool result.
			session.appendMessage({ role: "user", content: "resume checkpoint", timestamp: trace.length + 1 });
			save();
			hooks.get("session_shutdown")!();
			session = SessionManager.open(session.getSessionFile()!, sessionDir);
			install();
		},
		close: () => rm(cwd, { recursive: true, force: true }),
	};
}

type Machine = Awaited<ReturnType<typeof machine>>;

async function scenario(initial: string, run: (m: Machine) => Promise<void>) {
	const m = await machine(initial);
	try {
		await run(m);
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : error}\nAction trace:\n${m.trace.map((action, i) => `${i}: ${action}`).join("\n")}`, { cause: error });
	} finally {
		await m.close();
	}
}

const initialLines = Array.from({ length: 48 }, (_, i) => `line ${i + 1}: stable payload abcdefghijklmnopqrstuvwxyz`);

describe("integration: independent visible-content state machine", () => {
	it.each([0x10203040, 0x51a7e123, 0xdeadbeef, 0x7fffffff])("seed %i: 320 generated steps", async (seed) => {
		const rand = random(seed);
		let lines = [...initialLines];
		const history = [lines.join("\n")];
		await scenario(history[0]!, async (m) => {
			await m.read();
			await m.read();
			lines[20] = "changed line for a guaranteed useful initial patch";
			await m.write(lines.join("\n"));
			expect(await m.read()).toBe("diff");
			const actions = new Set<number>();
			for (let step = 0; step < 320; step++) {
				const action = rand(18);
				actions.add(action);
				const offset = 2 + rand(Math.min(30, lines.length - 2));
				const range = { offset, limit: 1 + rand(Math.min(10, lines.length - offset)) };
				switch (action) {
					case 0:
					case 1: {
						const index = rand(lines.length);
						lines[index] = `seed ${seed} step ${step}: replacement ${"x".repeat(rand(50))}`;
						await m.write(lines.join("\n"));
						history.push(lines.join("\n"));
						break;
					}
					case 2:
						if (rand(2) && lines.length > 36) lines.splice(rand(lines.length), 1);
						else lines.splice(rand(lines.length), 0, `inserted at step ${step}`);
						await m.write(lines.join("\n"));
						history.push(lines.join("\n"));
						break;
					case 3:
						lines = history[rand(history.length)]!.split("\n");
						await m.write(lines.join("\n"));
						break;
					case 4: await m.read(); break;
					case 5: await m.read(range); break;
					case 6: await m.read(rand(2) ? { ...range, bypass_cache: true } : { bypass_cache: true }); break;
					case 7: await m.read(range, "uncommitted"); await m.read(range); break;
					case 8: await m.read({}, "dropped"); await m.read({}, "commit", true); break;
					case 9: await m.read(range, "error"); await m.read(range, "commit", true); break;
					case 10: await m.refresh(); await m.read({}, "commit", true); break;
					case 11: await m.refresh(range); await m.read(range, "commit", true); break;
					case 12: m.branch(rand(1000)); await m.read(rand(2) ? range : {}); break;
					case 13: m.compact(); await m.read(range, "commit", true); break;
					case 14: m.resume(); await m.read(rand(2) ? range : {}); break;
					case 15:
						await m.read({ offset: 4, limit: 10 });
						await m.read({ offset: 9, limit: 10 });
						await m.read({ offset: 25, limit: 5 });
						break;
					case 16:
						await m.read({}, "untracked");
						await m.read({}, "commit", true);
						break;
					case 17:
						await m.write(Buffer.from([0xff, 0x0a, 0x61]));
						await m.read();
						await m.write(lines.join("\n"));
						await m.read({}, "commit", true);
						break;
				}
			}
			expect(actions.size).toBe(18);
			expect(m.counts.get("diff")).toBeGreaterThan(0);
			expect(m.counts.get("marker")).toBeGreaterThan(0);
		});
	}, 60_000);

	it("an uncacheable binary read cannot leave an older text snapshot trusted", async () => {
		const original = initialLines.join("\n");
		await scenario(original, async (m) => {
			await m.read();
			await m.write(Buffer.from([0xff, 0x0a, 0x61]));
			await m.read();
			await m.write(original);
			await m.read();
			m.resume();
			await m.read();
		});
	});

	it("reversions cannot resurrect stale overlapping anchors, including after navigation and resume", async () => {
		await scenario(initialLines.join("\n"), async (m) => {
			await m.read();
			await m.read({ offset: 4, limit: 10 });
			const changed = [...initialLines];
			changed[8] = "new visible overlapping line";
			await m.write(changed.join("\n"));
			await m.read({ offset: 8, limit: 8 });
			await m.read({ offset: 30, limit: 3 });
			m.resume();
			await m.write(initialLines.join("\n"));
			await m.read({ offset: 4, limit: 10 });
			await m.read();
			m.branch(3);
			await m.read();
		});
	});

	it("exact refresh preserves other scopes and survives compaction, branches and resume", async () => {
		await scenario(initialLines.join("\n"), async (m) => {
			await m.read({ offset: 4, limit: 10 });
			await m.read({ offset: 8, limit: 10 });
			await m.read({ offset: 30, limit: 5 });
			await m.refresh({ offset: 4, limit: 10 });
			m.resume();
			expect(await m.read({ offset: 8, limit: 10 })).toBe("marker");
			expect(await m.read({ offset: 30, limit: 5 })).toBe("marker");
			await m.read({ offset: 4, limit: 10 }, "commit", true);
			m.compact();
			await m.read({ offset: 8, limit: 10 }, "commit", true);
			m.branch(4);
			m.resume();
			await m.read({ offset: 4, limit: 10 }, "commit", true);
		});
	});

	it.each([
		["BOM", `\ufeff${initialLines.join("\n")}`],
		["CRLF", `${initialLines.join("\r\n")}\r\n`],
		["mixed endings", `${initialLines.join("\n")}\r\nlast\r`],
		["empty", ""],
		["trailing newline", `${initialLines.join("\n")}\n`],
	])("byte boundaries: %s", async (_name, original) => {
		await scenario(original!, async (m) => {
			await m.read();
			await m.read();
			const changed = original!.replace("line 20:", "changed:") + "\nappended";
			await m.write(changed);
			await m.read();
			await m.read({ offset: 1, limit: 1, bypass_cache: true });
			await m.write(original!);
			await m.read();
			m.resume();
			await m.read();
			m.compact();
			await m.read({}, "commit", true);
		});
	});

	it.each([
		["line cap", Array.from({ length: 2010 }, (_, i) => `row ${i}`).join("\n"), 2001],
		["UTF-8 byte cap", Array.from({ length: 80 }, (_, i) => `${i}:${"é".repeat(500)}`).join("\n"), 60],
		["oversized first line", `${"界".repeat(18000)}\nvisible tail`, 2],
	] as const)("truncated snapshots expose only delivered bytes: %s", async (_name, original, tail) => {
		await scenario(original, async (m) => {
			await m.read();
			await m.read();
			await m.read({ offset: tail, limit: 1 }, "uncommitted");
			await m.read({ offset: tail, limit: 1 });
			const changed = original.split("\n");
			changed[tail - 1] += " changed";
			await m.write(changed.join("\n"));
			await m.read({ offset: tail, limit: 1 });
			await m.write(original);
			m.resume();
			await m.read({ offset: tail, limit: 1 });
			await m.read({ bypass_cache: true });
			await m.refresh({ offset: tail, limit: 1 });
			await m.read({ offset: tail, limit: 1 }, "commit", true);
			m.compact();
			await m.read({ offset: tail, limit: 1 }, "commit", true);
		});
	});
});
