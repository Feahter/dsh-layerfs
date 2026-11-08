# dsh-layerfs 插件化 — 执行进展

> 对应 `pluginize-plan.md` 的 P0 与 P1。写入日期：2026-11-08。
> 分支 `pluginize/p0-installable`（两个提交：`e9fddcd` P0、`66eac39` P1），基线 `b9bf3bc`。

---

## 1. 结论

`dsh plugin add <tarball>` 现在能装上、能自配置、能跑起来：全新 profile、`cordis.patch.yml` 为 `[]`，
`/layerfs/status` 的 `missing` 与 `problems` 都为空，`/layerfs/runtime` 的 engine 为 ok、Store 的 worker
running 且 answering。不需要 dsh 源码，不需要 LayerFS checkout，不需要 cargo，不需要手写配置。

---

## 2. 与计划的三处偏离（都是实测逼出来的）

| 计划假设 | 实测 | 现在的做法 |
|---|---|---|
| B1 只是 `package.json` 的 `link:` | host 运行时还从 checkout 读两样东西：`api/cli`（每个 bash 调用里的 `layerfs` 命令）和 `.agents/skills/`（SDK skill），都在 `src/source.js` | 连 `api/cli` 与 skill 一起 vendor，`source.js` 指向 vendor 树，运行时不再碰 checkout |
| P0-4 走「发 npm」或「发 tarball」都行 | `pnpm pack` 把 `workspace:*` 改写成 `0.1.0`，而 `@dsh-layerfs/*` 不在 npm 上 → `ERR_PNPM_FETCH_404`；`~/.npmrc` 的 npm token 已失效（`npm whoami` → 401） | 打成一个零依赖的自包含包（`dist/`），tarball 即可离线安装 |
| 一个 bundle 多个 package，三行 patch | dsh 只从「解析到包根且声明 `dsh.client`」的 row 提供客户端 bundle，子路径 row 永远不是 client row | host 行改为指向 bundle 自身（`exports["."]` 与 `exports["./client"]` 两个面），`layerfs-client` 行随之取消 |

---

## 3. 做了什么

**P0-1 依赖去 `link:` 化**
`tools/vendor-layerfs.mjs` 把 `api/{agent,backend,runtime,cli}` 的 `src` 与 `.agents/skills/layerfs-js-sdk`
复制到 `packages/host/vendor/layerfs`（133 文件，布局与 checkout 同构，因此 `api/cli/src/layerfs.js` 之类的
相对路径不用改）。两处改写：`@layerfs/*` → `#layerfs/*`（由 `packages/host/package.json` 的 `imports` 解析），
CLI 的 `layerfs --version` 改读 `VENDOR.json`。`agent/src` 逐字节不变（Windows 的 worker 用它和 sealed 产物的
哈希比对）。`sync` 写入、`check` 比对漂移，`pnpm test` 里跑 `check`。

**P0-2 / P0-3 发布物**
`tools/assemble-bundle.mjs` 把六个包装成 `dist/`：`"."` = host、`"./client"` = 客户端 bundle、
`"./mock"` = mock，`packages/` 下保留 workspace 布局（mock 的默认 scenarios 路径、host 的 `../vendor` 都因此不变）。
`dependencies` 为空、只有 `peerDependencies`。客户端 bundle 由 `pnpm run build` 产出（需要 `DSH_SOURCE`，仅构建侧）。

**P0-4 端到端**
全新 `DSH_HOME` → `dsh plugin --profile web add dist/dsh-layerfs-0.1.0.tgz` → `--dump-config` 出现
`layerfs-host`/`layerfs-mock` 与 `default: layerfs-dsh-minimalist` → 启动后 `/layerfs/status` 应答、
首页 boot 图里含 `dsh-layerfs/client.js`。

**P1-1 镜像引用化** `packages/host/src/deployment-docker.js`：`sha256:…` 原样返回（不调 docker）；名字/标签
经 `docker image inspect` 解析成 ID，缺则 `pull` 后重试。

**P1-2 bundle 自动获取** `deployment-bundle.js`：缓存 `<cache>/<commit12>`，命中且通过校验就用；否则按
`<base>/layerfs-<commit12>/linux-<arch>.tar.gz` 下载，解包后用 manifest 逐文件校验再原子换入。篡改、跨 commit、
半个缓存都不使用。`tools/release-bundle.mjs` 从一个 sealed 目录产出这种命名的资产。

**P1-3 首启 ensure** `ensure.js`：socket → bundle → image → daemon 依次补齐，失败只收集不阻塞，原因写进
`/layerfs/status` 的 `problems`（每条都带修法）。

