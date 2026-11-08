// The sealed LayerFS build the Host runs, and where it comes from: the build
// of the pinned commit, byte for byte, or nothing. A sealed bundle is a
// directory the LayerFS build tool makes (manifest.json, layerfs.node,
// layerfs-daemon, api/**); the Host hands that directory to @layerfs/runtime,
// so nothing here runs it. What this module answers is the question before
// that handoff — is this really the build of the commit we pinned? — and keeps
// the cache that answers it. The manifest's file table is the trust boundary:
// a bundle whose bytes moved is refused rather than run, and a cache entry
// that no longer verifies is replaced by a download, never repaired in place.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const MANIFEST = "manifest.json";
const COMMIT = /^[0-9a-f]{40}$/, SHA256 = /^[0-9a-f]{64}$/;

/**
 * Reads and checks a sealed bundle's manifest against the files beside it.
 * Every file the manifest lists must sit inside `dir` and hash as recorded;
 * with `commit`, the bundle must also be the build of that exact LayerFS
 * commit, so a release for another pin cannot be run by mistake.
 * @param {string} dir the bundle directory
 * @param {string} [commit] the LayerFS commit the build must be from (the pin)
 * @returns {{ manifest: object, files: number }} the manifest, and how many files it verified
 * @throws when manifest.json is missing or unparseable, its version is not 1,
 *   status is not "sealed", source.head differs from `commit` (both are named),
 *   a listed path leaves the bundle, or a listed file is missing or hashes
 *   differently (the path and both digests are named)
 */
export function readSealedBundle(dir, commit) {
  const path = join(dir, MANIFEST);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const why = error.code === "ENOENT" ? "there is no manifest.json, so this is not a sealed LayerFS build" : error.message;
    throw new Error(`cannot read ${path}: ${why}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not JSON: ${error.message}`);
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(`${path} is not a manifest object`);
  // a manifest of another version may mean other keys; guessing would check the wrong ones
  if (manifest.version !== 1) throw new Error(`${path} is version ${JSON.stringify(manifest.version)}; this Host reads sealed bundles of version 1`);
  if (manifest.status !== "sealed") throw new Error(`${path} is not sealed (status ${JSON.stringify(manifest.status)}); a bundle is runnable only after its build is sealed`);
  const head = manifest.source?.head;
  if (typeof head !== "string" || !COMMIT.test(head)) throw new Error(`${path} names no LayerFS source commit; a sealed manifest has source.head, the 40-hex commit it was built from`);
  if (commit !== undefined && head !== commit) throw new Error(`${dir} was built from ${head}, not the pinned ${commit}; pin ${head} or get the build of ${commit}`);
  const files = manifest.files;
  if (files === null || typeof files !== "object" || Array.isArray(files)) throw new Error(`${path} lists no files; a sealed manifest has files, the path-to-sha256 table of what it sealed`);
  const root = resolve(dir);
  for (const [name, expected] of Object.entries(files)) {
    // the manifest is data, not a trusted path list: one entry that leaves the bundle would hash a file elsewhere
    const file = resolve(root, name);
    if (!file.startsWith(`${root}${sep}`)) throw new Error(`${path} names ${name}, which is outside ${dir}; a sealed bundle holds only its own files`);
    if (typeof expected !== "string" || !SHA256.test(expected)) throw new Error(`${path} gives ${name} no sha256 digest; every sealed file is recorded with one`);
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch (error) {
      throw new Error(`${name} is missing from ${dir} (${error.code ?? error.message}); the bundle is incomplete`);
    }
    const actual = sha256(bytes);
    if (actual !== expected) throw new Error(`${name} in ${dir} is not the file the manifest sealed: expected sha256 ${expected}, hashed ${actual}`);
  }
  return { manifest, files: Object.keys(files).length };
}

/**
 * The sealed bundle to run: the cached one for this commit when it validates,
 * else downloaded from a release and verified before it is used. The cache
 * keeps one directory per commit, `<cache>/<commit12>`, holding the bundle
 * root; an entry that fails verification is not used, and a download replaces
 * it only after the new copy has verified, so a failure leaves no half-written
 * cache behind.
 * @param {object} options
 * @param {string} options.commit the pinned LayerFS commit (40 hex)
 * @param {string} options.cache the cache root, e.g. ~/.cache/dsh-layerfs
 * @param {string} options.base release base URL, no trailing slash, e.g. https://host/releases/download
 * @param {string} [options.platform] default process.platform
 * @param {string} [options.arch] default process.arch
 * @param {(url: string, to: string) => Promise<void>} [options.download] fetcher, default http(s)/file: aware
 * @returns {Promise<{ dir: string, manifest: object, acquired: boolean }>} acquired=false means the cache had it
 * @throws when the download fails or the archive does not verify; a cache hit
 *   that failed verification is named alongside the download's own failure
 */
