// Copies the LayerFS JavaScript a published dsh-layerfs runs on into
// packages/host/vendor/layerfs, so a consumer install needs no LayerFS
// checkout.
//
//   node tools/vendor-layerfs.mjs sync     rewrite packages/host/vendor/layerfs (what the bundle ships)
//   node tools/vendor-layerfs.mjs check    fail when the vendored tree drifted from the pinned checkout
//
// The checkout is LAYERFS_SOURCE, else layerfs.json's `source`, else wherever
// .layerfs points (tools/layerfs-source.mjs maintains that link). What is
// copied: api/{agent,backend,runtime} (the SDK the Host imports), api/cli (the
// `layerfs` command every agent bash call gets) and the SDK skill. The layout
// below vendor/layerfs mirrors the checkout root, so the code that resolves
// `api/cli/src/layerfs.js` or `.agents/skills/...` off the LayerFS root
// (packages/host/src/source.js) needs no rewrites, and the Windows SDK identity
// check keeps comparing `api/agent/src/*` byte for byte.
//
// Two kinds of edits, both listed by SPECIFIERS and REWRITES and nowhere
// implicit:
//   - bare specifiers become Node subpath imports (`#layerfs/agent`) declared
//     by packages/host/package.json, because the vendored packages' own
//     manifests are not copied: a package.json inside vendor/ would take over
//     import resolution for every file under it.
//   - the CLI's `layerfs --version` reads VENDOR.json instead of its own
//     package.json, which is likewise not copied.
// agent/src is copied byte for byte (it holds no @layerfs specifier): the
// Windows worker refuses to run when it differs from the sealed bundle's copy.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEST = join(ROOT, "packages", "host", "vendor", "layerfs");
const MANIFEST = "VENDOR.json";
const PACKAGES = ["agent", "backend", "runtime", "cli"];
const SKILL = join(".agents", "skills", "layerfs-js-sdk");

/** The bare specifiers the SDK packages import from one another, longest first. */
export const SPECIFIERS = [
  ["@layerfs/agent/internal", "#layerfs/agent/internal"],
  ["@layerfs/backend", "#layerfs/backend"],
  ["@layerfs/runtime", "#layerfs/runtime"],
  ["@layerfs/agent", "#layerfs/agent"],
];

/**
 * Rewrite every bare `@layerfs/*` specifier in `text` into the subpath import
 * form, touching import/export/dynamic-import positions only: the same words
 * appear in prose comments, and a comment edit would be a diff nobody wants.
 * @param {string} text file contents
 * @returns {string} the contents to vendor
 */
export function rewriteSpecifiers(text) {
  let out = text;
  for (const [from, to] of SPECIFIERS) {
    out = out.replaceAll(
      // `from "…"`, `import "…"`, `import("…")`, and `import.meta.resolve("…")`:
      // the last one is how api/runtime's Windows identity check names the SDK
      new RegExp(`(\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+|\\bimport\\.meta\\.resolve\\(\\s*)(["'])${from.replace(/[/.]/g, "\\$&")}\\2`, "g"),
      `$1$2${to}$2`,
    );
  }
  return out;
}

/** Per-file edits beyond specifiers, keyed by the checkout-relative path. */
export const REWRITES = {
  // `layerfs --version`: the CLI's own package.json is not vendored (see the header).
  "api/cli/src/main.js": (text) => text.replace(
    'new URL("../package.json", import.meta.url)',
    'new URL("../../../VENDOR.json", import.meta.url)',
  ),
};

/**
 * Every file the vendored tree must hold.
 * @param {string} dir the checkout root
 * @param {string} commit the pinned commit, recorded in VENDOR.json
 * @returns {Map<string, Buffer>} checkout-relative path (POSIX) to bytes
 */
