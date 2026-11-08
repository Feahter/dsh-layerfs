// Turns a sealed LayerFS build into the release asset ensure.js downloads:
//
//   node tools/release-bundle.mjs <sealed-bundle-dir> <out-dir> [--arch x64]
//   ->  <out-dir>/layerfs-<commit12>/linux-<arch>.tar.gz
//
// The name is the contract ensure.js and deployment-bundle.js depend on
// (`<base>/layerfs-<commit12>/<platform>-<arch>.tar.gz`), and `linux` is fixed
// because a sealed build is the Linux program the runtime image runs, whatever
// the host is; --arch is the container architecture (the Docker engine's, which
// on macOS follows the host). The build is verified before it is packed, so an
// asset is never produced from a bundle whose files do not hash as sealed.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readSealedBundle } from "../packages/host/src/deployment-bundle.js";

const [dir, out, ...rest] = process.argv.slice(2);
const archFlag = rest.indexOf("--arch");
const arch = archFlag === -1 ? process.arch : rest[archFlag + 1];
if (!dir || !out) {
  console.error("usage: node tools/release-bundle.mjs <sealed-bundle-dir> <out-dir> [--arch x64]");
  process.exit(2);
}
if (!/^(x64|arm64)$/.test(arch ?? "")) {
  console.error(`release-bundle: --arch must be x64 or arm64 (the container architecture), not ${JSON.stringify(arch)}`);
  process.exit(2);
}

const source = resolve(dir);
let sealed;
try {
  sealed = readSealedBundle(source);
} catch (error) {
  console.error(`release-bundle: ${error.message}`);
  process.exit(1);
}
const { head } = sealed.manifest.source;
const name = head.slice(0, 12);
const target = resolve(out, `layerfs-${name}`);
mkdirSync(target, { recursive: true });
const asset = join(target, `linux-${arch}.tar.gz`);

// the bundle root is the archive root: deployment-bundle.js strips one wrapping
// directory when there is one, and none is simpler
const tar = spawnSync("tar", ["czf", asset, "-C", source, "."], { encoding: "utf8" });
if (tar.error ?? tar.status !== 0) {
  console.error(`release-bundle: tar failed: ${tar.error?.message ?? tar.stderr?.trim()}`);
  process.exit(1);
}
const size = statSync(asset).size;
const { version, build_id } = sealed.manifest;
// what ensure.js will log and what the status route will report
console.log(`release-bundle: ${asset} (${(size / 1024 / 1024).toFixed(1)} MiB, ${sealed.files} files verified)`);
console.log(`release-bundle: LayerFS ${head}, build ${build_id}, manifest version ${version}`);
console.log(`release-bundle: serve ${target} as ${join("layerfs-" + name, `linux-${arch}.tar.gz`)} under the configured "releases" base`);
