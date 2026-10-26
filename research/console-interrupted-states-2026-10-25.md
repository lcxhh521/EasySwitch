# B130 — interrupted console states and interaction resilience

Scope: user “继续”, 2026-10-25, `Sentinel_522b1ad3c9c88191a286777931788b70`. Baseline private EasySwitch dev `f8ad9eedb3674c07c38d40df58340cdeec1b330e`. This is the third independent cloud candidate, not a new publication authorization.

## Evidence-driven changes

- A delayed core read left the URL at `#settings` while the title and enabled Agent launch controls still belonged to the previous page. The synthetic browser reproduced a 15-second mismatch. Navigation, history traversal and startup now immediately display the destination title and a polite loading status; late reads remain protected by the existing navigation version.
- The initial loading screen previously labeled an unsettled first core read as a connection failure. The header now distinguishes unread, loading and failed core snapshots; successful reads retain the existing native-configuration indicator.
- An open picker at 1440 CSS px retained left=971/right=1337 when resized to a 390 px iframe, even though CSS shrank its width. Resize now repositions an existing picker against its still-connected anchor without discarding its query or stealing focus.
- Source review and VM events showed that composition Enter/Escape were treated as selection/dismissal shortcuts. Picker and global Escape handlers now ignore `isComposing` and compatibility keyCode 229. This is synthetic event regression coverage, not a real macOS input-method acceptance claim.
- A background core-read failure can set `state=null` while a picker stays open. Filtering now shows an explicit unavailable status instead of throwing; stale native reset and external model choices cannot write without a current snapshot.
- Queued callbacks belonging to a dismissed picker do not submit twice or close a newer picker. A pending selection completion does not force-render a newer page and erase its form; same-page success/failure still refreshes normally.

- Long account labels at the 901 px sidebar breakpoint overflowed their 195 px identity cell into the status badge even though the body had no horizontal overflow. Account titles and login explanations now wrap at all widths, extending the existing mobile-only rule without changing layout thresholds.

- Same-page overlapping refreshes previously lacked response ordering. A monotonic read version now guards core and auxiliary snapshots (including manual Agent refresh); old success/failure cannot replace a newer result. Background polling does not supersede an in-flight core read, and a shared 10-second abort/deadline releases a stalled chain. The separate usage deadline remains independent.
- A navigation loading barrier also prevents the asynchronously loaded icon manifest from rendering destination actions based on the previous snapshot before the current navigation read settles.

The production delta is limited to `web/app.js` and this scoped account text rule in `web/style.css`. No CSS redesign, backend, routing, accounting, native bridge, source permissions or credentials change. No reference implementation was copied for these fixes. Existing attribution and official icon remain unchanged. Magpie's pinned original frontend (`cec54c1d01f64cc0dd846d8561ab6dd92877b300`) remains available in the comparison fixture; EasySwitch-specific offline and save ownership behavior is validated against its own contracts, not transplanted from Magpie.

## Validation and limits

Behavioral regressions use a VM with fake calls only: no actual model, provider, account, device, or credential access. Cases cover offline search and choices, repeated/dismissed picker callbacks, composition keys, save completion across navigation, resize with disconnected anchors, delayed navigation/history, and failure/recovery.

Cloud Chromium uses fixed viewport iframes, synthetic exact GET routes, loopback-only hosts, CSP and HTTP/iframe sandboxing. Unknown routes and mutations are denied; no real backend is started. Actual screenshots and status checks are held outside the repository under `/workspace/shared/easyswitch-magpie-state-validation/` so fixture internals and bulk images are not accidentally published.

Final test totals and completed browser matrix are recorded in that directory's validation/QA reports. This work does not establish native macOS, real input-method, real account or full product pixel parity. B130 remains in progress. Publication requires a separate approval and must use the complete remote tree and real parent, preserving the native AppIcon blob rather than pushing local snapshot history.

Final frozen test totals, hashes, actual concurrent-response evidence and remaining limits are recorded in `/workspace/shared/easyswitch-magpie-state-validation/VALIDATION.md` and `QA-STATES.md`. B130 remains in progress: no new requirement closed or added; 28 open requirements remain (7 todo and 21 in progress).

Final frozen controlled run: 1,628 tests / 1,627 passed / one real Keychain skip / zero TODO / exit 0. Focused shell, picker, automatic-tool and usage: 138 passed. Typecheck and independent review passed. Actual browser state-race verification confirmed a later snapshot stayed visible after the older response body arrived; this was a synthetic GET fixture with flushed headers and delayed body, not a real provider/account operation.
