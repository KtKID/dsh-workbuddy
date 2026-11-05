# DSH 版本兼容

同一份 WorkBuddy 安装包支持以下两套 DSH。表中的实际安装记录来自插件 `v0.2.1`。

| DSH             | Cordis          | 自动回归              | 实际安装                                     |
| --------------- | --------------- | --------------------- | -------------------------------------------- |
| `0.2.1-rc.2`    | `4.0.5`         | 同一安装包 70/70 通过 | 官方桌面版组件运行，余额与 39 个模型读取成功 |
| `0.2.2-alpha.2` | `4.0.6-alpha.1` | 同一安装包 70/70 通过 | 官方 CLI 隔离安装、组合层和插件配置核对通过  |

`package.json` 的 `engines.dsh` 和 DSH peer 依赖共同声明支持范围。安装包由发布构建生成一次，两套兼容测试分别加载该包的同一份 Host / Client 产物，并执行源码类型检查和现有协议、审批、会话及用量回归。各套宿主提供自己版本的 DSH 服务。

兼容检查按明确版本运行，验证记录随检查结果维护。其他 DSH 版本的兼容性在纳入该矩阵后确认。插件使用同一系统用户的 WorkBuddy 登录态，账号和模型权限由 WorkBuddy 服务端决定。

开发者在构建并打包后执行：

```sh
WORKBUDDY_VERSION="$(node -p 'require("./package.json").version')"
node scripts/verify-compatibility.mjs 0.2.1-rc.2 "dist/dsh-workbuddy-${WORKBUDDY_VERSION}.tgz"
node scripts/verify-compatibility.mjs 0.2.2-alpha.2 "dist/dsh-workbuddy-${WORKBUDDY_VERSION}.tgz"
```

脚本创建隔离目录，按固定锁文件安装目标 DSH 依赖，加载安装包中的构建产物，并使用合成登录与本地 ACP Agent 执行回归。执行输出记录临时目录路径。通过后脚本清理目录，失败时保留目录供排查。

## 变更记录

| 日期       | 类型 | 变化                         | 状态与记录                                                                                                                                                       |
| ---------- | ---- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-05 | 修改 | 单一安装包覆盖两套已验证 DSH | [双版本兼容任务](https://github.com/KtKID/dsh-workbuddy/blob/b9632e03ef1cae2ce9c8c81d7571f085dbc46d13/docs/task/task-dual-dsh-compatibility.md)，已发布 `v0.2.1` |
