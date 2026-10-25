# B130 · Current original-renderer comparison and page rhythm

## Fixed revisions and actual evidence

User continued the pixel-level goal with “继续” (2026-10-25, message `Sentinel_e60d760d880081918b34a1bad27ba327`). This is a new unpublished candidate based on private EasySwitch dev `6395fa7c4b09133049bed07e857bd632aa4db068`; remote was rechecked before work and had not advanced. The previous candidate is already published; its old “unpublished” notes describe that earlier checkpoint, not the current branch state.

Magpie main was rechecked and had advanced six commits to `cec54c1d01f64cc0dd846d8561ab6dd92877b300`. The user's fork was not changed. All 39 locally materialized repository-backed assets used by the original index were checked byte-for-byte against this SHA. Original HTML, CSS, app.js and plugin renderers ran unchanged in cloud Chromium; only the normally server-generated boot preferences and HTTP responses were synthetic. No native Go/Wails backend, account, model service or user computer was used. Existing MIT attribution and final EasySwitch brand are preserved.

The comparison uses fixed iframe viewports, not auto-growing content: 1440 × 900, 1024 × 900 and 390 × 844 in representative light/dark cases. Initial actual captures include both applications' Agent, Providers, Usage and Settings pages. Synthetic data has the same two agent names, source/model identities and principal usage counters. This is stronger evidence than the older repository marketing screenshots, which are not used as the acceptance baseline here.

Local evidence: `/workspace/shared/easyswitch-magpie-next-validation/screenshots/`; fixture and request logs in its parent directory. Current reference assets and startup contract: `/workspace/shared/magpie-reference-current-20261025/`. These workspace paths are review evidence, not runtime dependencies or files for publication.

## Source-grounded, rendered changes

| Observed area | Difference and treatment |
|---|---|
| Client/source toolbars | EasySwitch combined an 18px bottom margin with main's 14px grid gap. Actual screenshots showed the extra empty band before the cards. Remove the extra margin; shared gap now determines spacing. Source-add/support/suggestions stop stacking their own outer margin with that grid gap. |
| Client selection/detail | Current Magpie shows a compact list with inline controls. EasySwitch must also retain fallback, effort, capability and explicit native/interactive launch explanations. Keep its master/detail interaction, but use a single-column desktop selection list and give detail more room. Reduce internal gaps from 18px to12px and section padding to12px14px; selected card has a neutral surface with a clear accent boundary. Mobile retains its own wrapping layout. No field, action or explanation removed. |
| Appearance | Original Settings renders compact preference rows. EasySwitch's large appearance card is now12px14px padding and13px title, with its persistence-failure note and mobile control wrapping intact. No account/rest/terms behavior changed. |
| Source editor | Apply upstream editor's16px18px14px rhythm only to `.detail[data-provider]`, replacing the deep54px indentation and dashed separator. Expanded source gets a quiet surface. All protocol, budget, connection uncertainty and credential warnings remain. Other `.detail` regions are untouched. |
| Narrow account settings | Actual 390px screenshots exposed account identity squeezed into one or two characters per line despite no horizontal overflow. Reserve an identity row, allow the first-login explanation to wrap and give the add-account label input a full row. All four account actions remain; only <=600px CSS changes. |
| Segmented controls | Original track padding2/radius7 is adopted for desktop console segments; buttons stay at least28px and40px on coarse pointers, rather than copying smaller native click targets. Native panel is excluded. |

## Intentional semantic and platform differences

- Same124,000 input and42,000 cache-read counters produce different cache-hit percentages in the two applications (reference25%, EasySwitch34% in this fixture). Their denominator conventions differ. This visual task does not change accounting semantics to make numbers match.
- EasySwitch's five usage metrics and complete missing/partial-price warnings are retained; Magpie has different metric grouping and cost placement. Longer evidence produces taller cards and is not clipped for visual similarity.
- Current Magpie directly connects/restores client configuration; EasySwitch keeps isolated enhanced-session behavior. An upstream switch or compact row is not permission to transplant its semantics. Its “Details” fixture contained only a model field, so it is not proof of a fully populated real-client detail layout.
- An empty routing trace exercises only the empty request view, not active routing animation or inference. No full capability parity claim follows from successful frontend loading.
- These are web-mode Linux Chromium iframe renders. Native titlebars, macOS font metrics, Safari, actual touch hardware, full application screen parity and complete error/loading/long-data matrices remain separate acceptance work. No pixel-difference percentage is fabricated.

## Isolation and validation

Both servers bind only127.0.0.1, with exact synthetic GET allowlists, all mutations rejected and no proxy/fallback. Unknown paths fail visibly. CSP restricts resource requests to self and includes an HTTP-level sandbox without popups/forms/top navigation/downloads. Static assets reject symlinks and root escape. Original route long polling waits20seconds to avoid a hot loop. Fixture metadata URLs use `.invalid`; no real login/launch/probe/install/update action is tested.

Source/VM regressions check scoped spacing, control targets and preservation of settings uncertainty/persistence text. Actual after screenshots and interaction results, final full-test totals and independent review are recorded in the validation report after the candidate is frozen. B130 remains in progress; no new push is authorized by this iteration's “continue”.

## Frozen candidate result

Final controlled local runner: 1,606 tests, 1,605 passed, one real Keychain test skipped, zero TODO, exit 0. All 50 console-shell tests, typecheck, backlog format and diff checks pass. Independent static review found no blocker. Actual after screenshots and interactions confirm the narrower master/detail layout, readable source warnings, theme switching, picker Escape focus and repaired 390px account labels/input; no business JavaScript changed. Final CSS SHA256: `4d4bf18a3fbfe6d014f3640fe40789a4fe9ea95bf917277a9860b41a088190b0`. Full evidence and cleanup report: `/workspace/shared/easyswitch-magpie-next-validation/QA-COMPARISON.md`.

This completes a coherent second candidate, not the entire B130 requirement. Publication still needs a separate user decision.