export function expected(dir, commit) {
  const tree = new Map();
  const read = (path) => {
    const bytes = readFileSync(join(dir, path));
    const ext = path.slice(path.lastIndexOf("."));
    const isCode = ext === ".js" || ext === ".mjs";
    if (!isCode) return bytes;
    let text = rewriteSpecifiers(bytes.toString("utf8"));
    const rewrite = REWRITES[path];
    if (rewrite) text = rewrite(text);
    return Buffer.from(text);
  };
  for (const name of PACKAGES) {
    const base = toPosix(join("api", name, "src"));
    for (const path of walk(join(dir, base))) tree.set(`${base}/${path}`, read(`${base}/${path}`));
  }
  for (const path of walk(join(dir, SKILL))) tree.set(toPosix(`${SKILL}/${path}`), read(`${SKILL}/${path}`));
  const { version } = JSON.parse(readFileSync(join(dir, "api", "package.json"), "utf8"));
  const files = Object.fromEntries([...tree].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, bytes]) => [path, sha256(bytes)]));
  tree.set(MANIFEST, Buffer.from(`${JSON.stringify({ commit, version, files }, null, 2)}\n`));
  return tree;
}

/**
 * Files under `dir`, POSIX-relative, sorted.
 * @param {string} dir directory
 * @returns {string[]} relative paths
 */
export function walk(dir) {
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

/**
 * The checkout to vendor: LAYERFS_SOURCE, else the pin, else wherever .layerfs points.
 * @param {{source: string}} pin layerfs.json
 * @returns {string} absolute path
 */
function locate(pin) {
  const isCheckout = (dir) => existsSync(join(dir, "api", "agent", "src", "index.js"));
  if (process.env.LAYERFS_SOURCE) return resolve(ROOT, process.env.LAYERFS_SOURCE);
  const pinned = resolve(ROOT, pin.source);
  if (isCheckout(pinned)) return pinned;
  try { return realpathSync(join(ROOT, ".layerfs")); } catch { return pinned; }
}

/**
 * The checkout to vendor, for tests and callers that need the same answer.
 * @returns {{source: string, commit: string}} the checkout and its pin
 */
export function pinned() {
  const pin = JSON.parse(readFileSync(join(ROOT, "layerfs.json"), "utf8"));
  return { source: locate(pin), commit: pin.commit };
}

function main(argv) {
  const mode = argv[2] ?? "sync";
  if (mode !== "sync" && mode !== "check") {
    console.error("usage: node tools/vendor-layerfs.mjs [sync|check]");
    process.exit(2);
  }
  const { source, commit } = pinned();
  if (!existsSync(join(source, "api", "agent", "src", "index.js"))) {
    console.error(`vendor-layerfs: ${source} is not a LayerFS checkout with the #428 packages (no api/agent); set LAYERFS_SOURCE to one at ${commit.slice(0, 10)}`);
    process.exit(1);
  }
  let head = null;
  try { head = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
  if (head !== commit) {
    const at = head ? `is at ${head.slice(0, 10)}` : "is not a git checkout";
    const message = `vendor-layerfs: ${source} ${at}, the pinned commit is ${commit.slice(0, 10)}`;
    if (mode === "check") { console.error(message); process.exit(1); }
    console.error(`${message}; vendoring it anyway`);
  }

  const want = expected(source, commit);

  if (mode === "sync") {
    rmSync(DEST, { recursive: true, force: true });
    for (const [path, bytes] of want) {
      const target = join(DEST, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    console.log(`vendor-layerfs: ${want.size} files in ${toPosix(relative(ROOT, DEST))}, from ${source} at ${commit.slice(0, 10)}`);
    return;
  }
  const have = existsSync(DEST) ? new Set(walk(DEST)) : new Set();
  const drift = [];
  for (const [path, bytes] of want) {
    if (!have.has(path)) drift.push(`missing ${path}`);
    else if (!readFileSync(join(DEST, path)).equals(bytes)) drift.push(`differs ${path}`);
  }
  for (const path of have) if (!want.has(path)) drift.push(`extra ${path}`);
  if (drift.length > 0) {
    console.error(`vendor-layerfs: ${drift.length} path(s) drifted from ${source} at ${commit.slice(0, 10)}; run \`node tools/vendor-layerfs.mjs sync\`:\n  ${drift.slice(0, 20).join("\n  ")}`);
    process.exit(1);
  }
  console.log(`vendor-layerfs: ${want.size} files match ${source} at ${commit.slice(0, 10)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv);
