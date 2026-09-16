import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..", "packages", "tui");
const prohibited = /(?:@inboxd\/(?:store|sync|safety|daemon)|(?:\.\.\/)+(?:store|sync|safety|daemon)|platforms[\\/])/;
const source = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (source.test(entry.name)) files.push(path);
  }
  return files;
}

const violations: string[] = [];
for (const file of await walk(root)) {
  const text = await Bun.file(file).text();
  for (const [index, line] of text.split("\n").entries()) {
    if (/\b(?:import|export)\b|\brequire\s*\(/.test(line) && prohibited.test(line)) {
      violations.push(`${relative(join(import.meta.dir, ".."), file)}:${index + 1}: ${line.trim()}`);
    }
  }
}
if (violations.length) {
  console.error("TUI boundary violations detected:");
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("TUI import boundaries: OK");
