export type TelegramAuthPhase =
  | "ready"
  | "waitTdlibParameters"
  | "waitPhoneNumber"
  | "waitEmailAddress"
  | "waitEmailCode"
  | "waitCode"
  | "waitOtherDeviceConfirmation"
  | "waitRegistration"
  | "waitPassword"
  | "loggingOut"
  | "closing"
  | "closed"
  | "unknown";

export interface TdlibAuthorizationState {
  readonly "@type": string;
}

export interface TelegramAuthObservation {
  readonly phase: TelegramAuthPhase;
  readonly health: "ready" | "degraded" | "unavailable";
  readonly auth:
    | { readonly state: "authenticated"; readonly reason: null; readonly observed_at: number }
    | { readonly state: "unauthenticated" | "unknown"; readonly reason: string; readonly observed_at: number };
}

const WAITING_STATES = new Map<string, TelegramAuthPhase>([
  ["authorizationStateWaitTdlibParameters", "waitTdlibParameters"],
  ["authorizationStateWaitPhoneNumber", "waitPhoneNumber"],
  ["authorizationStateWaitEmailAddress", "waitEmailAddress"],
  ["authorizationStateWaitEmailCode", "waitEmailCode"],
  ["authorizationStateWaitCode", "waitCode"],
  ["authorizationStateWaitOtherDeviceConfirmation", "waitOtherDeviceConfirmation"],
  ["authorizationStateWaitRegistration", "waitRegistration"],
  ["authorizationStateWaitPassword", "waitPassword"],
]);

const UNAVAILABLE_STATES = new Map<string, TelegramAuthPhase>([
  ["authorizationStateLoggingOut", "loggingOut"],
  ["authorizationStateClosing", "closing"],
  ["authorizationStateClosed", "closed"],
]);

function stateType(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("TDLib authorization state must be an object");
  }
  const type = (value as Record<string, unknown>)["@type"];
  if (typeof type !== "string" || type.length === 0) {
    throw new TypeError("TDLib authorization state requires @type");
  }
  return type;
}

function observationTime(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError("authorization observation time must be finite and non-negative");
  }
  return value;
}

export class TelegramAuthStateMachine {
  #phase: TelegramAuthPhase = "unknown";

  observe(value: unknown, observedAt: number): TelegramAuthObservation {
    const type = stateType(value);
    const observed_at = observationTime(observedAt);

    if (type === "authorizationStateReady") {
      this.#phase = "ready";
      return {
        phase: "ready",
        health: "ready",
        auth: { state: "authenticated", reason: null, observed_at },
      };
    }

    const waiting = WAITING_STATES.get(type);
    if (waiting !== undefined) {
      this.#phase = waiting;
      return {
        phase: waiting,
        health: "degraded",
        auth: { state: "unauthenticated", reason: type, observed_at },
      };
    }

    const unavailable = UNAVAILABLE_STATES.get(type);
    if (unavailable !== undefined) {
      this.#phase = unavailable;
      return {
        phase: unavailable,
        health: "unavailable",
        auth: { state: "unknown", reason: type, observed_at },
      };
    }

    this.#phase = "unknown";
    return {
      phase: "unknown",
      health: "unavailable",
      auth: { state: "unknown", reason: "unknown_authorization_state", observed_at },
    };
  }

  isReady(): boolean {
    return this.#phase === "ready";
  }
}
