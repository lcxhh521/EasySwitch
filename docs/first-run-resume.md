# Same-tab first-run draft contract (B122)

The public state API has no stable server/config identity. Provider IDs can be reused, and the product version string is not a build identifier. A stored choice is therefore an unverified UI hint, never account identity, authorization, successful inference, a saved binding, or a resumable session.

- Use sessionStorage only, for a same-tab refresh/interruption. Do not promise recovery after closing the tab. A separate schema version defines compatibility, not the API version string.
- Store only source/model/program identifiers, a necessary phase, schema and timestamp. Maximum 2048 UTF-8 bytes; 30-minute TTL; strict shape and string bounds. Never store a Key, token, capability command, raw error, tested/saved/done flag or login state.
- Read only after current state is available. First display an unverified-draft confirmation using the current source and program names. No probe, login, clipboard, binding write or launch is permitted before explicit confirmation. Confirming only returns to the ordinary unverified selection step; it still does not perform those actions.
- Recheck availability when confirming and again in the existing launch flow. Missing, disabled, budget-blocked or changed choices remain explicit and cannot be silently replaced. An explicit source change clears the dependent model instead of choosing another model automatically.
- Record the possibility of an unconfirmed launch before dispatch. A reload cannot replay it. Preserve the earlier-result warning across later selection changes, without claiming the earlier request belonged to the current service/account.
- Malformed, incompatible, oversized, future-dated or expired records are discarded. Reading does not extend TTL. Storage exceptions never block the existing in-page flow; clearing is best effort when the browser itself refuses access. Finishing or explicitly skipping clears only this marker, not provider/configuration/history data.

Validation is pure storage and rendered-HTML/VM state-machine testing with fake API functions. Actual browser reload, focus, accessibility, layout, real client/account and packaging acceptance remain unverified because the permitted cloud browser cannot currently reach the isolated mock service.
