import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeAttachment, readSelectedAttachment } from "../src/attachments.ts";

test("selected bytes are checked again before upload, including same-sized edits and replaced symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attachment-test-"));
  try {
    const path = join(dir, "한글.txt");
    await writeFile(path, "abc");
    const file = await describeAttachment(path);
    expect(file).toMatchObject({ name: "한글.txt", size: 3 });
    expect((await readSelectedAttachment(file)).toString()).toBe("abc");
    await writeFile(path, "xyz");
    await expect(readSelectedAttachment(file)).rejects.toThrow("변경");
    await rm(path); await writeFile(join(dir, "other"), "abc"); await symlink(join(dir, "other"), path);
    await expect(readSelectedAttachment(file)).rejects.toThrow();
    await rm(path); await writeFile(path, "");
    await expect(describeAttachment(path)).rejects.toThrow("100 MiB");
    await truncate(path, 104857601);
    await expect(describeAttachment(path)).rejects.toThrow("100 MiB");
    await expect(describeAttachment(dir)).rejects.toThrow("일반 파일");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
