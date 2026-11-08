// The Docker side of a deployment, with no Docker installed and no network:
// which socket detectSocket picks from what exists, and how resolveImage turns
// a reference into an image ID. exists and run are injected, so nothing here
// contacts an engine.
//   node packages/host/tests/deployment-docker.mjs
import assert from "node:assert/strict";
import { detectSocket, resolveImage } from "../src/deployment-docker.js";

const DIGEST = `sha256:${"a".repeat(64)}`, OTHER = `sha256:${"b".repeat(64)}`;
const SOCKET = "/var/run/docker.sock";

const existence = (...paths) => (path) => paths.includes(path);

// a runner that answers from a script in order and keeps every call, so a test
// can check both what docker was asked and that it was not asked at all
function scripted(...answers) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected docker call: ${args.join(" ")}`);
    return { status: 0, stdout: "", stderr: "", ...answer };
  };
  return { run, calls };
}

// the configured socket, when that path is there
{
  const found = detectSocket(SOCKET, { exists: existence(SOCKET), env: {}, homedir: "/Users/me" });
  assert.deepEqual(found, { socket: SOCKET, found: true, problem: null });
}

// else DOCKER_HOST's unix endpoint
{
  const found = detectSocket(SOCKET, { exists: existence("/run/user/501/docker.sock"), env: { DOCKER_HOST: "unix:///run/user/501/docker.sock" }, homedir: "/Users/me" });
  assert.deepEqual(found, { socket: "/run/user/501/docker.sock", found: true, problem: null });
}

// else Docker Desktop's own socket: the install without admin rights this repo hit
{
  const found = detectSocket(SOCKET, { exists: existence("/Users/me/.docker/run/docker.sock"), env: {}, homedir: "/Users/me" });
  assert.deepEqual(found, { socket: "/Users/me/.docker/run/docker.sock", found: true, problem: null });
}

// nothing: the configured path is reported back, with the fix in one sentence
{
  const found = detectSocket(SOCKET, { exists: () => false, env: {}, homedir: "/Users/me" });
  assert.equal(found.found, false);
  assert.equal(found.socket, SOCKET, "an unfound socket still names the configured path");
  assert.match(found.problem, /docker\.sock/, "the problem names a socket to create");
  assert.match(found.problem, /\/var\/run\/docker\.sock/, "the problem names the configured path that is missing");
}

// a tcp:// DOCKER_HOST is not a socket path, so it is ignored rather than used
{
  const found = detectSocket(SOCKET, { exists: () => false, env: { DOCKER_HOST: "tcp://127.0.0.1:2375" }, homedir: "/Users/me" });
  assert.equal(found.found, false);
}

// a digest is already the identity: docker is not called at all
{
  let calls = 0;
  const run = () => { calls++; throw new Error("docker must not run for a digest"); };
  assert.deepEqual(resolveImage(DIGEST, SOCKET, run), { image: DIGEST, pulled: false, problem: null });
  assert.equal(calls, 0, "a digest needs no engine call");
}

// a tag: the engine's Id for it
{
  const { run, calls } = scripted({ status: 0, stdout: `${OTHER}\n` });
  assert.deepEqual(resolveImage("layerfs-352-runtime:node24", SOCKET, run), { image: OTHER, pulled: false, problem: null });
  assert.deepEqual(calls, [["-H", `unix://${SOCKET}`, "image", "inspect", "-f", "{{.Id}}", "layerfs-352-runtime:node24"]], "the inspect names the socket, the format and the reference");
}

// an image the engine lacks: one pull, then the inspect that succeeds
{
  const reference = "ghcr.io/owner/name:tag";
  const { run, calls } = scripted(
    { status: 1, stderr: `Error: No such image: ${reference}\n` },
    { status: 0, stdout: "tag: Pulling from owner/name\n" },
    { status: 0, stdout: `${OTHER}\n` },
  );
  assert.deepEqual(resolveImage(reference, SOCKET, run), { image: OTHER, pulled: true, problem: null });
  assert.deepEqual(calls.map((args) => args.slice(2)), [
    ["image", "inspect", "-f", "{{.Id}}", reference],
    ["pull", reference],
    ["image", "inspect", "-f", "{{.Id}}", reference],
  ], "one pull between two inspects");
}

// the pull works but the retried inspect still fails: pulled, unresolved, and told
{
  const reference = "ghcr.io/owner/name:tag";
  const { run } = scripted(
    { status: 1, stderr: `Error: No such image: ${reference}\n` },
    { status: 0, stdout: "tag: Pulling from owner/name\n" },
    { status: 1, stderr: "Error: image is corrupt\n" },
  );
  const result = resolveImage(reference, SOCKET, run);
  assert.equal(result.image, null);
  assert.equal(result.pulled, true);
  assert.match(result.problem, /corrupt/);
}

// inspect and pull both fail: null, with the reference and the engine's first error line
{
  const reference = "ghcr.io/owner/private:tag";
  const { run, calls } = scripted(
    { status: 1, stderr: `Error: No such image: ${reference}\n` },
    { status: 1, stderr: "Error response from daemon: unauthorized: authentication required\nmore detail on a later line\n" },
  );
  const result = resolveImage(reference, SOCKET, run);
  assert.equal(result.image, null);
  assert.equal(result.pulled, false);
  assert.match(result.problem, /ghcr\.io\/owner\/private:tag/, "the problem names the reference");
  assert.match(result.problem, /unauthorized: authentication required/, "the problem carries the engine's own error");
  assert.doesNotMatch(result.problem, /later line/, "only the first line is kept");
  assert.equal(calls.length, 2);
}

// no reference: the caller is told, and docker is not called
{
  let calls = 0;
  const run = () => { calls++; throw new Error("docker must not run without a reference"); };
  assert.deepEqual(resolveImage(null, SOCKET, run), { image: null, pulled: false, problem: "no image configured" });
  assert.deepEqual(resolveImage("", SOCKET, run), { image: null, pulled: false, problem: "no image configured" });
  assert.equal(calls, 0, "no reference needs no engine call");
}

console.log("deployment-docker: ok");
