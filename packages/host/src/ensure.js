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

  const socket = detectSocket(spec.docker);
  spec.docker = socket.socket;
  if (!socket.found) fail(socket.problem);

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

  if (spec.image) {
    const resolved = resolveImage(spec.image, spec.docker, run);
    if (resolved.image) spec.image = resolved.image;
    if (resolved.problem) fail(resolved.problem);
  } else if (buildVerified) {
    let manifest = null;
    try { manifest = readSealedBundle(spec.bundle, pinned ?? undefined).manifest; } catch {}
    spec.image = manifest?.images?.runtime ?? null;
    if (spec.image) {
      if (!hasImage(spec.image, spec.docker, run)) {
        // the digest is the build's own; another engine only has it once it was
        // pushed to a registry or the image was built there
        fail(`the runtime image ${spec.image} of the LayerFS build is not in this Docker engine: pull it, or build it with "docker build -t <name> tools/runtime" and set "image" to that name`);
      }
    } else {
      fail('no runtime image: the LayerFS build names none; set "image" to an image name or a sha256:… digest');
    }
  }

  deriveDeployment(spec);
  // the status route reports them: a warn() line is easy to miss, and the
  // person looking at a broken deployment is looking at that page
  spec.deploymentProblems = problems;
  return { problems };
}

/**
 * Whether the deployment has everything the runtime needs.
 * @param {import("./config.js").Spec} spec settings
 * @returns {boolean} true when nothing is missing
 */
export const deploymentReady = (spec) => existsSync(spec.bundle ?? "") && Boolean(spec.image && spec.daemon);
