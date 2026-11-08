// Assembles the installable dsh-layerfs bundle: one self-contained package that
// `dsh plugin add <tarball>` installs with no registry, no LayerFS checkout and
// no hand-written patch.
//
//   node tools/assemble-bundle.mjs          write dist/
//   node tools/assemble-bundle.mjs --check  fail when dist/ is stale
//
// Why one package. The workspace's six packages reach each other through
// `workspace:`/`link:` specs, and pnpm rewrites `workspace:*` into a registry
// version on pack: a tarball packed from packages/dsh-layerfs asks npm for
// @dsh-layerfs/host@0.1.0, which does not exist (nor does @dsh-layerfs at all),
// so it fails to install. `file:` and bundledDependencies inside a tarball are
// no way out either (pnpm resolves the first against the consumer directory and
// refuses the second outside a hoisted node linker). So the bundle ships the
// packages as directories instead of dependencies.
//
// The assembled tree keeps the workspace layout under packages/, which keeps
// every relative path in the moved code valid (mock's default scenarios folder,
// host's vendor/ lookup are both relative and unchanged); only import
// specifiers are rewritten, and only the ones listed in REWRITES.
//
// Rows. dsh discovers a package's client half by resolving a patch row to a
// *package root* that declares `dsh.client` (a subpath row is never a client
// row), so the host row names the bundle package itself, whose exports carry
// both halves ("./packages/host/src/index.js" and "./client"). That is why the
// separate `layerfs-client` row the workspace bundle needed is gone: one
// dual-face row now serves both.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const PACKAGES = ["host", "mock", "model"];

/**
 * Import specifiers the assembled package resolves itself, through the
 * `imports` map below. LayerFS's are already `#layerfs/*` in the source tree
 * (tools/vendor-layerfs.mjs); the model is still a workspace package there.
 */
const REWRITES = [
  ['from "@dsh-layerfs/model/', 'from "#dsh/'],
  ['import("@dsh-layerfs/model/', 'import("#dsh/'],
  ['from "@dsh-layerfs/model"', 'from "#dsh/index.js"'],
  ['import("@dsh-layerfs/model")', 'import("#dsh/index.js")'],
];

/** Patch rows of the workspace bundle: the id stays, the module specifier is the bundle's own. */
const ROWS = {
  "layerfs-host": "dsh-layerfs",
  "layerfs-mock": "dsh-layerfs/mock",
};
/** Rows the assembled bundle drops, and why. */
const DROPPED = {
  "layerfs-client":
    "the client half is served from the host row's package (dsh.client), not from a row of its own",
};

const readManifest = (name) => JSON.parse(readFileSync(join(ROOT, "packages", name, "package.json"), "utf8"));

/**
 * The patch rows of the bundle, with row names pointed at this package.
 * @param {string} text the workspace bundle's cordis.patch.yml
 * @returns {string} the assembled bundle's
 */
export function rewriteRows(text) {
  const lines = text.split("\n");
  const out = [];
  let seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const row = /^(\s*)- id: (\S+)$/.exec(lines[index]);
    if (!row) { out.push(lines[index]); continue; }
    const [, indent, id] = row;
    const nameLine = /^\s*name: (.*)$/.exec(lines[index + 1] ?? "");
    if (!nameLine) throw new Error(`assemble-bundle: row ${id} in cordis.patch.yml has no name on the next line`);
    index += 1;
    seen.add(id);
    if (id in DROPPED) continue;
    const name = ROWS[id];
    if (!name) throw new Error(`assemble-bundle: row ${id} has no ROWS entry (add one, or list it in DROPPED with its reason)`);
    out.push(`${indent}- id: ${id}`, `${indent}  name: '${name}'`);
  }
  const wanted = new Set([...Object.keys(ROWS)]);
  for (const id of wanted) if (!seen.has(id)) throw new Error(`assemble-bundle: cordis.patch.yml has no row ${id}`);
  return out.join("\n");
}

/**
 * Every file the assembled package must hold.
 * @returns {Map<string, Buffer>} dist-relative path to bytes
 */
