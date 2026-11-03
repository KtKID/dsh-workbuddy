# 使用与维护

## 配置字段

| 字段           | 默认值                                                                                     | 作用                                                                      |
| -------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `transport`    | `cli`                                                                                      | 使用本机官方 CLI；`direct` 为历史直连诊断模式，其既有实测记录包含渠道拒绝 |
| `model`        | `deepseek-v4-flash`                                                                        | 适配器独立使用时的模型默认值；聊天使用 DSH 选中的模型                     |
| `timeoutMs`    | `60000`                                                                                    | 单次 CLI 请求或账号查询的超时毫秒数                                       |
| `maxTokens`    | `512`                                                                                      | 适配器声明的默认值；直连模式发送该限制，官方 CLI 模型参数由 CLI 自身管理  |
| `electronPath` | `/Applications/WorkBuddy.app/Contents/MacOS/Electron`                                      | 本机 WorkBuddy Electron；CLI 位置根据应用目录推导                         |
| `authFile`     | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` | 当前桌面登录文件                                                          |
| `traceDir`     | `$DSH_HOME/workbuddy/transport`，DSH_HOME 空时为 `~/.dsh/workbuddy/transport`              | 本插件的传输诊断目录                                                      |

图片和文件输入返回范围错误。CLI 保留自身系统协议，DSH 的系统上下文和历史作为任务材料传入。历史、模型、工具及账号关联一致时续接原生会话，编辑历史后重新构建会话。

## 工具和会话

DSH 负责用户消息、工具审批与执行、助手消息和轮次持久化。插件通过带单次随机凭据的回环 MCP 桥接转交工具请求，原生工具关闭。工具执行结果由 DSH 回传，完整 DSML 调用也会经过声明工具白名单、参数校验与宿主审批。

取消和超时会终止该请求的 CLI 子进程组并关闭桥接。协议事件损坏、未声明工具和参数异常返回明确错误。错误码保留 `WORKBUDDY_*` 命名，便于查找诊断记录。

## 登录与数据

首次关联、切换账号和重新登录的步骤见 [关联 WorkBuddy 账号](../README.md#关联-workbuddy-账号)。

凭据读取适配 WorkBuddy 的桌面保护格式，使用应用自带 Electron 只读解密登录文件。模型认证通过子进程环境传递给官方 CLI；账号查询仅向固定的 `https://www.workbuddy.cn` 来源发送认证信息。

DSH 的 Session 保存会话和原生请求关联。插件的 `traceDir` 按会话 ID 的 SHA-256 文件名保存 JSONL；新建目录权限 `0700`、新建文件权限 `0600`，当前 token 和账号 UID 在写入前替换。诊断包含对话、工具声明和模型输出，适用本机私有数据的管理方式；保留期限和清理由部署者负责。官方 CLI 的自身运行记录由 WorkBuddy 管理。

## 常见错误

| 错误                                                      | 处理                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `WORKBUDDY_AUTH_UNAVAILABLE`                              | 在本机 WorkBuddy 桌面版确认登录有效，再重试原操作          |
| `WORKBUDDY_ACCOUNT_QUERY_FAILED`                          | 检查官方服务连通性；详情页的更新时间和错误提示说明快照状态 |
| `WORKBUDDY_CLIENT_INFO_UNAVAILABLE`                       | 核对 WorkBuddy 安装完整性及 `electronPath`                 |
| `WORKBUDDY_CHANNEL_REJECTED`                              | 结束本次调用，核对 WorkBuddy 版本及传输配置，保留错误记录  |
| `WORKBUDDY_CLI_PROTOCOL` / `WORKBUDDY_CLI_INVALID_OUTPUT` | CLI 协议发生变化时按传输诊断更新 schema 和回放夹具         |
| `WORKBUDDY_CLI_TIMEOUT`                                   | 核对模型响应耗时和当前超时配置                             |

DSH 版本兼容检查失败时，安装包声明的 `engines.dsh` 和当前运行版本应对应。当前发布基线为 `0.2.2-alpha.2`，后续兼容版本随验证结果更新。

## 更新和卸载

更新时从 Releases 获取新版本安装包，按 DSH 第三方插件流程卸载后重新安装，随后应用安装器提示的重启。卸载使用插件页的卸载操作，或 `dsh plugin --profile web remove dsh-workbuddy`。会话及插件诊断数据继续由 DSH 和本机部署者管理。
