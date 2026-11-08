// First boot: make the deployment the Host hands @layerfs/runtime complete
// before the runtime opens, so a profile that configured nothing still runs.
// Three gaps close here, each from something the machine already has:
//   - the Docker socket: the configured path, else DOCKER_HOST, else Docker
//     Desktop's per-user socket (a Docker installed without admin rights never
//     creates /var/run/docker.sock, and the runtime binds the path as given);
//   - the sealed LayerFS build: the configured folder, else this commit's cache
//     entry, else the release asset (verified file by file, never trusted);
//   - the runtime image: the configured value, else build's own runtime image
//     digest from the sealed manifest.
// Nothing here decides for the user: a step that fails leaves its setting as it
// was, names the fix in one sentence, and lets dsh start anyway (the status
// route shows what is still missing), because a LayerFS plugin that refuses to
// load is worse than one that says what it needs.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveDeployment } from "./config.js";
import { acquireBundle, readSealedBundle } from "./deployment-bundle.js";
import { detectSocket, dockerRun, resolveImage } from "./deployment-docker.js";
import { LAYERFS } from "./source.js";

/**
 * The LayerFS commit this build was vendored from, so a downloaded bundle is
 * only used when it was built from the same source: the SDK in this package
 * talks to the engine in that build.
 * @returns {string|null} the 40-hex commit, or null when the vendor manifest is absent
 */
export function pinnedCommit() {
  try {
    const { commit } = JSON.parse(readFileSync(join(LAYERFS, "VENDOR.json"), "utf8"));
    return /^[0-9a-f]{40}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

/**
 * Whether this Docker engine has an image, by digest or reference.
 * @param {string} image digest or reference
 * @param {string} socket the engine's socket
 * @param {(args: string[]) => {status: number|null, stdout: string, stderr: string}} run docker runner
 * @returns {boolean} true when the engine knows it
 */
function hasImage(image, socket, run) {
  const result = run(["-H", `unix://${socket}`, "image", "inspect", "-f", "{{.Id}}", image]);
  return result.status === 0 && result.stdout.trim() !== "";
}

/**
 * Completes the deployment settings in place.
 * @param {import("./config.js").Spec} spec settings to complete
 * @param {{ warn?: (text: string) => void, releases?: string, cache?: string, pinned?: string|null,
 *   run?: (args: string[]) => {status: number|null, stdout: string, stderr: string} }} [options]
 *   every collaborator is injectable so a test needs no Docker, no network and no cache
 * @returns {Promise<{ problems: string[] }>} what still stands in the way, each one actionable
 */
export async function ensureDeployment(spec, options = {}) {
  const warn = options.warn ?? (() => {});
  const run = options.run ?? dockerRun;
  const problems = [];
  const fail = (text) => { problems.push(text); warn(text); };

  // docker lives inside WSL on Windows: this process has no engine to ask, and
  // the runtime's own WSL paths report what is wrong there — so the checks
  // below, which are shaped around a Unix socket, are skipped rather than
  // reported as failures a Windows user can do nothing about
  const windows = (options.platform ?? process.platform) === "win32";
  if (!windows) {
    const socket = detectSocket(spec.docker);
    spec.docker = socket.socket;
    if (!socket.found) fail(socket.problem);
  }

  const pinned = options.pinned === undefined ? pinnedCommit() : options.pinned;
  // a build that did not verify is never read for its image: its manifest is
  // exactly what the check just refused to trust
  let buildVerified = false;
  if (!spec.bundle) {
    try {
      const { dir, acquired } = await acquireBundle({
        commit: pinned,
        cache: options.cache ?? spec.bundleCache,
        base: options.releases ?? spec.releases,
        // a LayerFS build is a Linux build whatever the host runs: on macOS it
        // is the image's program, so the host's own platform names no asset
        platform: "linux",
      });
      spec.bundle = dir;
      buildVerified = true;
      if (acquired) warn(`downloaded the LayerFS build of ${pinned.slice(0, 12)} into ${dir}`);
    } catch (error) {
      fail(error.message);
    }
  } else {
    // a configured folder is used as it is, but a build from another commit
    // would pair this SDK with an engine it was not written for
    // readSealedBundle reads undefined as "do not check the commit", not null
    try { readSealedBundle(spec.bundle, pinned ?? undefined); buildVerified = true; } catch (error) { fail(error.message); }
  }

  // the build names the runtime image it was made with, which is the one this
  // program is written for: a profile that says nothing gets that, not a guess
  if (!spec.image && buildVerified) {
    let manifest = null;
    try { manifest = readSealedBundle(spec.bundle, pinned ?? undefined).manifest; } catch {}
    spec.image = manifest?.images?.runtime ?? null;
  }
  if (!windows && spec.image) {
    const configured = spec.image;
    const resolved = resolveImage(configured, spec.docker, run);
    if (resolved.image) spec.image = resolved.image;
    if (resolved.problem) fail(resolved.problem);
    // a name or tag was proved to exist by the inspect resolveImage made; a
    // digest is taken on trust there, and an engine without it refuses Init
    // later with --pull never, so that answer is worth having now
    else if (/^sha256:/i.test(configured) && !hasImage(spec.image, spec.docker, run)) {
      fail(`the image ${spec.image} is not in this Docker engine: pull it (docker pull ${spec.image}), or set "image" to a name this engine has`);
    }
  } else if (!windows && buildVerified && !spec.image) {
    fail('no runtime image: the LayerFS build names none; set "image" to an image name or a sha256:… digest');
  }

  // Linux makes every Store call in this process, through the addon the sealed
  // build carries beside its daemon. The vendored tree holds source only (there
  // is no engine/ beside it to find the addon in), so name it the way the SDK
  // reads it, and leave a set LAYERFS_NATIVE alone: it is the documented override
  const env = options.env ?? process.env;
  if (!spec.worker && spec.bundle) {
    const addon = join(spec.bundle, "layerfs.node");
    if (existsSync(addon)) env.LAYERFS_NATIVE ??= addon;
  }

  deriveDeployment(spec);
  // the status route reports them: a warn() line is easy to miss, and the
  // person looking at a broken deployment is looking at that page
  spec.deploymentProblems = problems;
  return { problems };
}
