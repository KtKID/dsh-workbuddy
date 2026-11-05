# 发布说明

本包按 DSH 官方的[打包与安装插件](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/user/develop/basic/publish.zh.md)发布。该链接固定到本次适配的上游提交。

## 包结构

- `package.json` 声明 `dsh.bundle.patch`、`engines.dsh`、macOS、Linux 平台和 Host / Client 导出。
- `cordis.patch.yml` 按包名插入 `workbuddy` 插件行。
- `lib/` 提供预构建 Host 模块、类型声明和浏览器模块；浏览器模块加载器 ID 为 `dsh-workbuddy`。
- `locale/` 和 `icon.svg` 提供可分发的插件名称、简介与原创图标。
- 需要与宿主共享实例的 DSH 包和 Cordis 放在 peerDependencies；开发时使用同版本 devDependencies。官方 ACP SDK、MCP SDK 与 `zod` 为普通运行依赖。

## 生成发行包

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
pnpm pack --pack-destination dist
```

`prepack` 从源码生成当前构建产物。检查 `.tgz` 中包含导出目标、patch、locale 和图标，并通过隔离 profile 执行实际安装与 `--dump-config`。安装后的 Host 导入和 Client factory 注册均需成功。

在公开上传前，核对源码和包内文件中的凭据、本机运行数据、绝对个人路径及工作区依赖。发布本仓库的源码和 `.tgz`，运行日志由本机保存。

## 发布版本

更新包版本，提交通过验证的内容，推送对应的 `v<version>` 标签。README 的安装地址固定为 `https://github.com/KtKID/dsh-workbuddy/releases/latest/download/dsh-workbuddy.tgz`，GitHub 将其转到最新正式 Release 的同名资源。

GitHub Actions 的 `Check and Release` 工作流在每次 push 和 pull request 时执行构建、类型、格式、测试与打包，并保存 `.tgz` 和 `SHA256SUMS`。推送 `v<version>` 标签时，先核对标签与包版本一致，再执行这些检查；检查成功后自动创建同名 GitHub Release，附上预构建安装包、校验值和提交记录。发布权限限定在 Release job。

每个 Release 同时提供 `dsh-workbuddy-<version>.tgz` 和 `dsh-workbuddy.tgz`，两者内容相同；前者用于固定版本，后者供最新版安装地址使用。`SHA256SUMS` 包含这两个文件的校验值。

在 [Actions](https://github.com/KtKID/dsh-workbuddy/actions) 核对标签运行结果，在 [Releases](https://github.com/KtKID/dsh-workbuddy/releases) 核对安装包及校验值。版本、构建或测试检查失败时，修复对应诊断后重新执行；发布失败时，先核对该标签的 Release 状态，再重试发布 job。真实 DSH、WorkBuddy 和 Node 的验证版本与覆盖范围集中在 [验证记录](verification.md)。

GitHub 的源码归档供开发使用；用户安装入口是 Release 的预构建 `.tgz`。这种分发方式符合 DSH 官方的 tarball 安装流程。后续选择从 Git 直接安装时，需要自包含 `prepare` 构建，并按 DSH 文档处理 pnpm 的构建脚本授权及 commit 固定。
