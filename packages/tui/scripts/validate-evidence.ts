import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { displayWidth } from "../src/index.ts";

interface CaptureManifest {
  schema: string;
  base: string;
  working_tree_base: string;
  runtime: string;
  source_hashes: Record<string, string>;
  captures: Record<string, string>;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const directory = join(import.meta.dir, "..", "rendered");
const names = (await readdir(directory)).filter((name) => name.endsWith(".txt")).sort();
if (names.length === 0) throw new Error("no TUI captures found");

for (const name of names) {
  const match = /-(\d+)x(\d+)\.txt$/.exec(name);
  if (match === null) throw new Error(`capture name has no dimensions: ${name}`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const content = await readFile(join(directory, name), "utf8");
  if (content.includes("\x1b")) throw new Error(`terminal escape byte found: ${name}`);
  const lines = content.split("\n");
  if (lines.length !== height) throw new Error(`${name}: expected ${height} rows, received ${lines.length}`);
  for (const [index, line] of lines.entries()) {
    if (displayWidth(line) !== width) throw new Error(`${name}:${index + 1}: expected ${width} cells, received ${displayWidth(line)}`);
  }
}

const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as CaptureManifest;
if (manifest.schema !== "inboxd.tui.capture-manifest.v1") throw new Error(`unexpected manifest schema: ${manifest.schema}`);
if (!/^[a-f0-9]{40}$/.test(manifest.base) || !/^[a-f0-9]{40}$/.test(manifest.working_tree_base)) {
  throw new Error("manifest revisions must be full commit hashes");
}
if (typeof manifest.runtime !== "string" || manifest.runtime.length === 0) throw new Error("manifest runtime is required");

const manifestNames = Object.keys(manifest.captures).sort();
if (JSON.stringify(manifestNames) !== JSON.stringify(names)) throw new Error("manifest capture inventory does not match rendered files");
for (const name of names) {
  const actual = sha256(await readFile(join(directory, name)));
  if (manifest.captures[name] !== actual) throw new Error(`capture hash mismatch: ${name}`);
}

const sourcePaths = {
  renderer: join(import.meta.dir, "..", "src", "index.ts"),
  runtime: join(import.meta.dir, "..", "src", "runtime.ts"),
  generator: join(import.meta.dir, "render-evidence.ts"),
};
if (JSON.stringify(Object.keys(manifest.source_hashes).sort()) !== JSON.stringify(Object.keys(sourcePaths).sort())) {
  throw new Error("manifest source hash inventory does not match renderer sources");
}
for (const [name, path] of Object.entries(sourcePaths)) {
  const actual = sha256(await readFile(path));
  if (manifest.source_hashes[name] !== actual) throw new Error(`source hash mismatch: ${name}`);
}

console.log(`validated ${names.length} captures: exact rows/cells, no ANSI, capture hashes, and source hashes`);
