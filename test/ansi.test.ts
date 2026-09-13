import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsiFast } from "../techniques/ansi";

type ResultHandler = (event: ToolResultEvent, ctx: ExtensionContext) => Promise<{
	content: ToolResultEvent["content"];
} | undefined>;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

describe("ANSI stripping", () => {
	it.each([
		["", ""],
		["plain\nÉté 日本語\t", "plain\nÉté 日本語\t"],
		["\x1b[31mfailed\x1b[0m\n", "failed\n"],
		["\x1b]0;title\x07body", "body"],
		["\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\", "link"],
	])("strips supported escapes from %j", (input, expected) => {
		expect(stripAnsiFast(input)).toBe(expected);
	});
});

describe("bash result hook", () => {
	let handle: ResultHandler;
	let event: ToolResultEvent;
	let commands: Map<string, Command>;
	const ctx = { ui: { notify: vi.fn() } } as unknown as ExtensionContext;

	beforeEach(async () => {
		vi.resetModules();
		commands = new Map();
		const { default: register } = await import("../index");
		register({
			on: (name: string, handler: ResultHandler) => {
				if (name === "tool_result") handle = handler;
			},
			registerCommand: (name: string, command: Command) => commands.set(name, command),
		} as unknown as ExtensionAPI);
		event = {
			type: "tool_result",
			toolName: "bash",
			toolCallId: "ansi-test",
			input: { command: "printf" },
			content: [{ type: "text", text: "\x1b[31mfailed\x1b[0m" }],
			details: undefined,
			isError: true,
		};
	});

	it("strips color without replacing error status or details", async () => {
		expect(await handle(event, ctx)).toEqual({ content: [{ type: "text", text: "failed" }] });
		expect(event.isError).toBe(true);
		expect(event.content[0]).toEqual({ type: "text", text: "\x1b[31mfailed\x1b[0m" });
	});

	it("preserves distinct text blocks and images", async () => {
		const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
		event.content = [
			{ type: "text", text: "plain first" },
			image,
			{ type: "text", text: "\x1b[32msecond\x1b[0m" },
			{ type: "text", text: "\x1b[31mthird\x1b[0m" },
		];
		expect(await handle(event, ctx)).toEqual({ content: [
			{ type: "text", text: "plain first" },
			image,
			{ type: "text", text: "second" },
			{ type: "text", text: "third" },
		] });
	});

	it("does not duplicate the first colored block over later blocks", async () => {
		event.content.push({ type: "text", text: "distinct second" });
		expect(await handle(event, ctx)).toEqual({ content: [
			{ type: "text", text: "failed" },
			{ type: "text", text: "distinct second" },
		] });
		const { getSessionMetrics } = await import("../metrics");
		expect(getSessionMetrics()).toMatchObject([{
			tool: "bash", originalChars: 30, filteredChars: 21,
		}]);
	});

	it("does not alter read results", async () => {
		event.toolName = "read";
		expect(await handle(event, ctx)).toBeUndefined();
	});

	it("leaves unchanged and empty results alone", async () => {
		event.content = [{ type: "text", text: "plain" }];
		expect(await handle(event, ctx)).toBeUndefined();
		event.content = [];
		expect(await handle(event, ctx)).toBeUndefined();
	});

	it("preserves commands and their independent ANSI controls", async () => {
		expect([...commands.keys()].sort()).toEqual([
			"rtk-clear", "rtk-off", "rtk-on", "rtk-stats", "rtk-toggle-ansiStripping", "rtk-what",
		]);
		const commandCtx = ctx as Parameters<Command["handler"]>[1];
		await commands.get("rtk-off")!.handler("", commandCtx);
		expect(await handle(event, ctx)).toBeUndefined();
		await commands.get("rtk-on")!.handler("", commandCtx);
		expect(await handle(event, ctx)).toBeDefined();
		await commands.get("rtk-toggle-ansiStripping")!.handler("", commandCtx);
		expect(await handle(event, ctx)).toBeUndefined();
	});
});
