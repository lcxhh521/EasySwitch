# B130 · Magpie visual alignment, first candidate

## Evidence and scope

- Reference: `yetone/magpie` at `4b3bdbe28c682ef178672883a4c9d6495dd4e7eb`, `internal/gui/assets/app.css`, `index.html`, and repository screenshot assets. MIT, Copyright (c) 2026 yetone. Existing `third_party/magpie/LICENSE` matches the reference license byte-for-byte.
- Target: private EasySwitch dev `8fbddafd033d7f7d450510ccd041f414362c4c30`, including the newer menu-bar/subscription/bridge safeguards. No Swift or protocol behavior changes. A narrow, browser-discovered model-picker Escape focus restoration was added after the CSS passes.
- User request (2026-10-25): “我们要像素级的在他的基础上优化我们的easyswitch了”. This candidate begins the alignment; it does not declare the complete request finished.
- Baseline source was recovered and checked against the exact remote Git tree. All 485 locally materialized blobs matched before edits. The native `menubar/Resources/AppIcon.icns` binary was unavailable locally; it is not deleted upstream and must be preserved when publishing. The local baseline commit is a source snapshot, not the original Git history; never push its history.

## First-pass mapping

| Primitive | Previous EasySwitch | Pinned reference / candidate |
|---|---|---|
| Light canvas/card | blue-tinted #eef3f6 / white | #f4f4f6 / white |
| Dark canvas/card | navy #0a0f18 / #121a27 | charcoal #1a1a1e / #232327 |
| Body typography | 14px / 1.5 | 13px / 1.4 |
| Navigation | 208px, blue selected strip | 212px, neutral selected surface; all existing destinations retained |
| List rows | 60px minimum, 12px × 16px padding | 48px minimum, 7px 12px 7px 14px padding |
| Source row icon | 26px | 22px |
| Inline controls | mixed large radii/density | shared 28px minimum and 6px radius; 40px minimum on coarse pointers |
| Wide-screen canvas | left-aligned surface | 1200px centered inner surface, header aligned |
| Client cards | 18px padding / 14px radius | 14px padding / 12px radius; configuration and capability information retained |

## Intentional differences, not pixel-match claims

- EasySwitch retains its finalized cloud icon/name and its own navigation, client detail workflow, source authorization, accounting semantics and explanatory text. Magpie's native-configuration behavior is not transplanted.
- The page title and caption require a 64px header rather than Magpie's 46px single-line header. Mobile titles remain 16px. A wholesale information-architecture transplant is not included.
- Secondary text is darker than Magpie's muted captions: light #63636b and dark #a1a1aa. Regression checks require 4.5:1 contrast on the three common surfaces. Faint decorative/disabled colors are not asserted to meet text contrast requirements.
- Controls use 28px rather than a mechanically copied 25px height; multiline editors remain untouched. Coarse-pointer targets expand instead of becoming harder to hit.
- The latest native compact panel preserves its layout and scrolling contracts. Its header explicitly avoids inheriting the desktop minimum height, and its rows remain 58px. This is not panel parity or native macOS acceptance.

## Verification and remaining work

The source-level regression tests are not rendered visual evidence. They check token/theme consistency, accessible secondary-text contrast, control scope, navigation structure, and the existing interaction contracts. No raw screenshot-difference score is claimed.

The pinned repository screenshots were actually inspected, but they are marketing/demo assets with inconsistent navigation versions (six/eight tabs versus current nine-page source). They must not be represented as fresh screenshots of the pinned application. Source dimensions and screenshot observations are tracked separately.

Initial browser validation was blocked by execution infrastructure, not missing user consent: default Chromium launch fails with socket EPERM; the approved elevated launch fails before process creation in the sandbox wrapper. The supported existing cloud browser also cannot reach the fixture's loopback endpoint (connection refused). No forbidden filesystem path was accessed or modified, no security setting changed, and no alternative network route was introduced. The failed fixture tab and owned mock server were closed.

The initial fixture connectivity blocker was subsequently resolved through the supported dot cloud desktop terminal and cloud browser in the same network namespace; no sandbox bypass or user-computer access. Actual candidate screenshots and interactions are now being checked with synthetic data.

