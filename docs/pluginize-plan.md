# dsh-layerfs 插件化改造 — 任务计划（交接文档）

> 状态：调研完成，尚未动代码。本文件是给下一个 session 的开工依据。
> 写入日期：2026-11-08。目标仓库：`Feahter/dsh-layerfs`（当前是空 fork，无自有提交）。

---

## 1. 目标与完成定义

**目标**：让 `dsh-layerfs` 能像普通 DSH 插件一样装——`dsh plugin add`（npm 或 git 源）一条命令完成，装完不需要手工编译、不需要手写 `cordis.patch.yml`。

**完成定义（DoD）**，四条全绿才算完成：

| # | 验收项 | 判定命令 |
|---|---|---|
| D1 | 从 git 源装进全新 profile 成功 | `dsh plugin add` 后 `dsh --profile <p> --dump-config` 出现 `layerfs-host` / `layerfs-client` / `layerfs-mock` |
| D2 | 消费者不需要 dsh 源码树 | 在没有 `DSH_SOURCE`、且 `~/Documents/dsh-src` 不可见的环境里，profile 仍能加载客户端 bundle |
| D3 | 消费者不需要 LayerFS 源码 / cargo | 全新机器上不 clone `layerfs`、不装 Rust，只靠 `docker pull` + 下载产物即可 |
| D4 | 不需要手写配置 | `cordis.patch.yml` 留空（或只写一个 tag），首启后 `/layerfs/status` 的 `missing` 为空且 `/layerfs/runtime` 为 `ok` |

**明确不承诺**：Docker 引擎本身无法插件化。macOS 上必须有 Linux VM（Store 是 Linux 二进制 + FUSE + Docker named volume + Sandbox 容器）。插件能做到的是"检测 + 明确报错 + 引导"，不是消除。

---

## 2. 当前已验证状态（这台机器）

全部为实测，可作为下一步的基线：

| 项 | 值 / 结果 |
|---|---|
| 系统 | macOS 15.7.9，Intel x86_64，8 CPU，16 GiB，磁盘余 ~26 GiB |
| Node / pnpm | `22.22.0` / `10.30.3`，位于 `/Users/fuzhuo/.nvm/versions/node/v22.22.0/bin` |
| dsh 源码 | `/Users/fuzhuo/Documents/dsh-src` @ `504a01a9`（`0.2.1-rc.4`），`pnpm run build` **9 passed, 0 failed** |
| 本仓库 | `/Users/fuzhuo/Documents/deepseek-harness/dsh-layerfs` @ `b9bf3bc` |
| LayerFS checkout | `/Users/fuzhuo/layerfs` @ `fabefdf`（`layerfs.json` 要求的 commit） |
| Docker | Docker Desktop `4.98.0`，engine `29.9.2` linux/amd64；**非管理员安装**：CLI 在 `~/.docker/bin`，socket 在 `~/.docker/run/docker.sock` |
| 运行时镜像 | `layerfs-352-runtime:node24` = `sha256:f2f752d8b869b6d689ed3fac273bdf4973dc5eb19a517c2b791e9a9c5e560c18` |
| sealed bundle | `/Users/fuzhuo/.cache/layerfs-worktrees/layerfs-775f54378636/artifacts/build-linux-53a1c5323ee64f958762cd0c4a0f42ec`（184 文件，`status: sealed`） |
| Profile | `DSH_HOME=/Users/fuzhuo/dsh-layerfs`，profile `web`，用 `link:` 装的 `link:` |
| `pnpm test` | **全绿**：host / agent wrappers / bindings-shared / mock(10) / cli(43) / playback(16) / initlimit / historycache / model trace / checks |
| `GET /layerfs/status` | `{"configured":true,"missing":[]}` ✅ |
| `GET /layerfs/runtime` | `{"level":"down", … "dial unix /var/run/docker.sock: no such file or directory"}` ❌ |
| dsh web | `http://127.0.0.1:3090/?token=…`，HTTP 200 |

**唯一未闭环的运行时缺口**：`/var/run/docker.sock` 不存在。非管理员 Docker Desktop 默认不创建它（`EnableDefaultDockerSocket: false`，开启需要管理员密码）。LayerFS 的 macOS worker 把这条路径原样 bind 进容器，并用 `docker -H unix:///var/run/docker.sock` 调用。修复需要一次 root：

