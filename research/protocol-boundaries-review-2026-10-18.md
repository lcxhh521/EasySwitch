# B21 targeted protocol boundary review, 2026-10-18

Base: `lcxhh521/EasySwitch` dev `6639b6bc9f2a07837c3aef2561ef32b37179695d`.
The snapshot was independently materialized through the connected GitHub reader and its 474 blobs verified against the exact Git tree. Work used dot's cloud filesystem only. No user computer, real provider account, paid API, account login, publication, or copied third-party implementation was used.

## Implemented: incremental converted custom-tool input

Ordinary function arguments already streamed. Converted Responses custom tools were instead buffered until the whole response finished, because upstream receives a JSON `{ "input": "..." }` wrapper that must validate before becoming executable.

The patch decodes the canonical first `input` string incrementally, including fragmented JSON escapes and UTF-16 surrogate pairs. It emits progress before wrapper closure/EOF without manufacturing completed executable calls. Noncanonical property order and escaped property names keep the buffered fallback. Complete object validation remains mandatory before a successful terminal. Independent linear validation rejects duplicate top-level wrapper properties (including escaped equivalents) for canonical, noncanonical, and nonstreaming paths. Completed input must agree with already emitted progress; final emission only sends any remaining suffix.

Truncated wrappers preserve the existing incomplete contract: the final item is `incomplete` with empty input, not an executable completed call. Progress deltas may precede that final empty input; this is not a promise of stream-concatenation equality for incomplete responses. The adapter does not execute tools itself. Real-client behavior still needs acceptance testing.

Changed production files: `core/src/custom-tool-input.ts`, `core/src/downstream.ts`.

## Verified existing behavior: hosted search

Same-protocol Responses keeps hosted `web_search`, options, forced search selection, and native search-result bytes. It takes precedence even if the source lists Chat first. Cross-protocol auto-selection intentionally drops/logs hosted tools, per B86; forced hosted-search selection fails before sending rather than pretending a function tool can perform it. No new search backend or forced Chat route was introduced.

## Open boundary: opaque conversation/account affinity

Cross-protocol compaction is rejected before network I/O because the native opaque item cannot be translated. The gateway has no `/v1/responses/compact` endpoint. Same-protocol opaque history is forwarded, but there is no verified originating-account binding.

`research/opaque-continuation-fallback.repro.ts` demonstrates the gap with fake account A/B keys and a loopback server: after A returns 401, the same synthetic compaction payload is retried against B. The same applies to `previous_response_id` and `conversation`, both through key fallback and provider-pool fallback. All six desired one-account assertions are explicit TODO failures outside the standard test glob, not passing safety claims. They demonstrate routing behavior, not real third-party disclosure or a vendor's acceptance of foreign encrypted data.

Run the known-gap reproduction:

`node --test --test-force-exit research/opaque-continuation-fallback.repro.ts`

A narrow future guard can detect these three opaque Responses markers, disable cross-key and cross-pool retries plus automatic model substitution, and return the original failure. Same selected-account transient retries can remain. A provider/key identifier is not proof of account identity; the initial selected account may already differ from the origin, and rotating pool selection can choose a different first member on the next request. Consequently, “no retry after first attempt” alone is not full affinity. A conservative guard should reject opaque histories addressed to ambiguous multi-account pools unless the caller names a concrete source/key, or explicitly disclose that the first selection is unverified. Full protection needs a separately defined provenance/binding contract. No fallback behavior was changed in this patch.

## Open capability gap: per-model context windows

`core/src/catalog.ts` applies 128,000 context/max-context tokens and a 90% auto-compaction threshold to every external Codex model. `Provider` and `CatalogModel` contain no trusted per-model context-window field. Multiple extra launchers separately use 200,000 or 128,000 constants. Model-name context suffix normalization is not evidence of actual source support.

This review does not replace those values with guessed model-family limits or a universal 1M window. A future change needs metadata provenance, per-source overrides, explicit unknown-model fallback, mixed-window tests, and safe pool capability intersection. Native Codex catalog entries are preserved when included; the arbitrary external-model constants remain an open gap.

## Validation

Focused tests: 103 passed, zero failed/skipped, using only pure code and synthetic loopback fixtures:

`node --test --test-force-exit core/test/custom-tool-input.test.ts core/test/protocol-streaming.test.ts core/test/source-adapters.test.ts core/test/protocol-safety.test.ts core/test/outbound-shape.test.ts core/test/outbound-corrections.test.ts`

`npm run typecheck` passed. `git diff --check` passed. The final combined aggregate belongs to the integration workstream; this focused result is not a full-suite or real-agent acceptance claim.

Independent reviewer initially found noncanonical duplicate-wrapper keys could pass through the buffered path. The patch was revised to validate all wrapper layouts independently; regression tests cover the reported cases. Reviewer also exercised 5,000 randomized fragmented UTF-16 strings without corruption. Final independent review status is reported separately rather than inferred here.

Combined integration validation (2026-10-18): audited pure `custom-tool-input` suite added to the controlled whitelist; final `npm run test:local` reported 1,272 tests, 1,271 passed, 1 real Keychain skipped, zero failures/todos. All 396 code/script hashes were unchanged during the run. The six known-gap TODO reproductions remain outside this aggregate and remain unresolved. No real client or provider was invoked.