export async function acquireBundle(options) {
  const { commit, cache, base } = options ?? {};
  if (typeof commit !== "string" || !COMMIT.test(commit)) throw new Error(`commit must be the 40-hex LayerFS commit a sealed bundle was built from, not ${JSON.stringify(commit)}`);
  if (typeof cache !== "string" || !cache) throw new Error("cache must be a directory to keep bundles in, e.g. ~/.cache/dsh-layerfs");
  if (typeof base !== "string" || !base) throw new Error("base must be a release base URL without a trailing slash, e.g. https://host/releases/download");
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const download = options.download ?? downloadTo;
  const name = commit.slice(0, 12);
  const dir = join(cache, name);
  // a cache entry that no longer verifies is never used: it stays until a verified download replaces it, so a later failure can still say why it was refused
  let stale = null;
  if (existsSync(dir)) {
    try {
      const { manifest } = readSealedBundle(dir, commit);
      return { dir, manifest, acquired: false };
    } catch (error) {
      stale = error;
    }
  }
  const url = `${base.replace(/\/+$/, "")}/layerfs-${name}/${platform}-${arch}.tar.gz`;
  mkdirSync(cache, { recursive: true });
  // the temp directory is a sibling of the cache entry: same filesystem, so the verified tree can be renamed into place
  const work = mkdtempSync(join(cache, `.${name}-`));
  try {
    const archive = join(work, "bundle.tar.gz");
    try {
      await download(url, archive);
    } catch (error) {
      // a network failure's cause names the host or syscall; "fetch failed" alone does not
      const reason = error instanceof Error ? error.message : String(error);
      const why = error instanceof Error && error.cause?.message ? `${reason} (${error.cause.message})` : reason;
      const also = stale ? `; the cached ${dir} failed its check too: ${stale.message}` : "";
      throw new Error(`cannot download ${url}: ${why}${also}`);
    }
    const root = join(work, "root");
    mkdirSync(root);
    let sealed;
    try {
      // unpacking is part of trusting the archive: a tar failure and a hash failure are both "this release is not the bundle"
      untar(archive, root);
      sealed = readSealedBundle(root, commit);
    } catch (error) {
      throw new Error(`${url} did not give the sealed bundle of ${commit}: ${error.message}`);
    }
    // replace only now that the new copy has verified: a corrupt entry is never what a failed download leaves behind
    rmSync(dir, { recursive: true, force: true });
    renameSync(root, dir);
    return { dir, manifest: sealed.manifest, acquired: true };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Lowercase hex sha256 of `bytes`, as the manifest records a file. */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Extracts `archive` into `dir` with the system tar, dropping the single top
 * directory a release tarball may wrap the bundle in, so manifest.json lands
 * at the directory's root.
 * @param {string} archive path of the .tar.gz
 * @param {string} dir the empty directory to extract into
 */
function untar(archive, dir) {
  const names = tar(["tzf", archive], `list ${archive}`).split("\n").map((line) => line.trim()).filter(Boolean);
  tar(["xzf", archive, "-C", dir, `--strip-components=${stripDepth(names, archive)}`], `extract ${archive}`);
}

/**
 * How many leading path components to drop, from the archive's entry names: 0
 * when it carries manifest.json at its root, 1 when everything sits under one
 * top directory, and a refusal when it is neither, since no extraction of it
 * can put manifest.json at the cache root.
 * @param {string[]} names the archive's entry names
 * @param {string} archive the archive, for the error message
 * @returns {number} 0 or 1
 */
function stripDepth(names, archive) {
  const tops = new Set();
  let root = false;
  for (const raw of names) {
    const name = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!name || name === ".") continue;
    if (name === MANIFEST) root = true;
    tops.add(name.split("/")[0]);
  }
  if (root) return 0;
  if (tops.size === 1) return 1;
  throw new Error(`${archive} has ${tops.size} top-level entries and no ${MANIFEST} at its root; a release tarball is the bundle itself, or the bundle under one directory`);
}

/**
 * Runs the system tar and returns its stdout, turning a missing tar and a
 * non-zero exit into what the caller can act on.
 * @param {string[]} args tar's first argument and the rest
 * @param {string} what the step, for the error message ("list <archive>")
 * @returns {string} tar's stdout
 */
function tar(args, what) {
  const result = spawnSync("tar", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    const why = result.error.code === "ENOENT" ? "the system tar is not on the PATH, and this Host unpacks bundles with it" : result.error.message;
    throw new Error(`cannot ${what}: ${why}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim().split("\n").filter(Boolean).slice(-3).join(" ");
    throw new Error(`cannot ${what}: tar exited ${result.status}${stderr ? `: ${stderr}` : ""}`);
  }
  return result.stdout ?? "";
}

/**
 * The default fetcher: a file: URL is copied, an http(s) URL is streamed to
 * `to`, and anything else is named rather than attempted. Streaming keeps a
 * bundle's tens of megabytes out of memory; the caller verifies what lands.
 * @param {string} url the release URL or a file: URL
 * @param {string} to the path to write
 * @returns {Promise<void>}
 */
async function downloadTo(url, to) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${url} is not a URL; a bundle comes from a release URL`);
  }
  if (parsed.protocol === "file:") {
    copyFileSync(fileURLToPath(parsed), to);
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`this Host downloads bundles over http(s) or file:, not ${parsed.protocol}`);
  // a stalled mirror must not hold the first boot open forever: the caller has a
  // status page waiting to say something either way
  const response = await fetch(parsed, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  if (!response.body) {
    writeFileSync(to, Buffer.alloc(0));
    return;
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(to));
}