```sh
sudo ln -sfn "$HOME/.docker/run/docker.sock" /var/run/docker.sock
```

> 这条**没有执行成功**（`sudo -n` 仍要密码，`/var/run/docker.sock` 至今不存在）。它同时也是 P1-3 要解决的产品问题：插件应当检测到并给出可操作提示，而不是让用户去猜。

---

## 3. 阻塞清单（为什么今天装不进市场）

| # | 阻塞 | 证据（代码位置） | 解法 |
|---|---|---|---|
| B1 | **SDK 依赖是文件链接** | [`packages/host/package.json`](packages/host/package.json) 里 `@layerfs/agent: link:../../.layerfs/api/agent`（backend / runtime 同）。从 npm/git 源安装时，pnpm 在 profile 目录解析这个相对路径 → 必然失败 | 二选一：① 依赖 npm 上的 `@layerfs/*`（已有 `1.1.0-rc.1`，但本地 checkout 是 `1.1.0`，版本要对齐）；② 把三个包 vendor 进 `@dsh-layerfs/host`（它们是零依赖纯 JS，最稳） |
| B2 | **客户端要现场编译** | `pnpm run build` → `tools/build-client.mjs` 需要 `$DSH_SOURCE/node_modules/.bin/tsdown` | 发布前构建，`packages/client/lib/{index,client}.js` 已在 `files` 里；消费者侧删掉构建依赖 |
| B3 | **daemon + addon 要现场编** | README 第 1 步：`rust:1.85.1-bookworm` 跑 cargo；macOS 还要 sealed `manifest.json`（worker 逐个校验） | CI（GitHub Actions 有 Docker）用 `tools/worktree.py` 产出，作为 release 资产 |
| B4 | **镜像要现场 build、digest 写死** | `missingDeployment` 要求 `image`（`sha256:…`）来自 patch；镜像只有本地 tag，无 registry | 推 `ghcr.io`，`image` 改成**引用**，运行时用 `docker image inspect -f '{{.Id}}'` 解析 |

补充事实：`@layerfs/agent|runtime|backend` **确实已发布到 npm**（`1.1.0-rc.1`，2026-11-01），`dsh-layerfs` 本身 404 未发布。市场索引支持 `source: {type: "npm"}` 与 `{type: "git", url, commit, path}` 两种（见 `dsh` 的 `docs/user/guide/plugin-market.zh.md`）。

---

## 4. 任务分解

每项：交付物 / 改动点 / 验收 / 备注。**P0 决定"能不能装上"，P1 决定"装上还要不要手工配"。**

### P0 — 可安装（预计 0.5–1 天）

#### P0-1 依赖去 `link:` 化
- **交付**：`packages/host/package.json` 的 `@layerfs/*` 三个依赖不再是 `link:`。
- **方案 A（推荐，稳）**：vendor。`api/agent`、`api/backend`、`api/runtime` 是无依赖纯 JS，复制到 `packages/host/vendor/layerfs/{agent,backend,runtime}`，改成相对导入；在 `package.json` 里删掉三个依赖。
- **方案 B**：改为 `"@layerfs/agent": "1.1.0"` 等，前提是上游把 `1.1.0` 发到 npm（目前只有 `1.1.0-rc.1`），且与 `layerfs.json` 的 pinned commit 一致。
- **验收**：`pnpm pack` 出的 tarball 里 `pnpm-lock.yaml`/`package.json` 无 `link:`；`grep -r "link:\.\./\.\./\.layerfs" packages/*/package.json` 无输出。
- **风险**：方案 A 要同步 vendor 版本与 daemon/addon 版本（三者必须同源），需在 CI 里断言。

#### P0-2 `workspace:*` 改真实版本
- **交付**：`packages/dsh-layerfs`、`packages/client`、`packages/host`、`packages/model`、`packages/mock` 的 `workspace:*` 在发布时被改写。
- **验收**：`pnpm publish --dry-run --no-git-checks` 输出的 tarball 元数据里没有 `workspace:` 协议。
- **备注**：`pnpm publish` 会自动改写，但**前提是 B1 已解决**（`link:` 不会被改写）。

