import { describe, expect, test } from "bun:test";

import { TelegramAuthStateMachine, type TelegramAuthPhase } from "../src/auth.ts";

const waitingStates = [
  "authorizationStateWaitTdlibParameters",
  "authorizationStateWaitPhoneNumber",
  "authorizationStateWaitEmailAddress",
  "authorizationStateWaitEmailCode",
  "authorizationStateWaitCode",
  "authorizationStateWaitOtherDeviceConfirmation",
  "authorizationStateWaitRegistration",
  "authorizationStateWaitPassword",
] as const;

const unavailableStates = [
  "authorizationStateLoggingOut",
  "authorizationStateClosing",
  "authorizationStateClosed",
] as const;

describe("Telegram TDLib authorization state machine", () => {
  test("maps TDLib ready to authenticated capability evidence", () => {
    const machine = new TelegramAuthStateMachine();

    expect(machine.observe({ "@type": "authorizationStateReady" }, 1_700_000_000)).toEqual({
      phase: "ready",
      health: "ready",
      auth: { state: "authenticated", reason: null, observed_at: 1_700_000_000 },
    });
    expect(machine.isReady()).toBe(true);
  });

  test("keeps every interactive login state explicitly unauthenticated", () => {
    for (const type of waitingStates) {
      const machine = new TelegramAuthStateMachine();
      const phase = type.replace("authorizationState", "").replace(
        /^[A-Z]/,
        (value) => value.toLowerCase(),
      ) as TelegramAuthPhase;
      expect(machine.observe({ "@type": type }, 42)).toEqual({
        phase,
        health: "degraded",
        auth: { state: "unauthenticated", reason: type, observed_at: 42 },
      });
      expect(machine.isReady()).toBe(false);
    }
  });

  test("treats shutdown and unknown TDLib states as unavailable, never authenticated", () => {
    for (const type of unavailableStates) {
      const machine = new TelegramAuthStateMachine();
      expect(machine.observe({ "@type": type }, 43)).toMatchObject({
        health: "unavailable",
        auth: { state: "unknown", reason: type, observed_at: 43 },
      });
      expect(machine.isReady()).toBe(false);
    }

    const machine = new TelegramAuthStateMachine();
    expect(machine.observe({ "@type": "authorizationStateFuture" }, 44)).toEqual({
      phase: "unknown",
      health: "unavailable",
      auth: { state: "unknown", reason: "unknown_authorization_state", observed_at: 44 },
    });
  });

  test("rejects malformed states and observation times without changing readiness", () => {
    const machine = new TelegramAuthStateMachine();
    machine.observe({ "@type": "authorizationStateReady" }, 1);

    for (const [state, observedAt] of [
      [null, 2],
      [{}, 2],
      [{ "@type": "authorizationStateReady" }, Number.NaN],
      [{ "@type": "authorizationStateReady" }, -1],
    ] as const) {
      expect(() => machine.observe(state, observedAt)).toThrow();
      expect(machine.isReady()).toBe(true);
    }
  });
});
