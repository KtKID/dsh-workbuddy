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

更新版本及 README 的安装地址，提交通过验证的内容，创建对应的 `v<version>` 标签。将 `dist/dsh-workbuddy-<version>.tgz` 附到同名 GitHub Release，记录验证过的 DSH、WorkBuddy 和 Node 版本。

GitHub 的源码归档供开发使用；用户安装入口是 Release 的预构建 `.tgz`。这种分发方式符合 DSH 官方的 tarball 安装流程。后续选择从 Git 直接安装时，需要自包含 `prepare` 构建，并按 DSH 文档处理 pnpm 的构建脚本授权及 commit 固定。
