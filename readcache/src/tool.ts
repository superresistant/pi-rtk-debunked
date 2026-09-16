import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	createReadTool,
	type AgentToolResult,
	type ExtensionContext,
	type ReadToolDetails,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import {
	DEFAULT_EXCLUDED_PATH_PATTERNS,
	MAX_DIFF_FILE_BYTES,
	MAX_DIFF_FILE_LINES,
	SCOPE_FULL,
} from "./constants.js";
import { computeUnifiedDiff, isDiffUseful } from "./diff.js";
import { buildReadCacheMetaV1, limitReadMetaToOutput } from "./meta.js";
import { hashBytes, loadObject, persistObjectIfAbsent } from "./object-store.js";
import { normalizeOffsetLimit, parseTrailingRangeIfNeeded, scopeKeyForRange } from "./path.js";
import {
	buildKnowledgeForLeaf,
	createReplayRuntimeState,
	isRangeScopeBlockedByInvalidation,
	overlaySet,
	type ReplayRuntimeState,
} from "./replay.js";
import { compareSlices, splitLines, truncateForReadcache } from "./text.js";
import type {
	ReadCacheDebugReason,
	ReadCacheDebugV1,
	ReadCacheMetaV1,
	ReadToolDetailsExt,
	ScopeKey,
	ScopeTrust,
} from "./types.js";

const UTF8_STRICT_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface CurrentTextState {
	bytes: Buffer;
	text: string;
	totalLines: number;
	currentHash: string;
}

export const readToolSchema = Type.Object({
	path: Type.String({ description: "Relative/absolute file path" }),
	offset: Type.Optional(Type.Number({ description: "Start line; 1-indexed" })),
	limit: Type.Optional(Type.Number({ description: "Maximum lines" })),
	bypass_cache: Type.Optional(Type.Boolean()),
});

export type ReadToolParams = Static<typeof readToolSchema>;

function buildReadDescription(): string {
	return `Read text/images(jpg/png/gif/webp); text ≤${DEFAULT_MAX_LINES} lines/${DEFAULT_MAX_BYTES / 1024}KB; offset/limit for large files. Stale read (e.g. edit match missing)→bypass_cache=true`;
}

