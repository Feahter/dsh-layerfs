// First boot: ensureDeployment fills in what a profile did not configure, from
// a sealed build, the Docker engine and the build's own runtime image — and
// refuses a build that does not verify, leaving the setting as it was.
//   node packages/host/tests/ensure.mjs
// No Docker and no network: the release is a file: URL and the docker runner is
// a stand-in that answers the two calls ensure makes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.js";
import { ensureDeployment } from "../src/ensure.js";

const COMMIT = "ab".repeat(20);
const RUNNER = `sha256:${"cd".repeat(32)}`;
const dir = mkdtempSync(join(tmpdir(), "dsh-layerfs-ensure-"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A sealed build of COMMIT in `to`, and the release tarball that carries it. */
function release(to) {
  const build = join(dir, "build");
  const files = { "layerfs.node": "node", "layerfs-daemon": "daemon", "api/package.json": '{"name":"layerfs-js"}' };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(build, path, ".."), { recursive: true });
    writeFileSync(join(build, path), text);
  }
  const manifest = { version: 1, status: "sealed", build_id: "build-test", source: { head: COMMIT }, images: { runtime: RUNNER }, files: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, sha256(Buffer.from(text))])) };
  writeFileSync(join(build, "manifest.json"), JSON.stringify(manifest));
  const asset = join(to, "layerfs-" + COMMIT.slice(0, 12));
  mkdirSync(asset, { recursive: true });
  const tar = spawnSync("tar", ["czf", join(asset, "linux-x64.tar.gz"), "-C", build, "."], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  return { build, manifest };
}

const base = join(dir, "releases");
const { build, manifest } = release(base);
const cache = join(dir, "cache");
const settings = (config = {}) => resolveConfig({ releases: `file://${base}`, bundleCache: cache, home: join(dir, "home"), stateDir: join(dir, "state"), traceDir: join(dir, "traces"), docker: join(dir, "docker.sock"), ...config }, undefined);

/** A docker runner that knows `present` (and anything it has pulled) and records the calls it got. */
function docker(present = RUNNER, calls = []) {
  const pulled = new Set();
  return (args) => {
    calls.push(args.join(" "));
    const image = args[args.length - 1];
    if (args.includes("inspect")) {
      const known = image === present || pulled.has(image);
      return known ? { status: 0, stdout: `${present}\n`, stderr: "" } : { status: 1, stdout: "", stderr: "Error: No such image" };
    }
    if (args.includes("pull")) { pulled.add(image); return { status: 0, stdout: "pulled\n", stderr: "" }; }
    return { status: 1, stdout: "", stderr: "unexpected call" };
  };
}

// nothing configured: the build is fetched, verified and cached; its own runtime
// image and the daemon inside it complete the deployment
{
  const spec = settings();
  assert.deepEqual([spec.image, spec.bundle, spec.daemon], [null, null, null]);
  const calls = [];
  const { problems } = await ensureDeployment(spec, { warn: () => {}, pinned: COMMIT, run: docker(RUNNER, calls) });
  assert.deepEqual(problems, []);
  assert.equal(spec.bundle, join(cache, COMMIT.slice(0, 12)));
  assert.equal(spec.daemon, join(spec.bundle, "layerfs-daemon"));
  assert.equal(spec.image, RUNNER);
  assert.equal(readFileSync(join(spec.bundle, "manifest.json"), "utf8"), JSON.stringify(manifest));
  // the image came from the manifest, so the engine is asked whether it has it
  assert.equal(calls.length, 1, calls.join("; "));
}

// a second boot uses the cache and asks the engine nothing new about the build
{
  const spec = settings();
  const calls = [];
  const { problems } = await ensureDeployment(spec, { warn: () => {}, pinned: COMMIT, run: docker(RUNNER, calls) });
  assert.deepEqual(problems, []);
  assert.equal(spec.bundle, join(cache, COMMIT.slice(0, 12)));
}

// a configured tag is resolved to the engine's image ID
{
  const spec = settings({ image: "layerfs-352-runtime:node24" });
  const { problems } = await ensureDeployment(spec, { warn: () => {}, pinned: COMMIT, run: docker(RUNNER) });
  assert.deepEqual(problems, []);
  assert.equal(spec.image, RUNNER);
}

