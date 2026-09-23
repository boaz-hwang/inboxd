import { CURSOR_MARK, displayWidth } from "./text.ts";
import type { CliRenderer, KeyEvent, PasteEvent } from "@opentui/core";

import { styleWorkspace } from "./theme.ts";
import { sidebarStart, sidebarWidth, workspaceBodyHeight, renderedObservation } from "./workspace.ts";
import { renderScreen, type TuiController, type TuiState } from "./index.ts";

export interface MountedInteractiveTui {
  destroy(): void;
}

export function actionKey(event: KeyEvent, editing = false): string {
  if (event.ctrl && event.name === "c") return "Cancel";
  if (event.name === "escape") return "Escape";
  if ((event.shift || event.meta || event.option) && ["return", "enter"].includes(event.name)) return "ShiftEnter";
  if (event.shift && event.name === "up") return "PageUp";
  if (event.shift && event.name === "down") return "PageDown";
  if (event.shift && event.name === "tab") return "ShiftTab";
  if (editing) {
    if (event.meta || event.option) {
      const key = ({ left: "WordLeft", b: "WordLeft", right: "WordRight", f: "WordRight", backspace: "DeleteWordLeft", delete: "DeleteWordRight", d: "DeleteWordRight", "<": "BufferHome", ">": "BufferEnd" } as Record<string, string>)[event.name];
      if (key) return key;
    }
    if (event.ctrl) {
      const key = ({ a: "Home", e: "End", b: "ArrowLeft", f: "ArrowRight", p: "ArrowUp", n: "ArrowDown", h: "Backspace", d: "Delete", w: "DeleteWordLeft", u: "KillLineLeft", k: "KillLineRight", j: "ShiftEnter", left: "WordLeft", right: "WordRight", home: "BufferHome", end: "BufferEnd" } as Record<string, string>)[event.name];
      if (key) return key;
    }
  }
  if (event.ctrl && event.name === "o") return "Attach";
  if (event.ctrl && event.name === "k") return "Find";
  if (event.ctrl && event.name === "f") return "MessageSearch";
  if (event.ctrl || event.meta || event.option) return "";
  if (event.shift && event.name.toLowerCase() === "r") return "R";
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
  const { TextRenderable, RGBA } = await import("@opentui/core");
  let width = renderer.width;
  let height = renderer.height;
  const text = new TextRenderable(renderer, {
    id: "inboxd-interactive-screen",
    content: styleWorkspace(renderScreen(controller.state, { width, height }), controller.state, { width, height }),
    onMouseScroll(event) {
      if (event.scroll?.direction === "up" || event.scroll?.direction === "down") {
        event.preventDefault();
        void controller.dispatchKey(event.scroll.direction === "up" ? "PageUp" : "PageDown");
      }
    },
    onMouseDown(event) {
      const state = controller.state;
      if (state.detailOpen || state.composeActive || state.searchActive || !["inbox", "chat"].includes(state.screen)) return;
      const split = width >= 80;
      const bodyHeight = workspaceBodyHeight(state, height);
      if (split && event.x < sidebarWidth(width) && event.y >= 5 && event.y < bodyHeight + 2) {
        const index = sidebarStart(state, bodyHeight) + Math.floor((event.y - 5) / 3);
        void controller.selectConversation(index);
      } else { controller.focusMessages(); }
      event.preventDefault();
    },
  });
  renderer.root.add(text);

  let renderedState = controller.state;
  const update = (state: TuiState): void => {
    if (renderer.isDestroyed) return;
    controller.setViewport(width, height);
    renderedState = state;
    const content = renderScreen(state, { width, height });
    const lines = content.split("\n");
    const row = lines.findIndex(line => line.includes(CURSOR_MARK));
    text.content = styleWorkspace(content.replaceAll(CURSOR_MARK, ""), state, { width, height });
    renderer.setCursorStyle({ style: "block", blinking: true });
    renderer.setCursorColor(RGBA.fromHex("#91BAF5"));
    renderer.setCursorPosition(row < 0 ? 0 : displayWidth(lines[row]!.split(CURSOR_MARK)[0]!) + 1, row + 1, row >= 0);
  };
  // OpenTUI emits frame only after the native buffer has actually rendered.
  const onFrame = (): void => {
    if (renderer.isDestroyed || controller.state !== renderedState) return;
    const observation = renderedObservation(renderedState, { width, height });
    controller.observeRendered(observation.slices, observation.suggestionVisible);
  };
  const onKeypress = (event: KeyEvent): void => {
    if (renderer.isDestroyed) return;
    const key = actionKey(event, controller.state.composeActive && controller.state.pane === "messages");
    event.preventDefault();
    if (key) void controller.dispatchKey(key);
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
  update(controller.state);
  renderer.keyInput.on("keypress", onKeypress);
  renderer.keyInput.on("paste", onPaste);
  renderer.on("resize", onResize);
  renderer.on("frame", onFrame);
  return {
    destroy: () => {
      unsubscribe();
      renderer.keyInput.off("keypress", onKeypress);
      renderer.keyInput.off("paste", onPaste);
      renderer.off("resize", onResize);
      renderer.off("frame", onFrame);
      renderer.setCursorPosition(0, 0, false);
      text.destroy();
    },
  };
}
