import type { CliRenderer, KeyEvent, PasteEvent } from "@opentui/core";

import { styleWorkspace } from "./theme.ts";
import { sidebarStart, sidebarWidth, workspaceBodyHeight } from "./workspace.ts";
import { renderScreen, type TuiController, type TuiState } from "./index.ts";

export interface MountedInteractiveTui {
  destroy(): void;
}

function actionKey(event: KeyEvent): string {
  if (event.ctrl && event.name === "k") return "Find";
  if (event.ctrl && event.name === "f") return "MessageSearch";
  if (event.ctrl && event.name === "c") return "Escape";
  if (event.ctrl && event.name === "q") return "Quit";
  if (event.shift && event.name === "return") return "ShiftEnter";
  switch (event.name) {
    case "tab": return "Tab";
    case "left": return "ArrowLeft";
    case "right": return "ArrowRight";
    case "delete": return "Delete";
    case "end": return "End";
    case "return": return "Enter";
    case "escape": return "Escape";
    case "up": return "ArrowUp";
    case "down": return "ArrowDown";
    case "backspace": return "Backspace";
    case "pagedown": return "PageDown";
    case "pageup": return "PageUp";
    case "home": return "Home";
    default: return event.sequence.length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(event.sequence) ? event.sequence : event.name;
  }
}

function pastedText(event: PasteEvent): string | undefined {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(event.bytes);
    return value.length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Imperative OpenTUI bridge. Rendering stays a projection of TuiState while
 * renderer keypresses feed the controller; no terminal event reaches storage.
 */
export async function mountInteractiveTui(renderer: CliRenderer, controller: TuiController): Promise<MountedInteractiveTui> {
  const { TextRenderable } = await import("@opentui/core");
  let width = renderer.width;
  let height = renderer.height;
  const text = new TextRenderable(renderer, {
    id: "inboxd-interactive-screen",
    content: styleWorkspace(renderScreen(controller.state, { width, height }, { approvalCode: controller.currentApprovalCode() })),
    onMouseDown(event) {
      const state = controller.state;
      if (state.detailOpen || state.composeActive || state.approvalPrompt || state.searchActive || !["inbox", "chat"].includes(state.screen)) return;
      const split = !(width < 100 && state.screen === "chat" && state.pane !== "rooms");
      const bodyHeight = workspaceBodyHeight(state, height);
      if (split && event.x < sidebarWidth(width) && event.y >= 5 && event.y < bodyHeight + 2) {
        const index = sidebarStart(state, bodyHeight) + Math.floor((event.y - 5) / 3);
        void controller.selectConversation(index);
      } else { controller.focusMessages(); }
      event.preventDefault();
    },
  });
  renderer.root.add(text);

  const update = (state: TuiState): void => { if (renderer.isDestroyed) return; text.content = styleWorkspace(renderScreen(state, { width, height }, { approvalCode: controller.currentApprovalCode() })); };
  const onKeypress = (event: KeyEvent): void => {
    if (renderer.isDestroyed) return;
    const key = actionKey(event);
    event.preventDefault();
    void controller.dispatchKey(key);
  };
  const onPaste = (event: PasteEvent): void => {
    const text = pastedText(event);
    event.preventDefault();
    if (text !== undefined) void controller.dispatchPaste(text);
  };
  const onResize = (nextWidth: number, nextHeight: number): void => {
    width = nextWidth;
    height = nextHeight;
    update(controller.state);
  };

  const unsubscribe = controller.subscribe(update);
  renderer.keyInput.on("keypress", onKeypress);
  renderer.keyInput.on("paste", onPaste);
  renderer.on("resize", onResize);
  return {
    destroy: () => {
      unsubscribe();
      renderer.keyInput.off("keypress", onKeypress);
      renderer.keyInput.off("paste", onPaste);
      renderer.off("resize", onResize);
      text.destroy();
    },
  };
}
