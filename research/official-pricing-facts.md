# B33: independently verified pricing facts

Checked: **2026-10-07 (UTC)**. The machine-readable source is
`core/src/pricing/official-facts.json`. This is a bounded first batch, not a
complete provider catalog. It records 17 tariffs for exactly 10 selected model
IDs. No existing generated prices or third-party metadata were used to fill
the rates. The sources below are first-party documentation read for this pass;
no login, account, model inference, or paid API call was used.

## Scope and interpretation

- Every amount is USD per 1,000,000 tokens unless its own unit says otherwise
- Rows identify model, official API host, service mode, region, text modality,
  context boundary, cache treatment, source URL, and verification date
- A `null` rate means no separately verified numeric tariff. It is never
  coerced to zero. `unknownReasons` explains every null, including cases where
  a separate rate is inapplicable rather than genuinely unknown
- `cacheWriteTreatment: included-in-input` means an official source explicitly
  says creation adds no write charge; ordinary uncached input still costs money
- `cacheWriteTreatment: separate` means write tokens use their own tariff. The
  creation rate is not an additive fee on top of the same tokens' input rate
- `conditional` rows are evidence for future support, not permission to choose
  a convenient default. Current input/output/cache-hit totals cannot resolve
  session context, cache-write counts/TTL, effective geography, cache storage,
  or a holiday calendar
- The two `standard-text` rows, GPT-4o and GPT-4o mini, are token-only reference
  estimates for their stated standard API surface. They do not include tools,
  non-text usage, service-tier premiums, subscriptions, tax, or negotiated terms
- Exact IDs only: an official API host is not evidence that every model at it
  has a known tariff. A reseller's model name is not evidence of its sale price
- The new pure official estimator has no currency conversion, snapshot alias
  guessing, vendor-wide crawl, model capability change, or retained old-price
  fallback in this first batch

This is a staged migration. The new official table is used only by the new
pure official estimator; production pricing still uses the legacy numeric
table, labeled as legacy and not independently reverified. This batch does
not switch production budget behavior or B50 to the official estimator.

## OpenAI: three selected IDs

Verified model pages:

