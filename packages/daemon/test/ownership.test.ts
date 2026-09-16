import { describe, expect, test } from "bun:test";

import { acquireSingleInstanceLock } from "../src/lock.ts";
import { createDaemonFixture } from "./fixtures/daemon-fixture.ts";

describe("lock ownership", () => {
  test("exclusive filesystem lock exposes no database handle or path", () => {
    const fixture = createDaemonFixture();
    try {
      const lock = acquireSingleInstanceLock(fixture.directory);
      expect(Object.keys(lock).sort()).toEqual(["release"]);
      lock.release();
    } finally {
      fixture.dispose();
    }
  });
});
