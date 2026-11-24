# Bugbot review focus

> Per-repo file at `.cursor/BUGBOT.md`: the "Project-specific focus" section below is
> specific to this repo; it lives with the repo like `CLAUDE.md`.

When reviewing pull requests in this repo:

1. **Apply the rules in [`AGENTS.md`](../AGENTS.md).** That file holds the always-apply engineering standards. Flag any deviation in the diff. Block the PR on violations.
2. **Apply the platform-scoped rules in [`.cursor/rules/`](../.cursor/rules/).** For each rule file, check whether any file in the diff matches its `globs:` line. If yes, flag deviations from that rule.
3. **Comment on unstable UI automation selectors.** For Maestro or other UI automation changes, flag coordinate, point, index, visual, or position-only selectors when a stable ID, accessibility identifier, stable parent, or seeded item is available or should be added. This stays a comment unless item 4 applies.
4. **Block the PR on brittle Maestro flows.** The standard is [`.cursor/rules/qa/maestro.mdc`](../.cursor/rules/qa/maestro.mdc) (sections "Do not depend on specific content" and "Payments and store limitations"). Content WILL change; flows assert capabilities and stable behavior, not content. Block the PR, not just comment, when a changed `android.yaml`, `ios.yaml`, or shared subflow matches any of these:
   - **Content or position dependence.** The flow opens "top story", the first item, `index: 0` (or any `index:`), or a fixed carousel or rail position, then asserts content attributes (audio, Listen, live, video, badge, price) with no fallback to the next item, a deep link, or a seeded item. Also block reliance on one rail sitting above or below another in a modular feed.
   - **Hardcoded editorial values.** The flow hardcodes article titles, show names, host names, EPG programs, prices, or promo copy, or uses a real-word search term and expects results or no results. A no-results term must be obvious nonsense.
   - **Unwaited async assertions.** `assertVisible`, `tapOn`, or `when: visible` targets a loaded-state element (async button, bottom sheet, player screen, feed content) right after navigation or a tap, with no `extendedWaitUntil` on a concrete condition first. Also block `scrollUntilVisible` on feed content with no explicit `timeout`, and a raised `timeout` on an optional scroll inside `repeat` or a retry loop.
   - **Missing optional handling for known one-time prompts.** Android "Viewing full screen", iOS "Save Password?", notification permission, or marketing popups are not dismissed with `optional: true` or a `when:` condition in a flow or subflow that can hit them.
   - **Payment flows in Maestro.** The flow taps a store or paywall product option (for example "Monthly") expecting products to load, or starts, completes, or restores a purchase, or asserts a purchase succeeded. Maestro cannot drive the Play or App Store sheets and CI has no working store. Allow assertions up to the paywall boundary only.
   - **Non-idempotent shared-account state.** The flow follows, unfollows, searches, changes entitlements, or otherwise mutates a shared account without normalizing the starting state first and restoring it in `onFlowComplete`, or assumes the account starts empty or non-empty.
5. **Require a Maestro flow on user-visible mobile bug fixes.** A bug-fix PR that changes user-visible mobile behavior must add or update a Maestro flow (`android.yaml`, `ios.yaml`, `test_case.md` per the Maestro standard) that reproduces the scenario and asserts the fix, using stable accessibility identifiers. Block the PR if it does not, unless the description explains why the bug is not reproducible in the UI.
6. **Comment on metrics and alarms that will be noisy.** Any diff that adds or touches a metric emission, an error log level, or an alarm definition gets a comment if the signal can fire when nothing is actually wrong. Specifically flag:
   - An error, failure, or `5xx` counter on a path reachable by **client-driven cancellation** — a client disconnect, navigate-away, proxy/CDN abort, or upstream client timeout. In Go, that is a request-scoped `context.Canceled` reaching the emitter. Ask for an `errors.Is(err, context.Canceled)` guard **before** the emit, and confirm `context.DeadlineExceeded` is still counted.
   - `err != nil` branches that lump cancellation, timeout, and genuine dependency failure into one counter, or that classify with `==` or error-string matching instead of `errors.Is`.
   - Error counters on **expected** outcomes: cache misses, handled not-founds, empty-but-valid results, or invalid client input that belongs in a `4xx` counter.
   - Guards placed in an HTTP wrapper, response interceptor, or `defer` when the metrics pipeline buffers process-wide and flushes on a timer or count threshold — a post-handler wrapper cannot retract a metric inner code already emitted. The guard belongs at the emit site.
   - **Aggregate** failure counters (`failedQueryCount`, retry tallies, batch error lists) that include canceled work in the tally itself, not just at the metric line.
   - Alarm definitions where sensitivity does not match the signal: a dependency-latency or third-party metric wired into an ECS **rollback** composite; `threshold = 0` with `datapoints_to_alarm = 1` on something that can occur once under normal client behavior; a `500` and a `504` sharing one counter that drives a rollback.
   - A new metric with **no stated consumer**. Ask which alarm or dashboard reads it, or have the author say none does yet.
7. **Apply the project-specific focus below.** These are concerns particular to this repo, on top of the shared standards.

## Project-specific focus

- Architecture: imports must point inward only (domain ← usecases ← adapters ← frameworks). Block the PR if `src/domain` or `src/usecases` touches the DOM, `window`, `document` or `chrome.*`, or if anything outside `adapters/dao` reads Google's markup.
- Google markup is read by `aria-label`, structure and text, never by Google's generated class names.
- DOM is built with `createElement` / `textContent` only (Google enforces Trusted Types); flag any `innerHTML`.
- A new module imported by the content script must be covered by `web_accessible_resources` in `manifest.json`.
- Block any change that can show a rating computed from a partial load (during loading or before a load finished); such states must show the skeleton.
- Behavior changes ship with a `test/*.test.js` test; `npm test` must pass.

## Source of truth

`AGENTS.md` and `.cursor/rules/` hold the shared standards. To change an always-apply rule, edit them directly. To change project-specific focus, edit the section above.
