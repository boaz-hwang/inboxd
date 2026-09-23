# Conversation workspace

The default TUI is a messaging workspace. The sidebar lists connected chats;
the main pane shows recent messages across providers or the selected conversation.
A provider mark (`SL`, `TG`, `KK`) and color distinguish services without repeating
account IDs. Conversation and sender names come from the messenger's account
adapter. All directory pages are loaded and rooms are sorted by latest message
time. A missing unread count is not shown as zero.

## Interaction

- `/` or Ctrl+F opens a message-search input across the current messenger filter.
  Results appear progressively; Enter returns to the main chat and focuses the hit.
- Ctrl+K finds a conversation locally by name or messenger.
- Tab cycles filters, rooms and messages. Left/right selects the filter when its
  section is focused; `[`, `]` also cycle filters. `1` restores all messengers.
- Enter opens the highlighted room, then starts composing. Enter while composing
  sends directly for personal accounts. Agent proposals retain separate approvals.
- Shift+Enter inserts a newline (Kitty keyboard protocol); Alt+Enter and Ctrl+J
  are alternatives for terminals that cannot distinguish Shift+Enter. Bracketed
  paste never submits. Option/Alt+left/right (or Alt+B/F) moves by word;
  Option/Alt+Backspace and Ctrl+W delete the previous word. Ctrl+A/E and Home/End
  move to the line boundaries; Ctrl+U/K deletes to those boundaries. Ctrl+B/F,
  Ctrl+P/N, Delete and Backspace edit on grapheme boundaries. Inside the composer,
  Ctrl+K/F are editing keys. A blue native blinking block cursor follows input.
- Mouse wheel, Page Up/Down and Shift+Up/Down scroll the conversation by visible
  lines. Scrolling to the top loads older history, retaining the reading position.
  There is no next-page key; successful sends return to the latest messages.
- Ctrl+C exits immediately when filters or the room list has focus. In the
  chat pane it cancels input; a consecutive Ctrl+C exits. Any other input resets
  the exit sequence. Escape and `q` no longer cancel/quit. Shift+R refreshes the
  account directory and selected chat. The `b` refresh and `d` detail shortcuts
  are removed; `5` manages connections; `?` shows help.
- At 80 columns, open chats use the full width; Tab can return to the sidebar.
  At 100+ columns, the sidebar and conversation remain visible together.

## Structure

- `workspace-model.ts`: pure conversation, filter, identity and display selectors.
- `workspace.ts`: deterministic responsive text layout and shared hit geometry.
- `text.ts`: terminal-cell and grapheme utilities.
- `theme.ts`: OpenTUI styles; provider labels remain meaningful without color.
- `runtime.ts`: terminal keys, paste, resize and mouse translation.
- `index.ts`: protocol controller, in-memory editor, approval lifecycle and
  explicit evidence inspector. No platform/storage implementation is imported.

The existing inspector tests retain detailed capability/coverage assertions.
Workspace tests cover the new default presentation, native keyboard handling,
account discovery, search navigation, exact destinations, input editing, direct
owner sends and the legacy approval lifecycle. Captures
at 80×24 and 120×40 contain synthetic data only and hash all presentation modules.

## References

Interaction references, not copied implementations:

- [nchat](https://github.com/d99kris/nchat): multiple messaging protocols, quick
  chat navigation, conversation search and message editing controls.
- [cmux](https://github.com/manaflow-ai/cmux): persistent vertical navigation and
  clearly separated workspaces/panes.
- [Codex TUI](https://github.com/openai/codex/tree/main/codex-rs/tui): conversation
  content with a bottom composer and contextual input/confirmation states.

Remote retention and API limits apply. Account-wide push updates are not yet
subscribed; Shift+R refreshes the current directory. See
[account adapter architecture](12-account-workspace.md) for paging and send semantics.
