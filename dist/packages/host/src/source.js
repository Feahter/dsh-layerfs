// The LayerFS tree this package ships: everything of LayerFS the Host runs on,
// vendored under vendor/layerfs so a consumer install needs no LayerFS
// checkout. `node tools/vendor-layerfs.mjs sync` copies it from the checkout
// layerfs.json pins (api/agent, api/backend, api/runtime: the SDK, through the
// #layerfs/* subpath imports packages/host/package.json declares; api/cli: the
// layerfs command every agent bash call gets; .agents/skills/layerfs-js-sdk:
// the SDK skill), and `... check` fails when the tree drifted.
// The vendored layout mirrors the checkout root, so a path read off LAYERFS
// (api/cli/src/layerfs.js, .agents/skills/...) means the same thing here as in
// a checkout.
import { fileURLToPath } from "node:url";

/** The vendored LayerFS root: the checkout's api/ and agent skill, as shipped. */
export const LAYERFS = fileURLToPath(new URL("../vendor/layerfs/", import.meta.url));