function hasImageContent(result: AgentToolResult<ReadToolDetails | undefined>): boolean {
	return result.content.some((block) => block.type === "image");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

function isExcludedPath(pathKey: string): boolean {
	const baseName = basename(pathKey).toLowerCase();
	return DEFAULT_EXCLUDED_PATH_PATTERNS.some((pattern) => {
		if (pattern === ".env*") {
			return baseName.startsWith(".env");
		}
		if (pattern.startsWith("*")) {
			return baseName.endsWith(pattern.slice(1));
		}
		return baseName === pattern;
	});
}

function withReadcacheDetails(details: ReadToolDetails | undefined, readcache: ReadCacheMetaV1): ReadToolDetailsExt {
	return {
		...(details ?? {}),
		readcache,
	};
}

async function cacheBaselineResult(
	baselineResult: AgentToolResult<ReadToolDetails | undefined>,
	meta: ReadCacheMetaV1,
	runtimeState: ReplayRuntimeState,
	ctx: ExtensionContext,
	text: string,
	assertCurrent: () => void,
): Promise<AgentToolResult<ReadToolDetailsExt | undefined>> {
	assertCurrent();
	const coverage = limitReadMetaToOutput(meta, baselineResult.details?.truncation);
	if (!coverage) {
		return baselineResult;
	}
	await persistAndOverlay(runtimeState, ctx, coverage.pathKey, coverage.scopeKey, coverage.servedHash, text, assertCurrent);
	return {
		...baselineResult,
		details: withReadcacheDetails(baselineResult.details, coverage),
	};
}

function buildTextResult(
	text: string,
	meta: ReadCacheMetaV1,
	truncation?: TruncationResult,
): AgentToolResult<ReadToolDetailsExt | undefined> {
	return {
		content: [{ type: "text", text }],
		details: withReadcacheDetails(truncation ? { truncation } : undefined, meta),
	};
}

function buildMarkerResult(marker: string, meta: ReadCacheMetaV1): AgentToolResult<ReadToolDetailsExt | undefined> {
	return buildTextResult(marker, meta);
}

function buildBaselineInput(path: string, offset: number | undefined, limit: number | undefined): ReadToolParams {
	const input: ReadToolParams = { path };
	if (offset !== undefined) {
		input.offset = offset;
	}
	if (limit !== undefined) {
		input.limit = limit;
	}
	return input;
}

function buildReadcacheMeta(
	pathKey: string,
	scopeKey: ScopeKey,
	servedHash: string,
	mode: ReadCacheMetaV1["mode"],
	totalLines: number,
	rangeStart: number,
	rangeEnd: number,
	bytes: number,
	baseHash?: string,
	debug?: ReadCacheDebugV1,
): ReadCacheMetaV1 {
	return buildReadCacheMetaV1({
		pathKey,
		scopeKey,
		servedHash,
		...(baseHash !== undefined ? { baseHash } : {}),
		mode,
		...(mode === "diff" ? { diffFormat: 1 as const } : {}),
		totalLines,
		rangeStart,
		rangeEnd,
		bytes,
		...(debug !== undefined ? { debug } : {}),
	});
}

function buildDebugInfo(
	scopeKey: ScopeKey,
	baseHash: string | undefined,
	reason: ReadCacheDebugReason,
	overrides: Partial<Omit<ReadCacheDebugV1, "reason" | "scope" | "baseHashFound" | "diffAttempted">> & {
		diffAttempted?: boolean;
	} = {},
): ReadCacheDebugV1 {
	return {
		reason,
		scope: scopeKey === SCOPE_FULL ? "full" : "range",
		baseHashFound: baseHash !== undefined,
		diffAttempted: overrides.diffAttempted ?? false,
		...overrides,
	};
}

function selectBaseTrust(
	pathKnowledge: Map<ScopeKey, ScopeTrust> | undefined,
	scopeKey: ScopeKey,
	rangeScopeBlocked: boolean,
): ScopeTrust | undefined {
	if (!pathKnowledge) {
		return undefined;
	}

	if (scopeKey === SCOPE_FULL) {
		return pathKnowledge.get(SCOPE_FULL);
	}

	if (rangeScopeBlocked) {
		return undefined;
	}

	const exactTrust = pathKnowledge.get(scopeKey);
	const fullTrust = pathKnowledge.get(SCOPE_FULL);
	if (!exactTrust) {
		return fullTrust;
	}
	if (!fullTrust) {
		return exactTrust;
	}
	return exactTrust.seq >= fullTrust.seq ? exactTrust : fullTrust;
}

function buildUnchangedMarker(scopeKey: ScopeKey, start: number, end: number, totalLines: number, outsideRangeChanged: boolean): string {
	if (scopeKey === SCOPE_FULL) {
		return `[readcache: unchanged, ${totalLines} lines]`;
	}
	if (outsideRangeChanged) {
		return `[readcache: unchanged in lines ${start}-${end}; changes exist outside this range]`;
	}
	return `[readcache: unchanged in lines ${start}-${end} of ${totalLines}]`;
}

function buildDiffPayload(changedLines: number, totalLines: number, diffText: string): string {
	return `[readcache: ${changedLines} lines changed of ${totalLines}]\n${diffText}`;
}

async function readCurrentTextStrict(absolutePath: string): Promise<CurrentTextState | undefined> {
	let fileBytes: Buffer;
	try {
		fileBytes = await readFile(absolutePath);
	} catch {
		return undefined;
	}

	let text: string;
	try {
		text = UTF8_STRICT_DECODER.decode(fileBytes);
	} catch {
		return undefined;
	}

	const totalLines = splitLines(text).length;
	return {
		bytes: fileBytes,
		text,
		totalLines,
		currentHash: hashBytes(fileBytes),
	};
}

async function persistAndOverlay(
	runtimeState: ReplayRuntimeState,
	ctx: ExtensionContext,
	pathKey: string,
	scopeKey: ScopeKey,
	servedHash: string,
	text: string,
	assertCurrent: () => void,
): Promise<void> {
	assertCurrent();
	try {
		await persistObjectIfAbsent(ctx.cwd, servedHash, text);
	} catch {
		// Object persistence failures are fail-open.
	}
	assertCurrent();
	overlaySet(runtimeState, ctx.sessionManager, pathKey, scopeKey, servedHash);
}

export function createReadOverrideTool(runtimeState: ReplayRuntimeState = createReplayRuntimeState()) {
	return {
		name: "read",
		label: "read",
		description: buildReadDescription(),
		parameters: readToolSchema,
		execute: async (
			toolCallId: string,
			params: ReadToolParams,
			signal?: AbortSignal,
			onUpdate?: (partial: AgentToolResult<ReadToolDetailsExt | undefined>) => void,
			ctx?: ExtensionContext,
		): Promise<AgentToolResult<ReadToolDetailsExt | undefined>> => {
			if (!ctx) {
				throw new Error("read override requires extension context");
			}

			const generation = runtimeState.generation;
			const sessionId = ctx.sessionManager.getSessionId();
			const assertCurrent = () => {
				throwIfAborted(signal);
				if (runtimeState.generation !== generation || ctx.sessionManager.getSessionId() !== sessionId) {
					throw new Error("Read invalidated by session or cache reset");
				}
			};
			assertCurrent();

			const parsed = parseTrailingRangeIfNeeded(params.path, params.offset, params.limit, ctx.cwd);
			const baseline = createReadTool(ctx.cwd);
			const baselineInput = buildBaselineInput(parsed.pathInput, parsed.offset, parsed.limit);
			const baselineResult = await baseline.execute(toolCallId, baselineInput, signal, onUpdate);

			if (hasImageContent(baselineResult)) {
				return baselineResult;
			}

			if (isExcludedPath(parsed.absolutePath)) {
				return baselineResult;
			}

			throwIfAborted(signal);
			const current = await readCurrentTextStrict(parsed.absolutePath);
			if (!current) {
				return baselineResult;
			}

			const readSnapshotBaseline = () => createReadTool(ctx.cwd, {
				operations: {
					access: async () => {},
					readFile: async () => current.bytes,
				},
			}).execute(toolCallId, baselineInput, signal);

			let start: number;
			let end: number;
			let totalLines: number;
			try {
				const normalizedRange = normalizeOffsetLimit(parsed.offset, parsed.limit, current.totalLines);
				start = normalizedRange.start;
				end = normalizedRange.end;
				totalLines = normalizedRange.totalLines;
			} catch {
				return readSnapshotBaseline();
			}

			throwIfAborted(signal);
			const pathKey = parsed.absolutePath;
			const scopeKey = scopeKeyForRange(start, end, totalLines);

			if (params.bypass_cache === true) {
				const meta = buildReadcacheMeta(
					pathKey,
					scopeKey,
					current.currentHash,
					"full",
					totalLines,
					start,
					end,
					current.bytes.byteLength,
					undefined,
					buildDebugInfo(scopeKey, undefined, "bypass_cache"),
				);
				return cacheBaselineResult(await readSnapshotBaseline(), meta, runtimeState, ctx, current.text, assertCurrent);
			}

			const knowledge = buildKnowledgeForLeaf(ctx.sessionManager, runtimeState);
			const pathKnowledge = knowledge.get(pathKey);
			const rangeScopeBlocked = isRangeScopeBlockedByInvalidation(
				ctx.sessionManager,
				runtimeState,
				pathKey,
				scopeKey,
			);
			const baseHash = selectBaseTrust(pathKnowledge, scopeKey, rangeScopeBlocked)?.hash;

			if (!baseHash) {
				const meta = buildReadcacheMeta(
					pathKey,
					scopeKey,
					current.currentHash,
					"full",
					totalLines,
					start,
					end,
					current.bytes.byteLength,
					undefined,
					buildDebugInfo(scopeKey, baseHash, "no_base_hash"),
				);
				return cacheBaselineResult(await readSnapshotBaseline(), meta, runtimeState, ctx, current.text, assertCurrent);
			}

			if (baseHash === current.currentHash) {
				const mode = scopeKey === SCOPE_FULL ? "unchanged" : "unchanged_range";
				const meta = buildReadcacheMeta(
					pathKey,
					scopeKey,
					current.currentHash,
					mode,
					totalLines,
					start,
					end,
					current.bytes.byteLength,
					baseHash,
					buildDebugInfo(scopeKey, baseHash, "hash_match"),
				);
				const marker = buildUnchangedMarker(scopeKey, start, end, totalLines, false);
				await persistAndOverlay(runtimeState, ctx, pathKey, scopeKey, current.currentHash, current.text, assertCurrent);
				return buildMarkerResult(marker, meta);
			}

			let baseText: string | undefined;
			try {
				baseText = await loadObject(ctx.cwd, baseHash);
			} catch {
				baseText = undefined;
			}

			const fallbackResult = async (
				reason: ReadCacheDebugReason,
				overrides: Partial<Omit<ReadCacheDebugV1, "reason" | "scope" | "baseHashFound" | "diffAttempted">> & {
					diffAttempted?: boolean;
				} = {},
			): Promise<AgentToolResult<ReadToolDetailsExt | undefined>> => {
				throwIfAborted(signal);
				const meta = buildReadcacheMeta(
					pathKey,
					scopeKey,
					current.currentHash,
					"baseline_fallback",
					totalLines,
					start,
					end,
					current.bytes.byteLength,
					baseHash,
					buildDebugInfo(scopeKey, baseHash, reason, overrides),
				);
				return cacheBaselineResult(await readSnapshotBaseline(), meta, runtimeState, ctx, current.text, assertCurrent);
			};

			if (!baseText) {
				return fallbackResult("base_object_missing", { baseObjectFound: false });
			}

			if (scopeKey !== SCOPE_FULL) {
				if (compareSlices(baseText, current.text, start, end)) {
					const meta = buildReadcacheMeta(
						pathKey,
						scopeKey,
						current.currentHash,
						"unchanged_range",
						totalLines,
						start,
						end,
						current.bytes.byteLength,
						baseHash,
						buildDebugInfo(scopeKey, baseHash, "range_slice_unchanged", { outsideRangeChanged: true }),
					);
					const marker = buildUnchangedMarker(scopeKey, start, end, totalLines, true);
					await persistAndOverlay(runtimeState, ctx, pathKey, scopeKey, current.currentHash, current.text, assertCurrent);
					return buildMarkerResult(marker, meta);
				}
				return fallbackResult("range_slice_changed", { outsideRangeChanged: true });
			}

			const baseBytes = Buffer.byteLength(baseText, "utf-8");
			const largestBytes = Math.max(baseBytes, current.bytes.byteLength);
			if (largestBytes > MAX_DIFF_FILE_BYTES) {
				return fallbackResult("diff_file_too_large_bytes", { diffAttempted: true, largestBytes });
			}

			const maxLines = Math.max(splitLines(baseText).length, totalLines);
			if (maxLines > MAX_DIFF_FILE_LINES) {
				return fallbackResult("diff_file_too_large_lines", { diffAttempted: true, maxLines });
			}

			throwIfAborted(signal);
			const diff = computeUnifiedDiff(baseText, current.text, parsed.pathInput);
			if (!diff) {
				return fallbackResult("diff_unavailable_or_empty", { diffAttempted: true });
			}
			if (!isDiffUseful(diff.diffText, baseText, current.text)) {
				return fallbackResult("diff_not_useful", { diffAttempted: true, diffBytes: diff.diffBytes });
			}

			const diffPayload = buildDiffPayload(diff.changedLines, totalLines, diff.diffText);
			const truncation = truncateForReadcache(diffPayload);
			if (truncation.truncated) {
				return fallbackResult("diff_payload_truncated", {
					diffAttempted: true,
					diffBytes: diff.diffBytes,
					diffChangedLines: diff.changedLines,
				});
			}

			throwIfAborted(signal);
			const meta = buildReadcacheMeta(
				pathKey,
				scopeKey,
				current.currentHash,
				"diff",
				totalLines,
				start,
				end,
				current.bytes.byteLength,
				baseHash,
				buildDebugInfo(scopeKey, baseHash, "diff_emitted", {
					diffAttempted: true,
					diffBytes: diff.diffBytes,
					diffChangedLines: diff.changedLines,
				}),
			);
			await persistAndOverlay(runtimeState, ctx, pathKey, scopeKey, current.currentHash, current.text, assertCurrent);
			return buildTextResult(truncation.content, meta, truncation.truncated ? truncation : undefined);
		},
	};
}