**P1-4 Docker 前提坑** `detectSocket`：配置路径 → `DOCKER_HOST` 的 `unix://` → `~/.docker/run/docker.sock`；
都不在时给出「开启 Docker Desktop 默认 socket」或 `sudo ln -sfn …` 的具体建议。

---

## 4. 证据（可复跑）

```sh
export PATH="/Users/fuzhuo/.nvm/versions/node/v22.22.0/bin:$HOME/.docker/bin:$PATH"
node /Users/fuzhuo/Documents/dsh-src/apps/cli/lib/bin.js --version   # 0.2.1-rc.4

pnpm test                              # 16 项全绿，含 vendor 漂移与 bundle 不变量
node tools/vendor-layerfs.mjs check    # 133 files match … at fabefdf87a4f
node tools/assemble-bundle.mjs         # 196 files, 3.3 MiB, 内容哈希可复现
```

D4 复跑：全新 `DSH_HOME`、`cordis.patch.yml` 保持 profile 模板的 `[]`、cache 里有 `fabefdf87a4f/`
→ `missing: []`、`problems: []`、`image` 为 manifest 里的 digest、`/layerfs/runtime` engine ok /
store running & answering。

篡改复跑：`chmod u+w ~/.cache/dsh-layerfs/fabefdf87a4f/api/package.json` 改一个字节 → 再启动，
`missing` 回到 `[image, daemon, bundle]`，`bundle` 为 null（拒绝运行，而不是跑坏件）。

---

## 5. 仍未闭环

1. **没有公开 release**：`releases` 默认指向 `github.com/Feahter/dsh-layerfs/releases/download`，该位置今天
   没有资产，所以冷缓存 + 空 patch 的机器会得到一条可操作的报错，而不是自动装好。用
   `tools/release-bundle.mjs` 产出资产并上传即可闭环（本机验证用的是 `file://` 本地 release 与预热缓存）。
2. **运行时镜像没有 registry**：manifest 里是 digest，跨机器必须能 `docker pull` 到它；本机是本地构建。
   推到 ghcr 后 P1-1 的 pull 路径才对外生效。
3. **P1-5 CI 未做**：GitHub Actions 需要能推仓库，本次没有推送，未写 workflow。
4. **Windows 的 specifier 位置修过一次**：`api/runtime` 用 `import.meta.resolve("@layerfs/agent")`
   调用 SDK，最初的改写规则没覆盖这个位置，装到消费者侧会解析失败；已补上规则，并在
   `tools/checks/tests/bundle.mjs` 里加了「vendor 树里任何 import / re-export / 动态 import /
   import.meta.resolve 都不得再出现 `@layerfs`」的守卫（把 bug 塞回去验证过守卫会报）。
5. **Linux / Windows 路径未实机验证**：Linux 的 in-process Store 依赖
   `api/agent/src/transport/inprocess.js` 里 4 层向上的 `engine/crates/layerfs-node/layerfs.node`
   （vendored 布局同深度，今天两边都不存在该文件）；Windows 的 WSL 身份校验依赖 `agent/src` 字节一致，
   这一点由 vendor 的 `check` 保证但没有在 Windows 上跑过。
6. **P2 全部未做**：市场索引、engines 兼容性核对、README 改写。
7. **本机遗留**：一个旧项目的 Store 卷 `layerfs-shy-otter-store-mw7emov0`（213 KB，无容器）让
   `/layerfs/runtime` 的聚合 level 显示 `degraded`（"1 leftover"），与本次部署无关；插件自己的 Leaks 视图可清，
   我没有删（属于上一个 session 的项目数据）。
8. **`packages/dsh-layerfs` 已标 `private: true`**：它是开发期的 bundle（rows 指向 `@dsh-layerfs/*`），
   发布物是 `dist/`；发布 npm 时别装错。
9. **`link:` 开发安装在本机跑不起来（既有问题，与本次改动无关）**：把仓库目录 link 进 profile 时，
   `@deepseek-ai/schemastery` / `@deepseek-ai/dsh-llm` 这些 peer 从 profile 外的路径解析不到，dsh 报
   `2/3 entries did not activate`。已在 `b9bf3bc` 的干净 worktree 上复现同样报错，所以不是本次引入的回归；
   受影响的只是开发期 link 安装，`dist/` 的 tarball 安装（真实发布路径）不受影响。要修的话，方向是给
   `packages/host`、`packages/mock` 造出 `@deepseek-ai/*` 的本地解析（例如在仓库根 `node_modules` 里放
   dsh 检出目录的软链），或让开发流程同样走 `dsh plugin add <dir>` 的复制安装而非 link。
