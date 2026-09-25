Owner: merged into /home/sr/dev/pi/pi-local Sept25; that agent owns this repo

pi-rtk-debunked

One Pi package, two independent extensions:

- ANSI stripping removes supported terminal escape sequences from bash tool output. It does not rewrite commands or compact their text.
- Readcache overrides `read` with replay-aware unchanged/range markers and full-file diffs, falling back to baseline reads when trust or diff usefulness is insufficient. `readcache_refresh` invalidates a path or range for the next read.

Readcache was imported with its Git history and local API compatibility changes under `readcache/`. The historical RTK benchmarks did not evaluate readcache. They do not establish its savings or correctness.

Install this consolidated checkout once:

```sh
npm install
pi install /absolute/path/to/pi-rtk-debunked
```

Remove separate readcache and RTK package entries when switching, then `/reload` existing sessions. Do not also install `readcache/` as a package. The root manifest loads both entrypoints. Published GitHub/npm version `0.2.0` still contains only ANSI stripping; this consolidation has not been published.

Controls:

- `/rtk-stats`, `/rtk-on`, `/rtk-off`, `/rtk-what`, `/rtk-clear`, `/rtk-toggle-ansiStripping` affect only ANSI processing and its in-memory character metrics.
- `/readcache-status`, `/readcache-refresh <path> [start-end]`, and the `readcache_refresh` tool retain their existing APIs. The `read` override retains `path`, `offset`, `limit`, and `bypass_cache`.

Optional ANSI config: `.pi/rtk-config.json` in the project, falling back to `~/.pi/agent/rtk-config.json`:

```json
{ "enabled": true, "techniques": { "ansiStripping": true } }
```

Readcache behavior and implementation details remain in [readcache/README.md](readcache/README.md); its standalone install instructions describe the original package, not this consolidated checkout.

Historical evaluations

This fork began with [mcowger/pi-rtk](https://github.com/mcowger/pi-rtk). Selected output filters, command rewriting, and JSON re-encoding were evaluated for one working setup and rejected. This is not a universal disproof of token optimization.

The survey covered 3,765 stored sessions, 246,241 tool results, and 599M characters of tool output. Individual investigations used subsets, sampled probes, and synthetic fixtures as well as session-derived data. Corpora remain local and gitignored; scripts are in `bench/`. Historical reports retain stronger claims than the evidence supports; interpret them with these limitations:

- [Post-hoc filters](bench/RESULTS.md): sampled failures included hidden vitest failures, substring-based build misclassification, empty non-patch Git output, and URL damage. The 91.3% source-read alteration figure is not an observed edit-failure rate. The reported 9.4% vitest figure is a failure-signal heuristic, not a general test-failure rate.
- [Command rewriting](bench/rtk-eval/): 80 real Pi sessions included 64 paired gpt-5.5 runs and 16 exploratory Spark runs. The isolated agent directory omitted the user's default prompt/extensions. Recorded checkers passed both arms, but did not fully assess answer correctness. Final-context +5% and estimated cost -1% are proxies, not cumulative end-to-end token measurements. Duplicate-command counts did not measure the promised within-three-turn raw retries. Twenty guard tests do not prove downstream-consumer safety: the guard splits shell text with regex, not a shell parser. Trials were stopped; these small fixtures do not settle general savings or model behavior.
- [TOON](bench/toon-eval/): reported sampled savings were 16.4% and mixed-JSON roundtrip failures 3.9%. Decoder failures need minimized reproductions before attributing general codec defects. The scanner inspects only the first 200 JSONL rows while counting full output mass. Combining character coverage with sampled token savings does not establish a total-context ceiling.
- ANSI stripping: the reported 1.71% of February bash characters spans installation on February 28. A live smoke confirmed color removal. This does not prove zero information loss for every terminal escape sequence.

The archived scripts can rerun the analyses with suitable corpora, dependencies, and fixtures; another session directory will not reproduce the same numbers. Deleted filter implementations are available at tag `v0.1.7`. No new experiment is part of consolidation.

Development

```sh
npm install
npm test
npm run check
```

`npm test` runs readcache tests and the ANSI regression suite in separate bounded roots, excluding the benchmark archive. `npm run check` typechecks the root and readcache with their respective configurations; `npm run typecheck` is an alias. Root dependencies support both entrypoints; the nested package and lockfile are retained from the import.

MIT. Original RTK by Matt Cowger; readcache by Gurpartap Singh.