Before calling B130 complete: render current reference and candidate with the same viewport, device scale, fonts and synthetic data; inspect 390/1024/1440/wide layouts in both themes; test loading/error/empty/long-name states, keyboard focus, picker dismissal, navigation and repeated actions; inspect the native panel separately in an authorized platform environment. Pixel-perfect parity is not yet established. This first candidate remains unpublished and B130 remains in progress.

## Continued screen-level pass (user: “继续”, 2026-10-25)

| Workflow | Current Magpie source evidence | EasySwitch treatment |
|---|---|---|
| Clients | Agent row, fixed selector column; narrow two-row layout (`app.css:777–822`) | Preserve existing client selection + detail pane: model, effort, capability notes, profiles, explicit native/interactive actions are not equivalent to a single upstream selector. No blind structure transplant. |
| Providers | `.provider.selected` quiet surface; editor 16/18/14 padding (`app.css:2426,2876–2891`) | Existing all/subscriptions/pools and authorization/budget evidence retained. Selection surface/detail indentation are mapped but deferred until browser verification. |
| Routing / pools | Current page comes from plugin injection (`index.html:484–495`); old routing PNG is not current proof | Keep explicit pool member/strategy/eligibility semantics. Do not imply upstream routing behavior, auto-configure clients, or remove explanations. Plugin-specific source was subsequently checked; fresh complete reference rendering still required. |
| Usage | `.stats` gap1; `.kpi` padding12/14/11, 20px tabular numbers (`app.css:1103–1111`) | Second pass adapts KPI geometry, zero-minimum columns and wrapping text. Retains all five metrics, historical pricing provenance and unknown/incomplete coverage. Uses grid gaps for consistent dividers across both desktop and mobile rather than first/third-tile border exceptions. |
| Usage wrapper | EasySwitch `#usage-content` is nested inside main, so main's gap does not space nested cards | Explicit inner grid and14px gap restores intended section rhythm; nested daily table gets local horizontal scrolling. This is an EasySwitch containment fix, not a claimed upstream pixel match. |
| Settings | Preference row min48, 12/12/12/14 padding (`app.css:3364–3369`), segmented controls (`2972–2973`) | Existing appearance row already has matching left-text/right-control structure. Further density change deferred; account terms, uncertainty and rest markers are not cosmetic copy and remain untouched. |

The existing chart is220px SVG with its own coordinates/hit targets; upstream base chart is72px bars. No blind resize. Pinned plugins/usage/page.js was subsequently inspected: it generates .stats > .kpi, and no inspected plugin overrides the20px number. Its four metrics differ from our five, so no accounting fields were removed for cosmetic symmetry. Routing plugin CSS was also inspected; its graph semantics are not transplanted. See the reference AUDIT.md supplement.

A second synthetic fixture is prepared outside production at `/workspace/shared/easyswitch-magpie-ui-validation/mock-preview-v2.cjs`, with `visual-fixture-data.cjs`. It corrects obsolete usage response fields in the earlier source-only fixture and includes empty/populated/long-name cases, five accounting metrics, partial/missing pricing evidence and four viewport sizes. It does not call real services, uses `.invalid` model URLs, local allowlisted files, CSP and loopback Host checking. Syntax/data-shape checks pass; this alone is not browser acceptance.

## Render-discovered refinements

- Actual390px light screenshot exposed the blank sixth cell in the five-metric two-column grid. The last odd metric now spans both columns at <=600px; later screenshots must use this revision.
- Actual Chromium keyboard testing found that Escape closed the model picker but left focus on the document. The narrow fix returns focus only on Escape, only to its still-connected enabled trigger. Ordinary outside clicks, navigation and model selection keep their existing focus semantics. Tests cover duplicate Escape bubbling, disconnected/disabled triggers and ordinary dismissal. No binding or launch API behavior changed.
- The actual390px long-source provider screen also exposed truncated pool member/eligibility text. A dedicated `.pool-row` now allows only pool subtitles to wrap. Membership, strategy and qualification text are unchanged; a regression verifies the budget-blocked qualification remains present.
