import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { displayWidth } from "../src/index.ts";

const directory = join(import.meta.dir, "..", "rendered");
const names = (await readdir(directory)).filter((name) => name.endsWith(".txt")).sort();
if (names.length === 0) throw new Error("no TUI captures found");

for (const name of names) {
  const match = /-(\d+)x(\d+)\.txt$/.exec(name);
  if (match === null) throw new Error(`capture name has no dimensions: ${name}`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const content = await readFile(join(directory, name), "utf8");
  if (/\x1b\[[0-?]*[ -/]*[@-~]/.test(content)) throw new Error(`terminal escape sequence found: ${name}`);
  const lines = content.split("\n");
  if (lines.length !== height) throw new Error(`${name}: expected ${height} rows, received ${lines.length}`);
  for (const [index, line] of lines.entries()) {
    if (displayWidth(line) !== width) throw new Error(`${name}:${index + 1}: expected ${width} cells, received ${displayWidth(line)}`);
  }
}

console.log(`validated ${names.length} captures at exact terminal-cell dimensions`);