#### P0-3 客户端产物随包发布
- **交付**：发布流程先 `pnpm run build`（需要 `DSH_SOURCE`，仅 CI/维护者侧），再 `pnpm publish`；tarball 含 `packages/client/lib/{index,client}.js`。
- **验收**：`npm pack` 后 `tar -tzf *.tgz | grep 'client/lib/client.js'` 命中；在**没有 dsh 源码**的机器上装一次，页面能加载 LayerFS 面板。
- **备注**：当前 `lib/index.js` 只有 113 B（空 apply），`client.js` 1.24 MB，均已存在于本机。

#### P0-4 装进全新 profile（端到端验证）
- **已实测事实**：`dsh plugin` 不自己解析安装源，它把参数**原样转发给 pnpm**：
  `dsh plugin [options] [args...]`，`--profile <name>` 选 profile，其余透传。
  `dsh plugin --profile web add --help` 打印的是 `pnpm add` 的用法，支持：npm 名、`<git repo url>`、`<tarball file>`、`<tarball url>`、`<dir>`。
- **由此得到的硬约束**：本仓库的 bundle 在**子目录** `packages/dsh-layerfs`，而 pnpm 的 git spec **不能指定子目录**。三条可行路径：
  1. **发 npm（推荐）**：`dsh-layerfs` 作为 umbrella 包发布 → `dsh plugin --profile web add dsh-layerfs`。
  2. **发 tarball**：CI 产出 `dsh-layerfs-<ver>.tgz` → `dsh plugin --profile web add ./dsh-layerfs-<ver>.tgz`。
  3. **市场索引的 git 源**：索引写 `source: {type: "git", url, commit, path: "packages/dsh-layerfs"}`，由市场安装器处理子目录（`dsh` 的 `docs/user/guide/plugin-market.zh.md` 支持 `path`）。
- **验收**：`dsh --profile web --dump-config` 出现 `layerfs-host` / `layerfs-client` / `layerfs-mock`，默认 preset 是 `layerfs-dsh-minimalist`。
- **注意 ⚠️**：路径 3 只解决"市场能装"，**不解决"CLI 一条命令能装"**。若 DoD 要求 `dsh plugin add`，必须走路径 1 或 2。

### P1 — 装完即可用（预计 1–2 天）

#### P1-1 `image` 引用化 + 运行时解析
- **改动**：[`packages/host/src/config.js`](packages/host/src/config.js) 的 `resolveConfig` / `missingDeployment`。
- **行为**：`image` 接受两种值——`sha256:…`（原样用）或 `ghcr.io/feahter/layerfs-runtime:<tag>`（用 `docker image inspect -f '{{.Id}}'` 解析成 digest；本地没有则 `docker pull`）。解析结果写回 spec，用在 worker 与 Init。
- **验收**：patch 只写 tag 时 `/layerfs/status` 的 `image` 字段显示解析出的 `sha256:…`；`docker rmi` 后重启能自动 pull。
- **备注**：README 明确"同一构建在不同 image store 里 ID 不同"，所以 digest 绝不能硬编码。

#### P1-2 bundle 自动获取
- **行为**：`bundle` 未配置时，从 release 资产下载 `<platform>-<arch>.tar.gz`，校验 `manifest.json`（`status: sealed` + 逐文件 sha256），解到 `~/.cache/dsh-layerfs/<layerfs-commit>/`，再交给 runtime。
- **验收**：删掉缓存目录，重启 dsh web，`/layerfs/status` 的 `bundle` 指向新解出的目录，`manifest.json` 校验通过；篡改任一文件后启动必须拒绝（证明校验真的生效）。
- **备注**：`api/runtime/src/worker/server.js` 会自己再校验一次，属于双保险。

#### P1-3 首启 ensure 钩子
- **改动**：[`packages/host/src/index.js`](packages/host/src/index.js) 的 `apply()`，在 `openRuntime(spec)` 之前插入异步 ensure（解析镜像 → 缺则 pull → 缺 bundle 则下载）。
- **要求**：失败只 `warn`，不阻塞 dsh 启动；错误信息必须可操作（例如 Docker 没装 / `/var/run/docker.sock` 不存在时给出具体建议）。
- **验收**：全新 profile + 本地无镜像无 bundle，启动后 30 s 内 `/layerfs/runtime` 变 `"level":"ok"`；Docker 未运行时启动不崩、状态页给出明确原因。

