import { expect, test } from "bun:test";
import { createTuiController } from "../src/index.ts";
import { EVENT_METHODS, type JsonObject } from "../../protocol/src/schema.ts";

function diagnostics() {
  const calls: string[] = [];
  let version = 1;
  const controller = createTuiController({ client: {
    start: async () => {}, stop: () => {},
    request: async method => {
      calls.push(method);
      if (method === "system.status") return { encryption: { ready: true, schema_version: version } };
      if (method === "sync.status") return { state: version === 1 ? "idle" : "cooldown" };
      if (method === "auth.status") return { authenticated: version === 1 };
      return {};
    },
  } });
  return { controller, calls, change: () => { version++; } };
}

test.each(["switch", "reselect", "open"])("Doctor refreshes on %s without requiring an event", async action => {
  const { controller, calls, change } = diagnostics();
  try {
    await controller.start();
    if (action !== "switch") await controller.dispatchKey("5");
    change(); calls.length = 0;
    await controller.dispatchKey(action === "open" ? "Enter" : "5");
    expect(calls).toEqual(["system.status", "sync.status", "auth.status"]);
    expectFresh(controller);
  } finally { controller.stop(); }
});

test("a failed refresh never presents prior successful auth or sync probes as current", async () => {
  let failing = false;
  const controller = createTuiController({ client: {
    start: async () => {}, stop: () => {},
    request: async method => {
      if (method === "system.status") return { auth: { slack: "authenticated" }, sync: { slack: { state: "idle" } } };
      if (method === "sync.status" || method === "auth.status") {
        if (failing) throw new Error("probe unavailable");
        return { state: "idle", authenticated: true };
      }
      return {};
    },
  } });
  try {
    await controller.start(); failing = true;
    await controller.dispatchKey("5");
    for (const id of ["authentication", "sync"]) {
      expect(controller.state.views.doctor.data.find(row => row.id === id)).toMatchObject({ state: "unknown" });
    }
  } finally { controller.stop(); }
});

test("Doctor does not continue probes from a stopped generation", async () => {
  const oldSync = Promise.withResolvers<JsonObject>();
  const calls: string[] = [];
  let block = false;
  const controller = createTuiController({ client: {
    start: async () => {}, stop: () => {},
    request: async method => {
      calls.push(method);
      if (method === "sync.status" && block) return oldSync.promise;
      return {};
    },
  } });
  await controller.start(); block = true;
  const refreshing = controller.dispatchKey("5");
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  controller.stop();
  const stopped = controller.state;
  calls.length = 0;
  oldSync.resolve({ state: "late" }); await refreshing;
  expect(calls).toEqual([]);
  expect(controller.state).toBe(stopped);
});

function expectFresh(controller: ReturnType<typeof createTuiController>) {
  expect(controller.state.views.doctor.data).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "encryption", evidenceLines: ["Cipher: unknown", "Schema: 2"] }),
    expect.objectContaining({ id: "sync", state: "cooldown" }),
    expect.objectContaining({ id: "authentication", state: "authenticated=false" }),
  ]));
}

test.each([...EVENT_METHODS])("Doctor re-probes changed diagnostics on %s", async method => {
  const { controller, calls, change } = diagnostics();
  try {
    await controller.start();
    change(); calls.length = 0;
    await controller.receiveEvent(method);
    expect(calls.filter(call => ["system.status", "sync.status", "auth.status"].includes(call)))
      .toEqual(["system.status", "sync.status", "auth.status"]);
    expectFresh(controller);
  } finally { controller.stop(); }
});
