// The installable bundle's invariants: the specifier/row rewrites the assembly
// applies, and the assembled package's manifest — no dependencies (a tarball
// must install with no registry), every imports target on disk, every patch row
// naming something the package actually exports.
//   node tools/checks/tests/bundle.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { walk } from "../../vendor-layerfs.mjs";
import { fileURLToPath } from "node:url";
import { rewriteRows } from "../../assemble-bundle.mjs";
import { rewriteSpecifiers } from "../../vendor-layerfs.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DIST = join(ROOT, "dist");

// vendoring: module specifiers only, never the prose that mentions the packages
{
  assert.equal(rewriteSpecifiers('import { layerfs } from "@layerfs/agent";'), 'import { layerfs } from "#layerfs/agent";');
  assert.equal(rewriteSpecifiers('export * from "@layerfs/agent/internal";'), 'export * from "#layerfs/agent/internal";');
  assert.equal(rewriteSpecifiers('const { LayerFS } = await import("@layerfs/agent");'), 'const { LayerFS } = await import("#layerfs/agent");');
  assert.equal(rewriteSpecifiers('import "@layerfs/runtime";'), 'import "#layerfs/runtime";');
  // a comment that names the package keeps its words
  assert.equal(rewriteSpecifiers('// @layerfs/agent as agents\' scripts import it'), '// @layerfs/agent as agents\' scripts import it');
  // and a longer name is not clipped by a shorter one
  assert.equal(rewriteSpecifiers('from "@layerfs/agent/internal"'), 'from "#layerfs/agent/internal"');
}

// rows: the host row names the bundle itself, the client row is gone, an unknown row is loud
{
  const source = [
    "- insert:",
    "    - id: layerfs-host",
    "      name: '@dsh-layerfs/host'",
    "    - id: layerfs-client",
    "      name: '@dsh-layerfs/client'",
    "    - id: layerfs-mock",
    "      name: '@dsh-layerfs/mock'",
  ].join("\n");
  const assembled = rewriteRows(source).split("\n");
  assert.deepEqual(assembled, ["- insert:", "    - id: layerfs-host", "      name: 'dsh-layerfs'", "    - id: layerfs-mock", "      name: 'dsh-layerfs/mock'"]);
  assert.throws(() => rewriteRows(source.replace("layerfs-mock", "layerfs-extra")), /no ROWS entry/);
}

// the vendored SDK names no bare @layerfs specifier anywhere: import, export
// re-export, dynamic import and import.meta.resolve — a position this rewrite
// misses resolves against the consumer's tree and fails at run time (the
// Windows identity check hid one until it was caught)
{
  const vendor = join(ROOT, "packages", "host", "vendor", "layerfs");
  const offenders = [];
  for (const path of walk(vendor)) {
    if (!path.endsWith(".js")) continue;
    const text = readFileSync(join(vendor, path), "utf8");
    // a specifier position, not the words in a comment or in an error message
    const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bimport\.meta\.resolve\(\s*)(["'])[^"']*@layerfs\//g;
    for (const match of text.match(pattern) ?? []) offenders.push(`${path}: ${match}`);
  }
  assert.deepEqual(offenders, [], "bare @layerfs specifiers left in the vendored tree");
}

// the assembled package, when it has been built
if (existsSync(DIST)) {
  const manifest = JSON.parse(readFileSync(join(DIST, "package.json"), "utf8"));
  // a dependency would send pnpm to a registry that does not have these packages
  assert.deepEqual(manifest.dependencies ?? {}, {}, "the bundle must carry every package it runs, not declare one");
  for (const [name, target] of Object.entries(manifest.imports)) {
    // a wildcard target is a pattern: the directory it fills in has to exist
    const path = target.endsWith("/*") ? target.slice(0, -1) : target;
    assert.ok(existsSync(join(DIST, path)), `${name} -> ${target} is not in the bundle`);
  }
  // every patch row names a specifier the package exports
  const rows = readFileSync(join(DIST, "cordis.patch.yml"), "utf8");
  const names = [...rows.matchAll(/name: '([^']+)'/g)].map(([, name]) => name).filter((name) => name !== "@deepseek-ai/dsh-agent-preset");
  assert.deepEqual(names.sort(), ["dsh-layerfs", "dsh-layerfs/mock"], "the patch rows of the assembled bundle");
  for (const name of names) {
    const subpath = name.includes("/") ? `./${name.slice(name.indexOf("/") + 1)}` : ".";
    assert.ok(manifest.exports[subpath], `row ${name} exports ${subpath}`);
    assert.ok(existsSync(join(DIST, manifest.exports[subpath])), `row ${name} -> ${manifest.exports[subpath]} is not in the bundle`);
  }
  // the client half: a row resolves to a package root, and that root declares dsh.client and exports "./client"
  assert.equal(manifest.dsh.client.platform, "web");
  assert.ok(existsSync(join(DIST, manifest.exports["./client"])), "the client bundle ships");
  assert.equal(manifest.dsh.bundle.patch.length, 3);
  for (const patch of manifest.dsh.bundle.patch) assert.ok(existsSync(join(DIST, patch)), `bundle patch ${patch}`);
  // nothing in the bundle points back at this checkout
  assert.ok(!JSON.stringify(manifest.imports).includes(ROOT), "the bundle must not import through this checkout");
  assert.ok(isAbsolute(join(DIST, "package.json")));
}
console.log("bundle: ok");
