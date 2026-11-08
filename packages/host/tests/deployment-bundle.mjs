// Acquisition of a sealed LayerFS bundle: what is accepted, what is refused,
// and that the cache is used, replaced and never half-written. Everything is
// synthetic and local — a handful of files, a manifest whose digests are real,
// a tarball packed by the system tar, and a file: release URL — so this runs
// with no network and no Docker.
//   node packages/host/tests/deployment-bundle.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireBundle, readSealedBundle } from "../src/deployment-bundle.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";
const THIRD = "fedcba9876543210fedcba9876543210fedcba98";
const PLATFORM = "linux", ARCH = "x64";
const NAMES = ["layerfs.node", "layerfs-daemon", "api/agent/src/index.js"];
const FILES = {
  "layerfs.node": "the sealed addon\n",
  "layerfs-daemon": "the sealed daemon\n",
  "api/agent/src/index.js": "export const agent = 1;\n",
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (seed) => sha256(Buffer.from(seed));

const ROOT = mkdtempSync(join(tmpdir(), "dsh-layerfs-deployment-bundle-"));
const CACHE = join(ROOT, "cache");

/**
 * Writes a synthetic sealed bundle: the files above, then a manifest that
 * records their real digests. `status` and `commit` are what the negative
 * cases vary; the bytes are always sealed as written.
 * @param {string} dir the bundle directory to fill
 * @param {{ status?: string, commit?: string }} [options]
 * @returns {Record<string, string>} the manifest's path-to-digest table
 */
function seal(dir, { status = "sealed", commit = COMMIT } = {}) {
  const files = {};
  for (const name of NAMES) {
    const bytes = Buffer.from(FILES[name]);
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), bytes);
    files[name] = sha256(bytes);
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    version: 1, status, build_id: `build-test-${commit.slice(0, 12)}`, at: "2026-01-01T00:00:00.000000+00:00",
    worktree_id: "layerfs-test", platform: "linux", profile: "release",
    source: { head: commit, sha256: digest("source tree") }, toolchain: "1.85.1",
    images: { build: `sha256:${digest("build")}`, runtime: `sha256:${digest("runtime")}`, sandbox: `sha256:${digest("sandbox")}` },
    command: ["cargo", "build"], files,
  }, null, 2));
  return files;
}

/** The release base, a file: URL: assets sit under it as layerfs-<commit12>/<platform>-<arch>.tar.gz. */
const BASE = pathToFileURL(join(ROOT, "releases")).href;

/**
 * Packs `source` as the release asset of `commit`, with the single top
 * directory a real release tarball carries.
 * @param {string} source the bundle directory to pack
 * @param {string} commit whose release this is
 * @returns {string} the asset path, also what the injected fetcher copies
 */
function release(source, commit) {
  const to = join(ROOT, "releases", `layerfs-${commit.slice(0, 12)}`, `${PLATFORM}-${ARCH}.tar.gz`);
  mkdirSync(dirname(to), { recursive: true });
  const packed = spawnSync("tar", ["-czf", to, "-C", dirname(source), basename(source)], { encoding: "utf8" });
  assert.equal(packed.status, 0, `tar could not pack ${source}: ${packed.stderr}`);
  return to;
}

