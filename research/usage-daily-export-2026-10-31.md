# Daily usage CSV export

## Scope

M28 / B128 incremental workflow, based on published dev ea39e0259792bdf640968050b71d50718f84aa72. The current successful usage-page summary can be downloaded as a local daily CSV with a total row. This is not OTLP, an account bill, a raw request log or a complete-history export.

The button is guarded while the page is loading/refreshing, after a failed refresh, on another page or when the loaded range differs. Export takes no additional API call and changes no state, ledger, provider setting, budget or credential. It does not transmit data or use a third-party endpoint.

## Data contract

- BOM-prefixed UTF-8, CRLF and quoted CSV cells; fixed file name for the selected range.
- Raw numeric USD is used independently of display currency/rate; exact zero and tiny positive values remain numeric. No recorded amount is a blank, not zero.
- Daily rows and the aggregate row preserve calls/errors, token counters, subscription/unknown/partial fee counts, usage completeness counts and historical pricing-source counts.
- Only fixed copy, allowlisted range text, validated calendar dates and finite nonnegative numbers are emitted. Counts must be safe integers. Duplicate/unordered/invalid dates and malformed metric objects reject the entire export. No object spreading, provider/Key labels, IDs, raw requests, prompts or credential fields enter the CSV. This prevents untrusted spreadsheet formulas rather than merely quoting them.
- Dates are the core service's local-calendar dates, not browser-UTC conversion. Export includes the 50,000-log-line/invalid-line limitations in every row. Costs are recorded estimates, not a supplier bill.
- The browser receives a temporary Blob URL only. The temporary anchor is removed even when click fails and its URL revoked after one second. The message reports a download request, not proof a file was saved.

## Verification

Controlled VM tests cover exact-zero/tiny/missing/subscription amounts, all four ranges, strict schema/injection rejection, display-currency independence, no requests/writes, loading/error/range/navigation guard, retry recovery, keyboard focus across a refresh cycle, failed browser click and delayed URL cleanup. Actual synthetic cloud-browser acceptance and full-suite results are recorded in the external validation receipt; no real account or native macOS acceptance is implied.
