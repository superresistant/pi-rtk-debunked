import { buildContextEntries, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { SCOPE_FULL } from "../../src/constants.js";
import { buildInvalidationV1, buildReadCacheMetaV1, hashReadContent } from "../../src/meta.js";
import {
	applyInvalidation,
	applyReadMetaTransition,
	buildKnowledgeForLeaf,
	createReplayRuntimeState,
	findReplayStartIndex,
	isRangeScopeBlockedByInvalidation,
	replayKnowledgeFromBranch,
} from "../../src/replay.js";
import type { KnowledgeMap, ReadCacheMetaV1, ScopeKey } from "../../src/types.js";

type SessionManagerView = ExtensionContext["sessionManager"];

function createMeta(overrides: Partial<Omit<ReadCacheMetaV1, "v">> & Pick<ReadCacheMetaV1, "pathKey" | "scopeKey" | "servedHash" | "mode">): ReadCacheMetaV1 {
	return buildReadCacheMetaV1({
		pathKey: overrides.pathKey,
		scopeKey: overrides.scopeKey,
		servedHash: overrides.servedHash,
		mode: overrides.mode,
		...(overrides.mode === "diff" ? { diffFormat: 1 as const } : {}),
		...(overrides.baseHash !== undefined ? { baseHash: overrides.baseHash } : {}),
		totalLines: overrides.totalLines ?? 10,
		rangeStart: overrides.rangeStart ?? 1,
		rangeEnd: overrides.rangeEnd ?? 10,
		bytes: overrides.bytes ?? 100,
	});
}

function createReadEntry(
	id: string,
	parentId: string | null,
	meta: ReadCacheMetaV1,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			toolCallId: `tool-${id}`,
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			details: { readcache: { ...meta, outputHash: hashReadContent([{ type: "text", text: "ok" }]) } },
			isError: false,
			timestamp: Date.now(),
		},
	};
}

function createInvalidationEntry(id: string, parentId: string | null, pathKey: string, scopeKey: ScopeKey): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		customType: "pi-readcache",
		data: buildInvalidationV1(pathKey, scopeKey, Date.now()),
	};
}

function createCompactionEntry(id: string, parentId: string | null, firstKeptEntryId: string): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		summary: "compacted",
		firstKeptEntryId,
		tokensBefore: 100,
	};
}

function createSessionManagerStub(state: {
	sessionId: string;
	leafId: string | null;
	branch: SessionEntry[];
}): SessionManagerView {
	return {
		getCwd: () => "/tmp",
		getSessionDir: () => "/tmp",
		getSessionId: () => state.sessionId,
		getSessionFile: () => undefined,
		getLeafId: () => state.leafId,
		getLeafEntry: () =>
			state.leafId ? state.branch.find((entry) => entry.id === state.leafId) : undefined,
		getEntry: (id: string) => state.branch.find((entry) => entry.id === id),
		getLabel: () => undefined,
		getBranch: () => state.branch,
		buildContextEntries: () => buildContextEntries(state.branch, state.leafId),
		getHeader: () => null,
		getEntries: () => state.branch,
		getTree: () => [],
		getSessionName: () => undefined,
	};
}

