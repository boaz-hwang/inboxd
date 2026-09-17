import { expect, test } from "bun:test";
import { createTuiController } from "../src/index.ts";
import type { JsonObject } from "../../protocol/src/schema.ts";

const scope = { platform: "slack", account: "work", chat_id: "ops" };
const intent = { intent_id: "one", actor: "operator", scope, state: "Proposed", body: "synthetic" };

function fixture(
  claim: () => Promise<JsonObject> = async () => ({ code: "654321" }),
  approve: () => Promise<JsonObject> = async () => ({ state: "Approved" }),
) {
  const calls: string[] = [];
  const snapshots: string[] = [];
  const controller = createTuiController({ onStateChange: state => snapshots.push(JSON.stringify(state)), client: {
    start: async () => {}, stop: () => {},
    request: async method => {
      calls.push(method);
      if (method === "safety.intent.listPending") return { intents: [intent] };
      if (method === "safety.intent.claimApprovalCode") return claim();
      if (method === "safety.intent.approve") return approve();
      return {};
    },
  } });
  return { controller, calls, snapshots };
}

test("claims once into runtime-private memory, keeps it across refresh, clears on disconnect and stop", async () => {
  let claimed = false;
  const { controller, calls, snapshots } = fixture(async () => {
    if (claimed) return { unavailable: true };
    claimed = true;
    return { code: "654321" };
  });
  await controller.start();
  expect(controller.currentApprovalCode()).toBe("654321");
  await controller.receiveEvent("safety.intent.changed");
  expect(calls.filter(method => method === "safety.intent.claimApprovalCode")).toHaveLength(1);
  expect(controller.currentApprovalCode()).toBe("654321");
  expect(snapshots.join("\n")).not.toContain("654321");
  expect(Reflect.ownKeys(controller)).not.toContain("approvalCodes");
  expect(JSON.stringify(controller)).not.toContain("654321");
  const exposed: (string | undefined)[] = [];
  const unsubscribe = controller.subscribe(state => {
    if (state.connection.status !== "connected") exposed.push(controller.currentApprovalCode());
  });
  controller.disconnected();
  unsubscribe();
  expect(exposed).toEqual([undefined]);
  expect(controller.currentApprovalCode()).toBeUndefined();
  await controller.start();
  expect(controller.currentApprovalCode()).toBeUndefined();
  expect(controller.state.views.approvals.data[0]?.codeRequired).toBe(false);
  expect(controller.state.notice).toMatch(/re-propos/i);
  controller.stop();
  expect(controller.currentApprovalCode()).toBeUndefined();
});

test("unavailable delivery requires re-proposal and cannot approve a guessed code", async () => {
  const { controller, calls } = fixture(async () => ({ unavailable: true }));
  await controller.start();
  await controller.dispatchKey("4");
  expect(controller.state.notice).toMatch(/re-propos/i);
  await controller.dispatchKey("a");
  expect(controller.state.approvalPrompt).toBe(false);
  for (const key of "654321") await controller.dispatchKey(key);
  await controller.dispatchKey("Enter");
  expect(calls).not.toContain("safety.intent.approve");
  controller.stop();
});

test("submission clears the claimed code and ordinary refresh never reclaims it", async () => {
  const { controller, calls } = fixture();
  await controller.start();
  await controller.dispatchKey("4"); await controller.dispatchKey("a");
  for (const key of "654321") await controller.dispatchKey(key);
  await controller.dispatchKey("Enter");
  expect(controller.currentApprovalCode()).toBeUndefined();
  expect(controller.state.codeBuffer).toBe("");
  await controller.receiveEvent("safety.intent.changed");
  expect(calls.filter(method => method === "safety.intent.claimApprovalCode")).toHaveLength(1);
  controller.stop();
});

test.each(["disconnect", "stop"])("late delivery cannot repopulate code memory after %s", async action => {
  const delivery = Promise.withResolvers<JsonObject>();
  const started = Promise.withResolvers<void>();
  const { controller } = fixture(() => { started.resolve(); return delivery.promise; });
  const starting = controller.start();
  await started.promise;
  if (action === "stop") controller.stop(); else controller.disconnected();
  delivery.resolve({ code: "654321" });
  await starting;
  expect(controller.currentApprovalCode()).toBeUndefined();
  expect(JSON.stringify(controller.state)).not.toContain("654321");
  controller.stop();
});

test("a newer pending-list refresh cannot discard a valid claim delivered in the same connection", async () => {
  const delivery = Promise.withResolvers<JsonObject>();
  const started = Promise.withResolvers<void>();
  const { controller, calls } = fixture(() => { started.resolve(); return delivery.promise; });
  const starting = controller.start();
  await started.promise;
  await controller.receiveEvent("safety.intent.changed");
  delivery.resolve({ code: "654321" });
  await starting;
  expect(calls.filter(method => method === "safety.intent.claimApprovalCode")).toHaveLength(1);
  expect(controller.currentApprovalCode()).toBe("654321");
  expect(controller.state.views.approvals.data[0]).toMatchObject({ state: "Proposed", codeRequired: true });
  expect(controller.state.notice ?? "").not.toMatch(/re-proposal required/i);
  controller.stop();
});

test("a successful approval RPC renders Failed instead of leaving a phantom Sending row", async () => {
  const { controller } = fixture(undefined, async () => ({ state: "Failed" }));
  await controller.start();
  await controller.dispatchKey("4"); await controller.dispatchKey("a");
  for (const key of "654321") await controller.dispatchKey(key);
  await controller.dispatchKey("Enter");
  expect(controller.state.views.approvals.data[0]?.state).toBe("Failed");
  expect(controller.state.views.approvals.data[0]?.state).not.toBe("Sending");
  controller.stop();
});

test("a rejected approval explains that the cleared one-shot code requires re-proposal", async () => {
  const { controller } = fixture(undefined, async () => { throw new Error("invalid approval code"); });
  await controller.start();
  await controller.dispatchKey("4"); await controller.dispatchKey("a");
  for (const key of "000000") await controller.dispatchKey(key);
  await controller.dispatchKey("Enter");
  expect(controller.state.views.approvals.data[0]).toMatchObject({ state: "Code unavailable", codeRequired: false });
  expect(controller.state.notice).toMatch(/invalid approval code.*re-proposal required/i);
  controller.stop();
});
