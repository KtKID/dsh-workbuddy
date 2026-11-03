# 验证记录

## 2026-11-03 发布基线

| 检查                           | 状态                                                            |
| ------------------------------ | --------------------------------------------------------------- |
| 提取前真实对话                 | PASS：WorkBuddy DeepSeek-V4.1-Flash 回复指定文本，DSH 会话完成  |
| 提取前额度和目录查询           | PASS：详情页手动刷新成功，模型目录返回 38 项                    |
| 独立工程构建、类型、lint、格式 | PASS：build、check 退出 0，公开依赖的 peer 检查通过             |
| 独立工程协议与 Session 测试    | PASS：51 项通过、0 失败、0 跳过                                 |
| 发行包安装到隔离 DSH profile   | PASS：通过 dsh plugin 安装，dump-config 包含独立组合包和插件行  |
| 安装后的 Host / Client 入口    | PASS：Web 显示 WorkBuddy v0.1.0，组件运行中，详情和原创图标显示 |

真实对话的环境为 macOS、Node `v25.6.1`、DSH `0.2.2-alpha.2`、WorkBuddy `5.9.3` / CLI `2.165.0`。提取前专项测试 51 项通过。单次 credit 缺值，单次积分扣费金额保持未知。

独立发行验证使用合成凭据、本地 CLI 夹具和隔离数据目录，真实模型和额度查询沿用上面的实测记录。

隔离实例使用不存在的 Electron 和登录文件路径，详情页按预期显示 `WORKBUDDY_AUTH_UNAVAILABLE`。本次发行安装和页面验收的真实 WorkBuddy 额度查询、模型调用均为 0。Host 和 Client 模块已实际激活；余额与真实模型链路使用提取前实测和独立夹具两部分证据。

DSH 的 profile 关闭了 peer 自动安装，pnpm 因而列出缺少 peer 的提示。安装后的运行时由 DSH 提供同一份依赖，隔离 Web 激活成功。独立工程的开发依赖全部来自 npm，`pnpm peers check` 通过。
