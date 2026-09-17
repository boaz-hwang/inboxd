import { renderScreen, type TuiController, type TuiState } from "./index.ts";

export interface OpenTuiKeyEvent {
  readonly name: string;
  readonly sequence: string;
  preventDefault(): void;
}

export interface OpenTuiRenderer {
  readonly root: { add(renderable: unknown): unknown };
  readonly keyInput: {
    on(event: "keypress", listener: (event: OpenTuiKeyEvent) => void): unknown;
    off(event: "keypress", listener: (event: OpenTuiKeyEvent) => void): unknown;
  };
  readonly width: number;
  readonly height: number;
  on?(event: "resize", listener: (width: number, height: number) => void): unknown;
  off?(event: "resize", listener: (width: number, height: number) => void): unknown;
}

export interface MountedInteractiveTui {
  destroy(): void;
}

function actionKey(event: OpenTuiKeyEvent): string {
  switch (event.name) {
    case "return": return "Enter";
    case "escape": return "Escape";
    case "up": return "ArrowUp";
    case "down": return "ArrowDown";
    case "backspace": return "Backspace";
    case "pagedown": return "PageDown";
    case "pageup": return "PageUp";
    case "home": return "Home";
    default: return event.sequence.length === 1 ? event.sequence : event.name;
  }
}

/**
 * Imperative OpenTUI bridge. Rendering stays a projection of TuiState while
 * renderer keypresses feed the controller; no terminal event reaches storage.
 */
export async function mountInteractiveTui(renderer: OpenTuiRenderer, controller: TuiController): Promise<MountedInteractiveTui> {
  const coreModule = "@opentui/core";
  const { TextRenderable } = await import(coreModule);
  let width = renderer.width;
  let height = renderer.height;
  const text = new TextRenderable(renderer as never, {
    id: "inboxd-interactive-screen",
    content: renderScreen(controller.state, { width, height }, { approvalCode: controller.currentApprovalCode() }),
  });
  renderer.root.add(text);

  const update = (state: TuiState): void => { text.content = renderScreen(state, { width, height }, { approvalCode: controller.currentApprovalCode() }); };
  const onKeypress = (event: OpenTuiKeyEvent): void => {
    const key = actionKey(event);
    event.preventDefault();
    void controller.dispatchKey(key);
  };
  const onResize = (nextWidth: number, nextHeight: number): void => {
    width = nextWidth;
    height = nextHeight;
    update(controller.state);
  };

  const unsubscribe = controller.subscribe(update);
  renderer.keyInput.on("keypress", onKeypress);
  renderer.on?.("resize", onResize);
  return {
    destroy: () => {
      unsubscribe();
      renderer.keyInput.off("keypress", onKeypress);
      renderer.off?.("resize", onResize);
      text.destroy();
    },
  };
}
