#!/usr/bin/env bun
/**
 * Walk local static ESM imports and reject circular module dependencies.
 *
 * The scanner intentionally follows only relative specifiers: package and
 * Node built-in imports cannot contribute an edge inside event-runtime/lib.
 * It handles the static forms supported by this codebase (`import ... from`,
 * side-effect imports, and `export ... from`) without executing any modules.
 */
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const SOURCE_ROOT = path.resolve(
  import.meta.dirname,
  "../event-runtime/lib",
);
const WORD = /[A-Za-z0-9_$]/;

function skipQuoted(source, index) {
  const quote = source[index++];
  while (index < source.length) {
    if (source[index] === "\\") index += 2;
    else if (source[index++] === quote) break;
  }
  return index;
}

function skipTrivia(source, index) {
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index++;
    } else if (source.startsWith("//", index)) {
      index = source.indexOf("\n", index + 2);
      if (index === -1) return source.length;
    } else if (source.startsWith("/*", index)) {
      index = source.indexOf("*/", index + 2);
      if (index === -1) return source.length;
      index += 2;
    } else {
      break;
    }
  }
  return index;
}

function readSpecifier(source, index) {
  const start = source[index];
  if (start !== '"' && start !== "'") return null;
  const end = skipQuoted(source, index);
  return source.slice(index + 1, end - 1);
}

function findFromSpecifier(source, index) {
  for (let cursor = index; cursor < source.length; cursor++) {
    if (
      source[cursor] === '"' ||
      source[cursor] === "'" ||
      source[cursor] === "`"
    ) {
      cursor = skipQuoted(source, cursor) - 1;
      continue;
    }
    if (source.startsWith("//", cursor) || source.startsWith("/*", cursor)) {
      cursor = skipTrivia(source, cursor) - 1;
      continue;
    }
    if (
      source.startsWith("from", cursor) &&
      !WORD.test(source[cursor - 1] ?? "") &&
      !WORD.test(source[cursor + 4] ?? "")
    ) {
      return readSpecifier(source, skipTrivia(source, cursor + 4));
    }
    if (source[cursor] === ";") return null;
  }
  return null;
}

export function staticSpecifiers(source) {
  const specifiers = [];
  for (let index = 0; index < source.length; index++) {
    if (
      source[index] === '"' ||
      source[index] === "'" ||
      source[index] === "`"
    ) {
      index = skipQuoted(source, index) - 1;
      continue;
    }
    if (source.startsWith("//", index) || source.startsWith("/*", index)) {
      index = skipTrivia(source, index) - 1;
      continue;
    }

    const keyword = source.startsWith("import", index)
      ? "import"
      : source.startsWith("export", index)
        ? "export"
        : null;
    if (
      !keyword ||
      WORD.test(source[index - 1] ?? "") ||
      WORD.test(source[index + keyword.length] ?? "")
    ) {
      continue;
    }

    const afterKeyword = skipTrivia(source, index + keyword.length);
    if (keyword === "import" && source[afterKeyword] === "(") continue;
    const specifier =
      readSpecifier(source, afterKeyword) ??
      findFromSpecifier(source, afterKeyword);
    if (specifier) specifiers.push(specifier);
    index = afterKeyword;
  }
  return specifiers;
}

function sourceFiles(root) {
  // Sort explicitly: readdirSync returns filesystem order, and this detector
  // reports one cycle per multi-cycle SCC, so which cycle it reports depends on
  // the DFS start order. An unsorted list makes the baseline (and therefore the
  // staleness check) non-deterministic across machines.
  return readdirSync(root, { recursive: true })
    .filter((entry) => entry.endsWith(".mjs"))
    .sort()
    .map((entry) => path.join(root, entry));
}

export function resolveRelativeImport(from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const raw = specifier.replace(/[?#].*$/, "");
  const base = path.resolve(path.dirname(from), raw);
  for (const candidate of [base, `${base}.mjs`, path.join(base, "index.mjs")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
}

export function findImportCycles(root) {
  const resolvedRoot = path.resolve(root);
  const graph = new Map();
  for (const file of sourceFiles(resolvedRoot)) {
    const dependencies = staticSpecifiers(readFileSync(file, "utf8"))
      .map((specifier) => resolveRelativeImport(file, specifier))
      .filter((dependency) =>
        dependency?.startsWith(`${resolvedRoot}${path.sep}`),
      );
    graph.set(file, dependencies);
  }

  const cycles = [];
  // This traversal visits each module once, so it detects back edges but does
  // not enumerate every distinct simple cycle within a multi-cycle SCC.
  // Keep the baseline aligned with this detector's output, not an all-cycles
  // enumeration, until the detector is replaced with one that provides that.
  const visited = new Set();
  const active = [];
  const activeSet = new Set();
  function visit(file) {
    if (activeSet.has(file)) {
      cycles.push([...active.slice(active.indexOf(file)), file]);
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    active.push(file);
    activeSet.add(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    active.pop();
    activeSet.delete(file);
  }
  for (const file of graph.keys()) visit(file);
  return cycles;
}

function canonicalCycle(cycle, root) {
  const files = cycle.slice(0, -1).map((file) => path.relative(root, file));
  const rotations = files.map((_, start) => [
    ...files.slice(start),
    ...files.slice(0, start),
  ]);
  return rotations
    .map((rotation) => [...rotation, rotation[0]].join(" -> "))
    .sort()[0];
}

export function assertNoImportCycles(root, knownBaselineCycles = new Set()) {
  const cycles = findImportCycles(root);
  const foundCycles = new Set(
    cycles.map((cycle) => canonicalCycle(cycle, root)),
  );
  const unallowlisted = [...foundCycles].filter(
    (cycle) => !knownBaselineCycles.has(cycle),
  );
  const stale = [...knownBaselineCycles].filter(
    (cycle) => !foundCycles.has(cycle),
  );
  if (unallowlisted.length === 0 && stale.length === 0) return cycles.length;

  const errors = [];
  if (unallowlisted.length > 0) {
    errors.push(
      `Import cycles detected:\n${unallowlisted.map((cycle) => `  ${cycle}`).join("\n")}`,
    );
  }
  if (stale.length > 0) {
    errors.push(
      `Import cycle allowlist is stale:\n${stale.map((cycle) => `  ${cycle}`).join("\n")}`,
    );
  }
  throw new Error(errors.join("\n"));
}

function runSelfTest() {
  const fixture = mkdtempSync(path.join(tmpdir(), "factory-import-cycle-"));
  try {
    writeFileSync(path.join(fixture, "first.mjs"), 'import "./second.mjs";\n');
    writeFileSync(
      path.join(fixture, "second.mjs"),
      'export { value } from "./first.mjs";\n',
    );
    try {
      assertNoImportCycles(fixture, new Set());
      throw new Error("self-test fixture did not fail cycle detection");
    } catch (error) {
      if (
        !String(error.message).includes("first.mjs -> second.mjs -> first.mjs")
      )
        throw error;
    }
    console.log(
      "import-cycle self-test: detected first.mjs -> second.mjs -> first.mjs",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

if (process.argv.includes("--self-test")) runSelfTest();
else {
  assertNoImportCycles(SOURCE_ROOT);
  console.log("import-cycle check: event-runtime/lib has no import cycles");
}
