# inboxd TUI Design Contract

## 0. Research Log

- Product architecture: `docs/06-architecture.md` §5 defines Inbox, Search, Chat, Approvals, and Doctor plus reconnect/privacy behavior.
- Terminal craft: OMH `tui-craft` guidance supplied border restraint, visible keyboard states, and mandatory 80×24/120×40 renders.
- Local palette reference: `omh design data --kind palette --context dev-tool`; selected **Slate Console** over Terminal Amber because coverage and safety states need several distinguishable semantic roles without a nostalgic theme.
- Local type reference: terminal cells use the terminal's configured monospace font. Korean labels must be width-aware and truncated by terminal cells, never byte length.
- Local UX reference: irreversible approval/send requires an explicit code; errors name the failed action and next step; operations over one second show progress.
- External implementation reference: official OpenTUI documentation for `@opentui/core`, imperative renderables, Bun runtime, and `@opentui/core/testing`.

## 1. Atmosphere & Identity

- Adjectives: **quiet, operational, trustworthy**.
- Direction: **dense operational** with modern-product restraint.
- Audience: one local operator reviewing personal message history and controlled send intents.
- Signature element: every read screen carries a persistent evidence rail showing coverage gaps/freshness; unknown is rendered as `?`, never `0`.
- Reject: boxed-everything layouts, decorative gradients, cursor-only focus, hidden keybindings, and fake completeness.

## 2. Color

Role tokens use truecolor with named 256-color fallbacks:

| Role | Truecolor | 256 fallback | Use |
|---|---|---|---|
| background | `#0F172A` | 234 | terminal root where supported |
| surface | `#1E293B` | 235 | selected row / one primary container |
| text | `#E2E8F0` | 254 | primary text |
| muted | `#94A3B8` | 246 | timestamps, help, inactive chrome |
| border | `#334155` | 238 | the status rail and modal only |
| primary | `#38BDF8` | 81 | focus, active screen, links |
| accent | `#A78BFA` | 141 | mention/search match |
| success | `#4ADE80` | 78 | verified/sent/healthy |
| warning | `#FBBF24` | 220 | gaps, stale, expiring |
| danger | `#F87171` | 203 | degraded, failed, uncertain |

The UI is 80% background/text, 15% muted/surface, at most 5% accents. Color is never the only status signal; every semantic color has a word or glyph. Dark terminals are the primary target; when background control is unavailable, foreground hierarchy must remain readable on user themes.

## 3. Typography

- The terminal controls the font. No font loading.
- Hierarchy uses brightness, weight where supported, spacing, and alignment—not multiple font families.
- Korean/CJK content is measured in terminal cell width. Truncation appends `…` without splitting a grapheme.
- Body rows use one terminal line by default; detail and error copy wrap with explicit indentation.

## 4. Spacing & Layout

- Base unit: one terminal cell vertically and two cells horizontally.
- Grid: top status line, screen body, bottom key/help line.
- At 120×40, the body may split list/detail 40/60. At 80×24, it collapses to one pane; selection opens detail in place.
- The body owns scroll. Status and help stay visible.
- Short-terminal order of sacrifice: secondary metadata → detail preview → filter summary. Status, current screen, primary rows, coverage warning, and key help never disappear.
- Minimum supported size is 80×24. Smaller sizes show a named `terminal too small` state rather than overlapping.

## 5. Components

- **StatusLine:** connected / degraded / reconnecting, stale marker, active account. Degraded disables send actions.
- **ScreenTabs:** Inbox, Search, Chat, Approvals, Doctor. Active tab uses primary color and a text marker.
- **EvidenceRail:** freshness plus `N chats / M gaps`; `? unknown` is explicit. Warning state persists above Search results and inline within Chat.
- **DataList:** aligned rows with visible focused `>` and selected `●`; loading, empty, stale, and error variants.
- **MessageRow:** author, timestamp, body excerpt; `(edited)` and `deleted` text states.
- **ApprovalRow:** state, destination, expiry, body excerpt. Uncertain includes `do not resend automatically`.
- **CodePrompt:** modal/inline prompt owned only by Approvals; focused, invalid, expired, disabled/degraded states. Code is memory-only and cleared after submit/cancel.
- **HelpLine:** visible screen-specific keys; never relies on documentation alone.
- **ErrorNotice:** `what failed — next action`.

No default widget styling ships unchanged: focus marker, text ladder, alignment, truncation, empty/error copy, and key hints are explicit.

## 6. Motion & Interaction

- Terminal updates are immediate. No decorative animation.
- Reconnect uses a static stage label (`reconnecting`) and elapsed seconds after one second.
- Keys: `1–5` screens, `j/k` or arrows move, `Enter` opens/activates, `/` searches, `b` backfill proposal, `c` compose proposal, `a` approval prompt, `Esc` cancel/back, `?` help, `q` quit.
- Approval and backfill are never automatically retried after disconnect.

## 7. Depth & Surface

- Flat surfaces only; no shadows or blur.
- Light box-drawing family only.
- Borders are limited to the one evidence/status rail and approval prompt. Spacing and muted text provide all other hierarchy.

## 8. Accessibility Constraints & Accepted Debt

- Every function is keyboard reachable; focus and selection are explicit and distinct.
- Status never depends on color alone.
- Korean/CJK cell-width clipping is tested at both target sizes.
- Drafts, queries, bodies, approval codes, and tokens are never persisted in `tui.json`; only screen and non-content filters may persist.
- Disconnect preserves the last response as stale, disables send operations, subscribes before re-query, and rejects stale-generation responses.
- Accepted debt: screen-reader semantics vary by terminal and OpenTUI; the MVP guarantees text labels and deterministic keyboard order, not full terminal screen-reader equivalence.
- Visual acceptance requires captured renders at 80×24 and 120×40 after the final UI edit; this contract alone is not visual evidence.