describe("replay", () => {
	it("starts replay at latest compaction+1 even when firstKeptEntryId points deeper in history", () => {
		const path = "/tmp/file.txt";
		const entries: SessionEntry[] = [
			createReadEntry("e1", null, createMeta({ pathKey: path, scopeKey: SCOPE_FULL, servedHash: "a".repeat(64), mode: "full" })),
			createReadEntry("e2", "e1", createMeta({ pathKey: path, scopeKey: SCOPE_FULL, servedHash: "b".repeat(64), mode: "full" })),
			createCompactionEntry("e3", "e2", "e1"),
			createReadEntry("e4", "e3", createMeta({ pathKey: path, scopeKey: SCOPE_FULL, servedHash: "c".repeat(64), mode: "full" })),
		];

		const boundary = findReplayStartIndex(entries);
		expect(boundary.startIndex).toBe(3);
		expect(boundary.boundaryKey).toBe("compaction:e3");
	});

	it("uses the latest compaction on the active path when multiple compactions exist", () => {
		const path = "/tmp/file.txt";
		const entries: SessionEntry[] = [
			createReadEntry("e1", null, createMeta({ pathKey: path, scopeKey: SCOPE_FULL, servedHash: "a".repeat(64), mode: "full" })),
			createCompactionEntry("e2", "e1", "e1"),
			createReadEntry("e3", "e2", createMeta({ pathKey: path, scopeKey: SCOPE_FULL, servedHash: "b".repeat(64), mode: "full" })),
			createCompactionEntry("e4", "e3", "e3"),
			createReadEntry("e5", "e4", createMeta({ pathKey: path, scopeKey: SCOPE_FULL, servedHash: "c".repeat(64), mode: "full" })),
		];

		const boundary = findReplayStartIndex(entries);
		expect(boundary.startIndex).toBe(4);
		expect(boundary.boundaryKey).toBe("compaction:e4");
	});

	it("applies_full_anchor_without_prior_trust", () => {
		const path = "/tmp/file.txt";
		const knowledge: KnowledgeMap = new Map();

		applyReadMetaTransition(
			knowledge,
			createMeta({ pathKey: path, scopeKey: SCOPE_FULL, servedHash: "a".repeat(64), mode: "full" }),
			1,
		);

		expect(knowledge.get(path)?.get(SCOPE_FULL)).toEqual({ hash: "a".repeat(64), seq: 1 });
	});

	it("ignores_unchanged_without_full_anchor", () => {
		const path = "/tmp/file.txt";
		const knowledge: KnowledgeMap = new Map();

		applyReadMetaTransition(
			knowledge,
			createMeta({
				pathKey: path,
				scopeKey: SCOPE_FULL,
				servedHash: "a".repeat(64),
				baseHash: "a".repeat(64),
				mode: "unchanged",
			}),
			1,
		);

		expect(knowledge.size).toBe(0);
	});

	it("applies_unchanged_with_matching_full_anchor", () => {
		const path = "/tmp/file.txt";
		const knowledge: KnowledgeMap = new Map();

		applyReadMetaTransition(
			knowledge,
			createMeta({ pathKey: path, scopeKey: SCOPE_FULL, servedHash: "a".repeat(64), mode: "full" }),
			1,
		);
		applyReadMetaTransition(
			knowledge,
			createMeta({
				pathKey: path,
				scopeKey: SCOPE_FULL,
				servedHash: "a".repeat(64),
				baseHash: "a".repeat(64),
				mode: "unchanged",
			}),
			2,
		);

		expect(knowledge.get(path)?.get(SCOPE_FULL)).toEqual({ hash: "a".repeat(64), seq: 2 });
	});

	it("ignores_diff_without_matching_full_anchor", () => {
		const path = "/tmp/file.txt";
		const knowledge: KnowledgeMap = new Map();

		applyReadMetaTransition(
			knowledge,
			createMeta({ pathKey: path, scopeKey: SCOPE_FULL, servedHash: "0".repeat(64), mode: "full" }),
			1,
		);
		applyReadMetaTransition(
			knowledge,
			createMeta({
				pathKey: path,
				scopeKey: SCOPE_FULL,
				servedHash: "b".repeat(64),
				baseHash: "a".repeat(64),
				mode: "diff",
			}),
			2,
		);

		expect(knowledge.get(path)?.get(SCOPE_FULL)).toEqual({ hash: "0".repeat(64), seq: 1 });
	});

	it("applies_diff_with_matching_full_anchor", () => {
		const path = "/tmp/file.txt";
		const knowledge: KnowledgeMap = new Map();

		applyReadMetaTransition(
			knowledge,
			createMeta({ pathKey: path, scopeKey: SCOPE_FULL, servedHash: "a".repeat(64), mode: "full" }),
			1,
		);
		applyReadMetaTransition(
			knowledge,
			createMeta({
				pathKey: path,
				scopeKey: SCOPE_FULL,
				servedHash: "b".repeat(64),
				baseHash: "a".repeat(64),
				mode: "diff",
			}),
			2,
		);

		expect(knowledge.get(path)?.get(SCOPE_FULL)).toEqual({ hash: "b".repeat(64), seq: 2 });
	});

	it.each(["full", "diff"] as const)("discards older range anchors after an accepted full-scope %s", (mode) => {
		const pathKey = "/tmp/file.txt";
		const knowledge: KnowledgeMap = new Map();
		applyReadMetaTransition(knowledge, createMeta({
			pathKey, scopeKey: SCOPE_FULL, servedHash: "a".repeat(64), mode: "full",
		}), 1);
		applyReadMetaTransition(knowledge, createMeta({
			pathKey, scopeKey: "r:2:4", servedHash: "a".repeat(64), mode: "full", rangeStart: 2, rangeEnd: 4,
		}), 2);
		expect(knowledge.get(pathKey)?.size).toBe(2);
		applyReadMetaTransition(knowledge, createMeta({
			pathKey, scopeKey: SCOPE_FULL, servedHash: "b".repeat(64), baseHash: "a".repeat(64), mode,
		}), 3);
		expect([...knowledge.get(pathKey)!.keys()]).toEqual([SCOPE_FULL]);
		expect(knowledge.get(pathKey)?.get(SCOPE_FULL)).toEqual({ hash: "b".repeat(64), seq: 3 });
	});

	it("applies_unchanged_range_with_matching_range_anchor", () => {
		const path = "/tmp/file.txt";
		const scope = "r:2:4" as const;
		const knowledge: KnowledgeMap = new Map();

		applyReadMetaTransition(
			knowledge,
			createMeta({ pathKey: path, scopeKey: scope, servedHash: "a".repeat(64), mode: "full", rangeStart: 2, rangeEnd: 4 }),
			1,
		);
		applyReadMetaTransition(
			knowledge,
			createMeta({
				pathKey: path,
				scopeKey: scope,
				servedHash: "b".repeat(64),
				baseHash: "a".repeat(64),
				mode: "unchanged_range",
				rangeStart: 2,
				rangeEnd: 4,
			}),
			2,
		);

		expect(knowledge.get(path)?.get(scope)).toEqual({ hash: "b".repeat(64), seq: 2 });
	});

	it("applies_unchanged_range_with_matching_full_anchor", () => {
		const path = "/tmp/file.txt";
		const scope = "r:2:4" as const;
		const knowledge: KnowledgeMap = new Map();

		applyReadMetaTransition(
			knowledge,
			createMeta({ pathKey: path, scopeKey: SCOPE_FULL, servedHash: "a".repeat(64), mode: "full" }),
			1,
		);
		applyReadMetaTransition(
			knowledge,
			createMeta({
				pathKey: path,
				scopeKey: scope,
				servedHash: "b".repeat(64),
				baseHash: "a".repeat(64),
				mode: "unchanged_range",
				rangeStart: 2,
				rangeEnd: 4,
			}),
			2,
		);

		expect(knowledge.get(path)?.get(scope)).toEqual({ hash: "b".repeat(64), seq: 2 });
	});

	it("full_invalidation_clears_all_scopes", () => {
		const path = "/tmp/file.txt";
		const knowledge: KnowledgeMap = new Map();

		applyReadMetaTransition(
			knowledge,
			createMeta({ pathKey: path, scopeKey: SCOPE_FULL, servedHash: "a".repeat(64), mode: "full" }),
			1,
		);
		applyReadMetaTransition(
			knowledge,
			createMeta({ pathKey: path, scopeKey: "r:2:4", servedHash: "a".repeat(64), mode: "full", rangeStart: 2, rangeEnd: 4 }),
			2,
		);

		expect(knowledge.get(path)?.size).toBe(2);
		applyInvalidation(knowledge, buildInvalidationV1(path, SCOPE_FULL, Date.now()));
		expect(knowledge.has(path)).toBe(false);
	});

	it("range_invalidation_clears_only_range_scope", () => {
		const path = "/tmp/file.txt";
		const scope = "r:2:4" as const;
		const knowledge: KnowledgeMap = new Map();

		applyReadMetaTransition(
			knowledge,
			createMeta({ pathKey: path, scopeKey: SCOPE_FULL, servedHash: "a".repeat(64), mode: "full" }),
			1,
		);
		applyReadMetaTransition(
			knowledge,
			createMeta({ pathKey: path, scopeKey: scope, servedHash: "a".repeat(64), mode: "full", rangeStart: 2, rangeEnd: 4 }),
			2,
		);

		expect(knowledge.get(path)?.size).toBe(2);
		applyInvalidation(knowledge, buildInvalidationV1(path, scope, Date.now()));
		expect(knowledge.get(path)?.get(scope)).toBeUndefined();
		expect(knowledge.get(path)?.get(SCOPE_FULL)).toEqual({ hash: "a".repeat(64), seq: 1 });
	});

	it("range_scope_blocker_persists_until_range_anchor", () => {
		const path = "/tmp/file.txt";
		const scope = "r:2:4" as const;
		const runtime = createReplayRuntimeState();
		const state: { sessionId: string; leafId: string | null; branch: SessionEntry[] } = {
			sessionId: "session-1",
			leafId: "e2",
			branch: [
				createReadEntry(
					"e1",
					null,
					createMeta({ pathKey: path, scopeKey: SCOPE_FULL, servedHash: "a".repeat(64), mode: "full" }),
				),
				createInvalidationEntry("e2", "e1", path, scope),
			],
		};
		const sessionManager = createSessionManagerStub(state);

		expect(isRangeScopeBlockedByInvalidation(sessionManager, runtime, path, scope)).toBe(true);

		state.leafId = "e3";
		state.branch = [
			...state.branch,
			createReadEntry(
				"e3",
				"e2",
				createMeta({ pathKey: path, scopeKey: scope, servedHash: "b".repeat(64), mode: "full", rangeStart: 2, rangeEnd: 4 }),
			),
		];

		expect(isRangeScopeBlockedByInvalidation(sessionManager, runtime, path, scope)).toBe(false);
	});

	it("replays read metadata with guarded transitions and invalidations", () => {
		const path = "/tmp/file.txt";
		const scope = "r:2:4" as const;
		const entries: SessionEntry[] = [
			createReadEntry("e1", null, createMeta({ pathKey: path, scopeKey: SCOPE_FULL, servedHash: "a".repeat(64), mode: "full" })),
			createReadEntry(
				"e2",
				"e1",
				createMeta({
					pathKey: path,
					scopeKey: SCOPE_FULL,
					servedHash: "a".repeat(64),
					baseHash: "a".repeat(64),
					mode: "unchanged",
				}),
			),
			createReadEntry(
				"e3",
				"e2",
				createMeta({
					pathKey: path,
					scopeKey: scope,
					servedHash: "b".repeat(64),
					baseHash: "a".repeat(64),
					mode: "unchanged_range",
					rangeStart: 2,
					rangeEnd: 4,
				}),
			),
			createInvalidationEntry("e4", "e3", path, scope),
			{
				type: "message",
				id: "e5",
				parentId: "e4",
				timestamp: new Date().toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "tool-e5",
					toolName: "read",
					content: [{ type: "text", text: "ignored" }],
					details: {
						readcache: {
							v: 1,
							pathKey: path,
							scopeKey: SCOPE_FULL,
							servedHash: "x".repeat(64),
							mode: "unchanged",
							totalLines: 10,
							rangeStart: 1,
							rangeEnd: 10,
							bytes: 100,
						},
					},
					isError: false,
					timestamp: Date.now(),
				},
			},
		];

		const knowledge = replayKnowledgeFromBranch(entries, 0);
		expect(knowledge.get(path)?.get(SCOPE_FULL)).toEqual({ hash: "a".repeat(64), seq: 2 });
		expect(knowledge.get(path)?.get(scope)).toBeUndefined();
	});

	it("retains only the active replay snapshot during linear session growth", () => {
		const runtime = createReplayRuntimeState();
		const state: { sessionId: string; leafId: string | null; branch: SessionEntry[] } = {
			sessionId: "growing-session", leafId: null, branch: [],
		};
		const sessionManager = createSessionManagerStub(state);
		for (let index = 1; index <= 100; index += 1) {
			const id = `entry-${index}`;
			state.branch.push(createReadEntry(id, state.leafId, createMeta({
				pathKey: `/tmp/file-${index}.txt`, scopeKey: SCOPE_FULL, servedHash: "a".repeat(64), mode: "full",
			})));
			state.leafId = id;
			expect(buildKnowledgeForLeaf(sessionManager, runtime).size).toBe(index);
		}
		expect(runtime.memoByLeaf.size).toBe(1);
		expect([...runtime.memoByLeaf.values()].reduce((total, memo) => total + memo.knowledge.size, 0)).toBe(100);
	});

	it("returns isolated knowledge from only the committed active branch", () => {
		const path = "/tmp/file.txt";
		const runtime = createReplayRuntimeState();
		const state: { sessionId: string; leafId: string | null; branch: SessionEntry[] } = {
			sessionId: "session-1",
			leafId: "e1",
			branch: [
				createReadEntry(
					"e1",
					null,
					createMeta({ pathKey: path, scopeKey: SCOPE_FULL, servedHash: "a".repeat(64), mode: "full" }),
				),
			],
		};
		const sessionManager = createSessionManagerStub(state);

		expect(buildKnowledgeForLeaf(sessionManager, runtime).get(path)?.get(SCOPE_FULL)?.hash).toBe("a".repeat(64));

		const returned = buildKnowledgeForLeaf(sessionManager, runtime);
		returned.get(path)!.get(SCOPE_FULL)!.hash = "b".repeat(64);
		expect(buildKnowledgeForLeaf(sessionManager, runtime).get(path)?.get(SCOPE_FULL)?.hash).toBe("a".repeat(64));

		state.leafId = null;
		state.branch = [];
		expect(buildKnowledgeForLeaf(sessionManager, runtime).size).toBe(0);
	});
});