// the build's image missing from this engine is reported, not silently kept
{
  const spec = settings();
  const seen = [];
  const { problems } = await ensureDeployment(spec, { warn: (text) => seen.push(text), pinned: COMMIT, run: docker("sha256:" + "ee".repeat(32)) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /is not in this Docker engine/);
  assert.deepEqual(seen, problems);
  // the setting stays; the runtime's own answer is about the image, not about nothing being configured
  assert.equal(spec.image, RUNNER);
}

// a configured build that no longer matches its manifest is refused, and the
// setting is left pointing at what the profile asked for
{
  const broken = join(dir, "broken");
  mkdirSync(broken, { recursive: true });
  for (const [path, text] of Object.entries({ "layerfs.node": "node", "layerfs-daemon": "daemon", "api/package.json": "{}" })) {
    mkdirSync(join(broken, path, ".."), { recursive: true });
    writeFileSync(join(broken, path), text);
  }
  const manifest = JSON.parse(readFileSync(join(build, "manifest.json"), "utf8"));
  writeFileSync(join(broken, "manifest.json"), JSON.stringify(manifest));
  const spec = settings({ bundle: broken, image: RUNNER });
  const { problems } = await ensureDeployment(spec, { warn: () => {}, pinned: COMMIT, run: docker(RUNNER) });
  assert.equal(problems.length, 1, problems.join("; "));
  assert.match(problems[0], /api\/package\.json in .* is not the file the manifest sealed/);
  assert.equal(spec.bundle, broken);
  assert.equal(spec.daemon, join(broken, "layerfs-daemon"));
}

// a bundle of another commit never runs: the SDK and the engine would disagree
{
  const spec = settings({ bundle: build });
  const { problems } = await ensureDeployment(spec, { warn: () => {}, pinned: "cd".repeat(20), run: docker(RUNNER) });
  assert.equal(problems.length, 1, problems.join("; "));
  assert.match(problems[0], /built from /);
}

// Linux makes Store calls in this process, so the SDK has to be told where the
// build's native addon is: the vendored tree ships source only, and without this
// the fallback path beside it can never exist
{
  const spec = settings();
  spec.worker = false;
  const env = {};
  await ensureDeployment(spec, { warn: () => {}, pinned: COMMIT, run: docker(RUNNER), env });
  assert.equal(env.LAYERFS_NATIVE, join(spec.bundle, "layerfs.node"));
  // the documented override wins over the default
  const kept = { LAYERFS_NATIVE: "/own/layerfs.node" };
  const second = settings();
  second.worker = false;
  await ensureDeployment(second, { warn: () => {}, pinned: COMMIT, run: docker(RUNNER), env: kept });
  assert.equal(kept.LAYERFS_NATIVE, "/own/layerfs.node");
}

// Windows runs docker inside WSL: checking the host's Unix socket and the host's
// docker CLI there would report failures no one can fix, so nothing is checked
{
  const spec = settings();
  spec.docker = join(dir, "no-such.sock");
  const calls = [];
  const { problems } = await ensureDeployment(spec, { warn: () => {}, pinned: COMMIT, run: docker("sha256:" + "ee".repeat(32), calls), platform: "win32" });
  assert.deepEqual(problems, []);
  assert.deepEqual(calls, [], "no docker call from the host on Windows");
  assert.equal(spec.docker, join(dir, "no-such.sock"));
  assert.equal(spec.image, RUNNER, "the build still names the runtime image");
}

// a socket the profile did not name, existing only in Docker Desktop's per-user
// place, is found instead of reported missing
{
  const home = join(dir, "user");
  mkdirSync(join(home, ".docker", "run"), { recursive: true });
  writeFileSync(join(home, ".docker", "run", "docker.sock"), "");
  const spec = settings();
  spec.docker = join(dir, "absent.sock");
  const { detectSocket } = await import("../src/deployment-docker.js");
  assert.equal(detectSocket(spec.docker, { homedir: home }).socket, join(home, ".docker", "run", "docker.sock"));
}

rmSync(dir, { recursive: true, force: true });
console.log("ensure: ok");