#### P1-4 修掉本机踩到的 Docker 前提坑（产品化）
- **问题**：非管理员 Docker Desktop 不创建 `/var/run/docker.sock`，而 runtime 硬编码这条路径。
- **最低要求**：启动自检时检测 socket 缺失并提示（"你的 Docker 用的是用户级 socket，请 `sudo ln -sfn "$HOME/.docker/run/docker.sock" /var/run/docker.sock`，或在 Docker Desktop 设置里启用默认 socket"）。
- **更好**：把 `VM_DOCKER` 从常量改为可配置/自动探测（`settings.docker` 已是配置项，但容器内路径写死在 `api/runtime/src/platform/macos/index.js` 的 `VM_DOCKER`）。
- **验收**：模拟缺失 socket，状态页出现上面那条提示而不是泛化报错。

#### P1-5 CI 产物
- **交付**：GitHub Actions 工作流，tag 推送时产出三样：release 资产（sealed bundle，按平台/架构）、`ghcr.io/feahter/layerfs-runtime:<tag>` 镜像、可被市场索引引用的 npm 包（或 git 源条目）。
- **验收**：打一个测试 tag，三样产物齐全；用产物在干净机器上走完 P0-4。

### P2 — 市场与兼容（预计 0.5 天）

- **P2-1 市场索引**：`format: 1` 的 JSON，`plugins[].versions[].source` 用 git 源（`repo + commit + path: "packages/dsh-layerfs"`）先验证，稳定后再切 npm。
- **P2-2 engines 兼容**：`engines.dsh: ">=0.2.1-alpha.4 <0.3.0"` 会参与市场兼容性过滤；本机 dsh 是 `0.2.1-rc.4`，确认区间包含它并写下依据。
- **P2-3 README 改写**：把"六步手工安装"降级为"开发者指南"，主路径改成插件安装 + Docker 前提说明。

---

## 5. 端到端验收流程（给下一个 session 直接跑）

```sh
# 0. 前置：Docker 引擎可用，且 /var/run/docker.sock 存在（否则先修 P1-4）
docker info --format '{{.ServerVersion}}'
ls -l /var/run/docker.sock

# 1. 全新 profile
export DSH_HOME=$HOME/dsh-layerfs-e2e && rm -rf "$DSH_HOME"
dsh plugin --profile web add <新安装 spec>          # 见 P0-4

# 2. 组合正确
dsh --profile web --dump-config | grep -E 'layerfs-(host|client|mock)|layerfs-dsh-minimalist'

# 3. 空 patch 自举（D4）
cat "$DSH_HOME/profiles/web/cordis.patch.yml"        # 应为 [] 或只有注释
# 启动 dsh web，等 30s

# 4. 状态
curl -s -H "Cookie: $COOKIE" http://127.0.0.1:3090/layerfs/status   # missing: []
curl -s -H "Cookie: $COOKIE" http://127.0.0.1:3090/layerfs/runtime  # level: ok

# 5. 回归
cd <repo> && pnpm test
```

> 认证：`GET /?token=<token>` 拿 `Set-Cookie`，后续请求带该 cookie。

---

## 6. 环境坑（这台机器实测，省得重踩）

