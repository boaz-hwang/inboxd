import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const clientPackages = ["cli", "tui", "mcp", "host", "connect"] as const;
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

function forbidden(specifier: string): boolean {
  return specifier === "bun:sqlite" || specifier === "bun:ffi"
    || /(?:^|\/)packages\/(?:native|store|sync|safety|daemon|accounts)(?:\/|$)/.test(specifier)
    || /(?:^|\.\.\/)(?:native|store|sync|safety|daemon|accounts)(?:\/|$)/.test(specifier)
    || /(?:^|\/)platforms(?:\/|$)|(?:^|\/)contrib(?:\/|$)/.test(specifier)
    || /^@inboxd\/(?:native|store|sync|safety|daemon|accounts)$/.test(specifier);
}

function inboxdCore(specifier: string): boolean {
  return specifier === "@inboxd/core" || /(?:^|\/)packages\/core(?:\/|$)|(?:^|\.\.\/)core(?:\/|$)/.test(specifier);
}

const violations: string[] = [];
const parser = new Bun.Transpiler({ loader: "ts" });
for (const packageName of clientPackages) {
  const root = join(import.meta.dir, "..", "packages", packageName, "src");
  for (const file of await walk(root)) {
    const text = await Bun.file(file).text();
    for (const entry of parser.scanImports(text)) {
      const specifier = entry.path;
      // scanImports intentionally omits `import type`, so core types remain
      // shareable while static and dynamic runtime imports are rejected.
      const runtimeCore = inboxdCore(specifier);
      const connectionImport = /(?:^|\/)(?:connect|setup-runtime)(?:\/|\.|$)/.test(specifier);
      const uiImport = /(?:^|\/)(?:cli|tui|mcp)(?:\/|$)/.test(specifier);
      const importsProvider = /(?:^|\/)(?:platforms|contrib)(?:\/|$)|^agent-messenger/.test(specifier);
      const dataInternals = specifier === "bun:sqlite" || specifier === "bun:ffi"
        || /(?:^|\/)(?:native|store|sync|safety|daemon|accounts)(?:\/|$)/.test(specifier) || runtimeCore;
      const invalid = packageName === "connect"
        ? dataInternals || uiImport || (importsProvider && !file.includes(`${join("src", "drivers")}/`))
        : packageName === "host"
          ? dataInternals || uiImport || connectionImport || importsProvider
          : forbidden(specifier) || runtimeCore || (connectionImport && packageName !== "cli");
      if (specifier !== undefined && invalid) {
        const index = text.indexOf(specifier);
        const line = text.slice(0, Math.max(index, 0)).split("\n").length;
        violations.push(`${relative(join(import.meta.dir, ".."), file)}:${line}: ${specifier}`);
      }
    }
  }
}
if (violations.length) {
  console.error("Client boundary violations detected:");
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("CLI/TUI/MCP + connection/host import boundaries: OK");
