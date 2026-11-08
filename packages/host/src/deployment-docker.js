// The Docker side of a deployment: the Unix socket an engine answers on, and
// the image ID a configured reference names. A profile settles both before a
// Sandbox starts, so a missing socket or image reaches the person as one
// sentence with the fix in it, not as docker's wording inside a later failure.
// The only engine change made here is the pull a name or tag needs before it
// can run.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Docker Desktop's per-user socket, relative to the home folder. An install
// without admin rights never creates /var/run/docker.sock, so this is very
// often the only socket that machine has.
const DESKTOP = join(".docker", "run", "docker.sock");

/**
 * docker's error text cut to its first line: the rest is hints and progress
 * output, and the caller reports one sentence.
 * @param {string} [text]
 * @returns {string}
 */
const firstLine = (text) => String(text ?? "").trim().split("\n")[0].trim();

/**
 * Why a docker call failed, in the engine's own words when it wrote any. A
 * spawn that never reached docker leaves stderr empty, and a caller still needs
 * a cause instead of a message that stops at the colon.
 * @param {{ status: number|null, stdout: string, stderr: string }} [result]
 * @returns {string}
 */
const failureOf = (result) =>
  firstLine(result?.stderr) || firstLine(result?.stdout) ||
  (result?.status === null ? "docker did not run (is it installed and on PATH?)" : `docker exited ${result?.status} without an error message`);

/**
 * The socket to use, trying what the profile configured first, then
 * DOCKER_HOST's unix endpoint, then Docker Desktop's own socket. The order is
 * the one a person would try by hand: an explicit setting wins, and a Desktop
 * socket that exists is better than refusing a machine that runs Docker fine.
 * @param {string} configured the socket the profile configured (config.js defaults to /var/run/docker.sock)
 * @param {{ exists?: (path: string) => boolean, env?: Record<string,string>, homedir?: string }} [options]
 *   exists/homedir are injected so the test needs no real Docker; default existsSync/homedir()
 * @returns {{ socket: string, found: boolean, problem: string|null }}
 */
export function detectSocket(configured, options = {}) {
  if (typeof configured !== "string" || !configured) throw new Error("detectSocket needs the configured Docker socket path, such as /var/run/docker.sock");
  const exists = options.exists ?? existsSync;
  const env = options.env ?? process.env;
  const home = options.homedir ?? homedir();
  if (exists(configured)) return { socket: configured, found: true, problem: null };
  // only unix:// names a socket path; a tcp:// DOCKER_HOST has no file to test,
  // so it cannot be used here and the configured value stays the candidate
  const host = typeof env.DOCKER_HOST === "string" ? env.DOCKER_HOST : "";
  const endpoint = host.startsWith("unix://") ? host.slice("unix://".length) : "";
  if (endpoint && exists(endpoint)) return { socket: endpoint, found: true, problem: null };
  const desktop = join(home, DESKTOP);
  if (exists(desktop)) return { socket: desktop, found: true, problem: null };
  return {
    socket: configured,
    found: false,
    problem: `cannot use ${configured}: that Docker socket does not exist; enable "Allow the default Docker socket to be used" in Docker Desktop's settings, or run sudo ln -sfn "$HOME/.docker/run/docker.sock" ${configured}`,
  };
}

/**
 * The `docker` command runner this module uses by default; a test replaces it.
 * A spawn that fails before docker writes anything (not installed, timed out)
 * leaves stderr empty, so the spawn error's own message is carried there: every
 * caller here reports stderr as the cause.
 * @param {string[]} args
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
export function dockerRun(args) {
  const { status, stdout, stderr, error } = spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
  return { status, stdout: stdout ?? "", stderr: stderr || error?.message || "" };
}

/**
 * The image ID a reference names, resolving a tag through the engine and pulling
 * the reference when the engine does not have it yet.
 * @param {string} reference either "sha256:<64 hex>" (returned as-is, no Docker call)
 *   or an image name/tag (`layerfs-352-runtime:node24`, `ghcr.io/owner/name:tag`)
 * @param {string} socket the socket from detectSocket
 * @param {(args: string[]) => {status: number|null, stdout: string, stderr: string}} [run] default dockerRun
 * @returns {{ image: string|null, pulled: boolean, problem: string|null }}
 *   image = the "sha256:…" Id, or null when it cannot be resolved;
 *   missing images are pulled (`docker -H unix://<socket> pull <reference>`), and the inspect retried once;
 *   problem names the reference and the engine's own error text (trimmed, first line).
 */
export function resolveImage(reference, socket, run = dockerRun) {
  if (typeof reference !== "string" || !reference.trim()) return { image: null, pulled: false, problem: "no image configured" };
  const wanted = reference.trim();
  // a digest is the identity itself: the engine cannot name a different ID for
  // it and a pull would not change it, so this path must not need Docker at all
  if (/^sha256:[0-9a-f]{64}$/i.test(wanted)) return { image: wanted, pulled: false, problem: null };
  const docker = (...args) => run(["-H", `unix://${socket}`, ...args]);
  const inspect = () => {
    const result = docker("image", "inspect", "-f", "{{.Id}}", wanted);
    const id = result?.status === 0 ? String(result.stdout ?? "").trim() : "";
    return { id, result };
  };
  const known = inspect();
  if (known.id) return { image: known.id, pulled: false, problem: null };
  // an inspect that exits 0 but prints nothing is a broken answer, not a missing
  // image: pulling would add network traffic and leave the answer just as broken
  if (known.result?.status === 0) return { image: null, pulled: false, problem: `cannot resolve image "${wanted}": docker image inspect printed no image ID` };
  // a name or tag is known to the engine only once it is there, so pulling is
  // the fix; the retried inspect is what proves the pull produced a usable image
  const pulled = docker("pull", wanted);
  if (pulled?.status !== 0) return { image: null, pulled: false, problem: `cannot resolve image "${wanted}": docker pull failed: ${failureOf(pulled)}` };
  const after = inspect();
  if (after.id) return { image: after.id, pulled: true, problem: null };
  return { image: null, pulled: true, problem: `pulled image "${wanted}" but docker image inspect still returns no ID: ${failureOf(after.result)}` };
}