| 坑 | 现象 | 处理 |
|---|---|---|
| `node_modules` 被做成软链 | `pnpm run build` 报 `ERR_PNPM_UNSAFE_TASK_RUN_PATH` | 删软链，正经 `pnpm install` |
| 源码放在 `~/Documents` | Docker bind mount 永久卡死，**并连带整块 `/Users` 共享都卡死** | 源码放 `~/layerfs` 之类非 TCC 保护目录；卡死后要重启 Docker Desktop 才恢复 |
| Docker Desktop 非管理员安装 | `EnableDefaultDockerSocket: false` → 无 `/var/run/docker.sock` | 见 P1-4 |
| Docker Hub 不可达 | `docker pull` 超时 | `~/.docker/daemon.json` 配 `registry-mirrors`（`docker.m.daocloud.io` / `docker.1ms.run` / `dockerproxy.com`），重启 Docker |
| Docker 文件共享范围 | 默认 `/Users` 共享在上面那台机器上卡死 | `FilesharingDirectories` 收窄到 `/Users/fuzhuo` |
| dsh 安装的 lefthook postinstall | 拒绝改写全局 `core.hooksPath` | `DSH_LEFTHOOK_ALLOW_HOOKS_PATH_OVERRIDE=1 pnpm install` |
| `tools/worktree.py` 的 115 s 上限 | `prepare` 的 `cargo fetch` 超时 | 先用等价的 `docker run … cargo fetch` 手动预热（无上限），再跑 `prepare` |
| macOS 无 `timeout` | 脚本里用不了 | 用 `gtimeout` 或 bash 后台 + `kill` |

**构建命令（本机已验证可跑）**：

```sh
# 运行时镜像
docker build -t layerfs-352-runtime:node24 <repo>/tools/runtime
docker image inspect --format '{{.Id}}' layerfs-352-runtime:node24

# sealed bundle
cd ~/layerfs
python3 tools/worktree.py register --worktree "$PWD" --owner dsh \
  --build-image rust:1.85.1-bookworm \
  --runtime-image layerfs-352-runtime:node24 \
  --sandbox-image layerfs-352-runtime:node24
python3 tools/worktree.py prepare --resources <resources.json> --platform linux
python3 tools/worktree.py build   --resources <resources.json> --platform linux --profile release --jobs 6
# 打印 sealed bundle 路径；实测 cargo 段 2m08s
```

---

## 7. 关键代码位置（改造时的入口）

| 主题 | 文件 |
|---|---|
| 配置解析、必填判定 | `packages/host/src/config.js`（`resolveConfig` / `missingDeployment` / `runtimeSettings`） |
| 插件装配、启动 worker | `packages/host/src/index.js`（`apply`） |
| macOS worker 与容器挂载（含硬编码 `/var/run/docker.sock`） | `../layerfs/api/runtime/src/platform/macos/index.js` |
| Store 卷（`layerfs.role=store`） | `../layerfs/api/runtime/src/volume.js` |
| 客户端构建 | `tools/build-client.mjs`、`packages/client/tsdown.config.ts` |
| 构建/封包工具 | `../layerfs/tools/worktree.py`、`worktree_build.py` |
| bundle 声明 | `packages/dsh-layerfs/package.json`（`dsh.bundle.patch`） |

---

## 8. 未决问题

1. ~~`dsh plugin add` 接受哪些安装 spec~~ **已查清**：`dsh plugin` 把参数原样转发给 pnpm（`dsh plugin --profile web add --help` 打印 `pnpm add` 的用法）。因此只支持 npm 名 / tarball / 目录 / git **仓库根**；子目录包必须靠「发 npm」「发 tarball」或「市场索引的 `source.git.path`」三选一（见 P0-4）。
2. SDK 走 npm 还是 vendor？取决于上游 `@layerfs/*` 何时以 `1.1.0` 发布，以及是否与 `layerfs.json` 的 pin 同源。**目前 npm 上只有 `1.1.0-rc.1`，本地 checkout 是 `1.1.0`**。
3. 一个 bundle 名下的多个 package（host/client/mock/model）如何整体发布——`dsh-layerfs` 是否作为 umbrella 包只声明 `dependencies`。
4. macOS 之外：Linux 上 Store 进程内跑（无 worker 容器），插件化路径与 macOS 不同，需分别验。
5. 谁来承担运行时镜像的体积（2.43 GB）：ghcr 公开拉取 vs 用户本机 build，影响首装体验与"离线可用"。

---

## 9. 给新 session 的开场提示（可直接粘贴）

> 按 `docs/pluginize-plan.md` 做 P0（P0-1 → P0-4）。安装源约束已经查清：`dsh plugin` 透传 pnpm，子目录包只能靠发 npm / 发 tarball / 市场索引的 `source.git.path`，所以先把 P0-1（去 `link:`）和 P0-3（客户端产物）做掉，再定发布形态。每完成一项跑对应验收命令并贴输出；全部 P0 绿了再动 P1。