export function expected() {
  const files = new Map();
  const put = (path, bytes) => files.set(toPosix(path), bytes);
  const copy = (from, to, rewrite = false) => {
    for (const path of walk(join(ROOT, from))) {
      let bytes = readFileSync(join(ROOT, from, path));
      if (rewrite) {
        let text = bytes.toString("utf8");
        for (const [needle, replacement] of REWRITES) text = text.replaceAll(needle, replacement);
        bytes = Buffer.from(text);
      }
      put(`${to}/${path}`, bytes);
    }
  };
  copy("packages/host/src", "packages/host/src", true);
  copy("packages/host/vendor", "packages/host/vendor");
  for (const name of PACKAGES) copy(join("packages", name, "src"), join("packages", name, "src"), true);
  copy("packages/client/lib", "client");
  for (const path of ["index.js", "icon.svg", "cordis.patch.yml"]) put(path, readFileSync(join(ROOT, "packages", "dsh-layerfs", path)));
  copy("packages/dsh-layerfs/locale", "locale");
  copy("packages/dsh-layerfs/presets", "presets");
  put("cordis.patch.yml", Buffer.from(rewriteRows(readFileSync(join(ROOT, "packages", "dsh-layerfs", "cordis.patch.yml"), "utf8"))));
  put("package.json", Buffer.from(`${JSON.stringify(manifest(), null, 2)}\n`));
  return files;
}

/** The assembled package.json: no dependencies at all, both faces, the bundle's patches. */
function manifest() {
  const bundle = readManifest("dsh-layerfs"), client = readManifest("client"), host = readManifest("host");
  const peers = Object.assign({}, host.peerDependencies);
  return {
    name: "dsh-layerfs",
    version: bundle.version,
    description: bundle.description,
    icon: "./icon.svg",
    type: "module",
    main: "index.js",
    exports: {
      ".": "./packages/host/src/index.js",
      "./client": "./client/client.js",
      "./mock": "./packages/mock/src/index.js",
      "./package.json": "./package.json",
      "./cordis.patch.yml": "./cordis.patch.yml",
      "./locale/*.json": "./locale/*.json",
      "./presets/*.patch.yml": "./presets/*.patch.yml",
    },
    files: [
      "index.js",
      "icon.svg",
      "cordis.patch.yml",
      "locale",
      "presets",
      "client",
      "packages",
    ],
    imports: {
      "#layerfs/agent": "./packages/host/vendor/layerfs/api/agent/src/index.js",
      "#layerfs/agent/internal": "./packages/host/vendor/layerfs/api/agent/src/internal.js",
      "#layerfs/backend": "./packages/host/vendor/layerfs/api/backend/src/index.js",
      "#layerfs/runtime": "./packages/host/vendor/layerfs/api/runtime/src/index.js",
      "#dsh/*": "./packages/model/src/*",
      "#dsh": "./packages/model/src/index.js",
    },
    license: bundle.license,
    engines: bundle.engines,
    peerDependencies: peers,
    dsh: {
      client: client.dsh.client,
      bundle: { patch: bundle.dsh.bundle.patch },
    },
  };
}

function walk(dir) {
  const out = [];
  const visit = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) visit(path);
      else out.push(toPosix(relative(dir, path)));
    }
  };
  visit(dir);
  return out;
}

const toPosix = (path) => path.split(sep).join("/");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function main(argv) {
  const mode = argv[2];
  if (mode !== undefined && mode !== "--check") {
    console.error("usage: node tools/assemble-bundle.mjs [--check]");
    process.exit(2);
  }
  const want = expected();
  if (mode === "--check") {
    const have = existsSync(DIST) ? new Set(walk(DIST)) : new Set();
    const drift = [];
    for (const [path, bytes] of want) {
      if (!have.has(path)) drift.push(`missing ${path}`);
      else if (!readFileSync(join(DIST, path)).equals(bytes)) drift.push(`differs ${path}`);
    }
    for (const path of have) if (!want.has(path)) drift.push(`extra ${path}`);
    if (drift.length > 0) {
      console.error(`assemble-bundle: dist/ is stale (${drift.length} path(s)); run \`node tools/assemble-bundle.mjs\`:\n  ${drift.slice(0, 20).join("\n  ")}`);
      process.exit(1);
    }
    console.log(`assemble-bundle: dist/ matches the source (${want.size} files)`);
  } else {
    rmSync(DIST, { recursive: true, force: true });
    for (const [path, bytes] of want) {
      const target = join(DIST, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    const total = [...want.values()].reduce((sum, bytes) => sum + bytes.length, 0);
    const digest = sha256(Buffer.from([...want].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, bytes]) => `${path} ${sha256(bytes)}\n`).join("")));
    console.log(`assemble-bundle: ${want.size} files, ${(total / 1024 / 1024).toFixed(1)} MiB in ${toPosix(relative(ROOT, DIST))}, ${digest.slice(0, 12)}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv);