try {
  // the bundle itself: accepted, with its file count
  const built = join(ROOT, "built", "layerfs-test");
  seal(built);
  const checked = readSealedBundle(built, COMMIT);
  assert.equal(checked.manifest.status, "sealed");
  assert.equal(checked.files, NAMES.length, "every listed file is read");

  // an unsealed build is not runnable
  const draft = join(ROOT, "draft");
  seal(draft, { status: "draft" });
  assert.throws(() => readSealedBundle(draft, COMMIT), (error) => /not sealed/.test(error.message) && /draft/.test(error.message), "a build whose status is not sealed is refused, naming the status");

  // a bundle of another commit cannot pass for the pin: both commits are named
  const foreign = join(ROOT, "foreign");
  seal(foreign, { commit: OTHER });
  assert.throws(() => readSealedBundle(foreign, COMMIT), (error) => error.message.includes(COMMIT) && error.message.includes(OTHER), "a bundle of another commit names both commits");

  // a changed byte is refused, naming the path and both digests
  const changed = join(ROOT, "changed");
  const changedFiles = seal(changed);
  writeFileSync(join(changed, "layerfs.node"), "not the sealed addon\n");
  assert.throws(
    () => readSealedBundle(changed, COMMIT),
    (error) => error.message.includes("layerfs.node") && error.message.includes(changedFiles["layerfs.node"]) && error.message.includes(sha256(Buffer.from("not the sealed addon\n"))),
    "a changed file names its path and both digests",
  );

  // a file the manifest lists but the directory lacks
  const missing = join(ROOT, "missing");
  seal(missing);
  rmSync(join(missing, "api/agent/src/index.js"));
  assert.throws(() => readSealedBundle(missing, COMMIT), (error) => error.message.includes("api/agent/src/index.js"), "a missing file names its path");

  // and a directory with no manifest at all
  const bare = join(ROOT, "bare");
  mkdirSync(bare);
  assert.throws(() => readSealedBundle(bare, COMMIT), /manifest\.json/, "a directory without manifest.json is refused");

  // a manifest entry that leaves the bundle would hash a file elsewhere: refused, not followed
  const escape = join(ROOT, "escape");
  seal(escape);
  const escapeManifest = JSON.parse(readFileSync(join(escape, "manifest.json"), "utf8"));
  writeFileSync(join(ROOT, "outside.txt"), "outside the bundle\n");
  escapeManifest.files["../outside.txt"] = sha256(Buffer.from("outside the bundle\n"));
  writeFileSync(join(escape, "manifest.json"), JSON.stringify(escapeManifest));
  assert.throws(() => readSealedBundle(escape, COMMIT), (error) => error.message.includes("../outside.txt"), "a path outside the bundle is refused");

  // the release asset of the pinned commit, as the build tool packs it
  const asset = release(built, COMMIT);

  // an empty cache downloads, verifies and keeps the bundle at <cache>/<commit12>
  const first = await acquireBundle({ commit: COMMIT, cache: CACHE, base: BASE, platform: PLATFORM, arch: ARCH });
  assert.equal(first.acquired, true, "an empty cache downloads the release");
  assert.equal(first.dir, join(CACHE, COMMIT.slice(0, 12)), "the cache entry is named by the commit's first 12 characters");
  assert.equal(first.manifest.build_id, `build-test-${COMMIT.slice(0, 12)}`);
  assert.equal(readSealedBundle(first.dir, COMMIT).files, NAMES.length, "the cached bundle validates");
  assert.deepEqual(readFileSync(join(first.dir, "layerfs-daemon")), Buffer.from(FILES["layerfs-daemon"]), "the extracted bytes are the release's");
  assert.deepEqual(readdirSync(CACHE), [COMMIT.slice(0, 12)], "only the cache entry is left, no temp directory");

  // a second call is a cache hit: no download at all
  let downloads = 0;
  const download = async (url, to) => {
    downloads += 1;
    assert.equal(url, `${BASE}/layerfs-${COMMIT.slice(0, 12)}/${PLATFORM}-${ARCH}.tar.gz`, "the asset URL names the commit and the platform");
    copyFileSync(asset, to);
  };
  const second = await acquireBundle({ commit: COMMIT, cache: CACHE, base: BASE, platform: PLATFORM, arch: ARCH, download });
  assert.equal(second.acquired, false, "a second call uses the cache");
  assert.equal(second.dir, first.dir);
  assert.equal(downloads, 0, "the cache hit did not download");

  // a corrupted cache entry is not used: it is downloaded again and replaced
  writeFileSync(join(first.dir, "layerfs-daemon"), "corrupted in the cache\n");
  const replaced = await acquireBundle({ commit: COMMIT, cache: CACHE, base: BASE, platform: PLATFORM, arch: ARCH, download });
  assert.equal(replaced.acquired, true, "a cache entry that fails verification is downloaded again");
  assert.equal(downloads, 1, "the redownload used the fetcher");
  assert.equal(readSealedBundle(first.dir, COMMIT).files, NAMES.length, "the replaced cache entry validates");
  assert.deepEqual(readFileSync(join(first.dir, "layerfs-daemon")), Buffer.from(FILES["layerfs-daemon"]), "the replaced entry holds the release's bytes");
  assert.deepEqual(readdirSync(CACHE), [COMMIT.slice(0, 12)], "the replacement left no temp directory");

  // an archive whose bytes do not match its manifest is refused, and nothing is cached
  const tampered = join(ROOT, "tampered", "layerfs-test");
  seal(tampered, { commit: OTHER });
  writeFileSync(join(tampered, "layerfs.node"), "not what the manifest sealed\n");
  const tamperedAsset = release(tampered, OTHER);
  const tamperedCache = join(ROOT, "cache-tampered");
  await assert.rejects(
    acquireBundle({ commit: OTHER, cache: tamperedCache, base: BASE, platform: PLATFORM, arch: ARCH, download: async (url, to) => copyFileSync(tamperedAsset, to) }),
    (error) => error.message.includes(OTHER) && error.message.includes("layerfs.node"),
    "a tampered archive is refused, naming the commit and the file",
  );
  assert.equal(existsSync(join(tamperedCache, OTHER.slice(0, 12))), false, "a refused archive leaves no cache entry");
  assert.deepEqual(readdirSync(tamperedCache), [], "a refused archive leaves no temp directory");

  // an archive whose manifest.json is already at its root needs no stripping
  const flat = join(ROOT, "flat");
  seal(flat, { commit: THIRD });
  const flatAsset = join(ROOT, "releases", `layerfs-${THIRD.slice(0, 12)}`, `${PLATFORM}-${ARCH}.tar.gz`);
  mkdirSync(dirname(flatAsset), { recursive: true });
  const flatPacked = spawnSync("tar", ["-czf", flatAsset, "-C", flat, "."], { encoding: "utf8" });
  assert.equal(flatPacked.status, 0, `tar could not pack ${flat}: ${flatPacked.stderr}`);
  const flatCache = join(ROOT, "cache-flat");
  const flatGot = await acquireBundle({ commit: THIRD, cache: flatCache, base: BASE, platform: PLATFORM, arch: ARCH, download: async (url, to) => copyFileSync(flatAsset, to) });
  assert.equal(flatGot.acquired, true, "an archive without a top directory is acquired");
  assert.equal(readSealedBundle(flatGot.dir, THIRD).files, NAMES.length, "a flat archive's bundle lands at the cache root");
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log("deployment-bundle: ok");