- [GPT-4o](https://developers.openai.com/api/docs/models/gpt-4o): input 2.50,
  output 10.00, cache read 1.25; 128,000 context ceiling
- [GPT-4o mini](https://developers.openai.com/api/docs/models/gpt-4o-mini):
  input 0.15, output 0.60, cache read 0.075; 128,000 context ceiling
- [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4): input 2.50,
  output 15.00, cache read 0.25 at the ordinary context tier. Above 272,000 input
  tokens, the page applies input ×2 and output ×1.5 to the entire session.
  Thus the long row's 5.00 and 22.50 are transparent arithmetic from stated
  multipliers. A separate long-context cache-read amount was not verified, so
  that field remains null. Regional processing adds 10%

The current [prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
distinguishes GPT-5.6-and-later write pricing from earlier models. It explicitly
states that earlier models have no additional cache-write charge. All three
selected models therefore use `included-in-input`, with no invented numeric
cache-write token rate. Newer-model write rates must not be backported to them.

GPT-5.4 remains conditional: a single call's input count cannot establish the
session-wide condition or regional pricing. The 128,000/1,050,000 bounds in the
facts are context ceilings, not an output-capacity guarantee.

## Anthropic: three selected IDs, two write TTLs each

Each exact ID and both cache-write rates were verified on its model page:

| ID | Input | Output | Cache read | 5-minute write | 1-hour write |
| --- | ---: | ---: | ---: | ---: | ---: |
| [claude-sonnet-4-6](https://platform.claude.com/docs/en/models/sonnet-4-6/overview) | 3 | 15 | 0.30 | 3.75 | 6 |
| [claude-opus-4-6](https://platform.claude.com/docs/en/models/opus-4-6/overview) | 5 | 25 | 0.50 | 6.25 | 10 |
| [claude-haiku-4-5](https://platform.claude.com/docs/en/models/haiku-4-5/overview) | 1 | 5 | 0.10 | 1.25 | 2 |

[Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing)
confirms that 4.6 models use ordinary rates throughout their supported 1M
context. It also distinguishes first-party tariffs from partner-operated
platform prices. No older long-context surcharge is transplanted here.

[Data residency](https://platform.claude.com/docs/en/manage-claude/data-residency)
applies a 1.1 multiplier to every token category for US-only inference on 4.6
and later models. An omitted `inference_geo` can inherit the workspace's
configured default. Therefore omission is not proof of global pricing. Haiku
4.5 does not support that parameter and uses ordinary first-party pricing.

All six rows remain conditional because current ledger totals omit cache
creation quantities and TTL. Sonnet/Opus also need effective geography. The
verified Haiku alias points to `claude-haiku-4-5-20251001`; that does not add the
snapshot as an independently priced ID to this batch.

## Google: two selected IDs, three paid-standard text tiers

[Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)
provides the following paid standard rates; output includes thinking:

| ID and prompt tier | Input | Output | Cache read | Cache storage, USD/1M token-hours |
| --- | ---: | ---: | ---: | ---: |
| gemini-2.5-flash | 0.30 | 2.50 | 0.03 | 1.00 |
| gemini-2.5-pro, ≤200,000 | 1.25 | 10 | 0.125 | 4.50 |
| gemini-2.5-pro, >200,000 | 2.50 | 15 | 0.25 | 4.50 |

Storage is an additional time-based dimension, not a free or per-token write
operation. Its duration/allocation is absent from current call usage. All three
rows remain conditional. Free-tier eligibility, Vertex AI, Batch/Flex/Priority,
audio and grounding are excluded; the latter also has separate allowances and
charges. No standalone cache-write tariff was verified.

## DeepSeek: two selected IDs, two periods each

The freshly opened [pricing page](https://api-docs.deepseek.com/quick_start/pricing/)
explicitly routes `deepseek-v4-flash` to `deepseek-flash`/V4.1-Flash and bills it
at that tariff. It separately lists V4-Pro-0813 for `deepseek-v4-pro`.

| Selected ID | Period | Input miss | Output | Input hit |
| --- | --- | ---: | ---: | ---: |
| deepseek-v4-flash | off-peak | 0.15 | 0.60 | 0.003 |
| deepseek-v4-flash | peak | 0.30 | 1.20 | 0.006 |
| deepseek-v4-pro | off-peak | 0.66 | 1.98 | 0.022 |
| deepseek-v4-pro | peak | 1.32 | 3.96 | 0.044 |

Peak windows are weekdays 01:00–04:00 and 06:00–10:00 UTC, excluding Chinese
public holidays. All other times are off-peak. Search-index excerpts omitted
the holiday exception; the freshly opened source includes it and governs this
record. An earlier news announcement about Pro rerouting is not substituted
for the current price table. No independent cache-write rate was verified.
All four rows are conditional. Neither a weekday-only heuristic nor an
unconditional peak-price estimate is allowed.

## Verification and boundaries

`core/test/official-pricing-facts.test.ts` checks exact selection scope,
first-party source/host identity, verification dates, finite values, explicit
null reasons, independent golden rate fixtures, context-tier boundaries,
cache-write semantics, condition retention, and the two-row auto-estimation
allowlist. These are local, synthetic tests; they do not establish live billing
or account availability.

`coverageGaps` records the eight models whose verified rates remain conditional.
All other model IDs and unverified account-specific tariffs are outside this
batch and stay unpriced in the new pure official estimator. Production still
uses its legacy pricing path. Dates are observation dates, not guaranteed
future validity. Expanding coverage requires a fresh official source check and
an explicit applicability decision. This establishes only the first-batch
official facts and pure-estimator slice after integration tests pass. B33's
overall pricing migration remains incomplete, as does the broader
public-release checklist; this work does not authorize publication.
