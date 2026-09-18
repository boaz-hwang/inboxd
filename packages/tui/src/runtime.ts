import type { CliRenderer, KeyEvent, PasteEvent } from "@opentui/core";

import { renderScreen, type TuiController, type TuiState } from "./index.ts";

export interface MountedInteractiveTui {
  destroy(): void;
}

function actionKey(event: KeyEvent): string {
  switch (event.name) {
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
    return value.length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Imperative OpenTUI bridge. Rendering stays a projection of TuiState while
 * renderer keypresses feed the controller; no terminal event reaches storage.
 */
export async function mountInteractiveTui(renderer: CliRenderer, controller: TuiController): Promise<MountedInteractiveTui> {
  const coreModule = "@opentui/core";
  const { TextRenderable } = await import(coreModule);
  let width = renderer.width;
  let height = renderer.height;
  const text = new TextRenderable(renderer, {
    id: "inboxd-interactive-screen",
    content: renderScreen(controller.state, { width, height }, { approvalCode: controller.currentApprovalCode() }),
  });
  renderer.root.add(text);

  const update = (state: TuiState): void => { text.content = renderScreen(state, { width, height }, { approvalCode: controller.currentApprovalCode() }); };
  const onKeypress = (event: KeyEvent): void => {
    const key = actionKey(event);
    event.preventDefault();
    void controller.dispatchKey(key);
  };
  const onPaste = (event: PasteEvent): void => {
    const text = pastedText(event);
    event.preventDefault();
    if (text !== undefined) void controller.dispatchKey(text);
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
