# 使用与维护

## 配置字段

| 字段           | 默认值                                                                                     | 作用                                                                      |
| -------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `transport`    | `cli`                                                                                      | 使用本机官方 CLI；`direct` 为历史直连诊断模式，其既有实测记录包含渠道拒绝 |
| `model`        | `deepseek-v4-flash`                                                                        | 适配器独立使用时的模型默认值；聊天使用 DSH 选中的模型                     |
| `timeoutMs`    | `60000`                                                                                    | 账号查询和 direct 请求的超时毫秒数                                        |
| `maxTokens`    | `512`                                                                                      | 适配器声明的默认值；直连模式发送该限制，官方 CLI 模型参数由 CLI 自身管理  |
| `electronPath` | `/Applications/WorkBuddy.app/Contents/MacOS/Electron`                                      | 本机 WorkBuddy Electron；CLI 位置根据应用目录推导                         |
| `authFile`     | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` | 当前桌面登录文件                                                          |
| `traceDir`     | `$DSH_HOME/workbuddy/transport`，DSH_HOME 空时为 `~/.dsh/workbuddy/transport`              | 本插件的传输诊断目录                                                      |

`cliPath` 与 `credentialsFile` 为独立包的可选绝对路径配置。前者选择官方 CLI 的 `dist/codebuddy-lite-wb.mjs`，后者直接读取本人私有登录文件；配置 `credentialsFile` 时使用该文件，其他情况使用桌面 Electron 读取登录态。CLI 目录应包含配套的 `product.json`、`package.json` 和运行依赖，以便执行与客户端版本标识保持一致。

私有凭据文件采用插件 `CredentialsSchema` 定义的 JSON，归当前运行用户所有，权限仅限本人，大小最多 64 KB，expiresAt 使用尚未到期的毫秒时间戳。无效、过期、宽权限和符号链接文件按认证失败处理。`dsh-workbuddy-export` 脚本提供 `--dest` 新目标目录以及可选的 `--electron`、`--auth` 源路径，将当前桌面登录与配套 CLI 导出到本人部署使用的私有目录；目录中的 credentials.json 按私有数据保存。凭据到期后在桌面端确认登录并重新导出。

图片和文件输入返回范围错误。CLI 保留自身系统协议，DSH 的系统上下文和历史作为任务材料传入。历史、模型、工具及账号关联一致时续接原生会话，编辑历史后重新构建会话。

## 工具和会话

官方 `@agentclientprotocol/sdk` 随插件安装，在 DSH 进程内创建 ACP Client；独立 WB CLI 以 `--serve --acp --acp-transport stdio` 提供 ACP Server。SDK 负责协议编解码、类型、校验、请求关联和取消。插件负责宿主会话绑定、消息投影、工具交接和审批服务接入。

WorkBuddy 原生 `Read`、`Bash`、`Write` 等工具由 WB 执行，保持 `--tools default`。宿主工具通过官方 MCP SDK 的回环 HTTP 服务提供，声明名为 `kmh-<原名>`；接收端按本轮声明校验并移除一个前缀，交给 DSH 的原始工具。WB 支持的 `transparent_proxy: true`、`builtin_tools` 和 `--allowedTools` 保持同一组名称。

MCP 调用收到 `KMH_TOOL_TRANSFERRED` 回执后结束当前响应，由 DSH 审批、执行，再把真实结果交给下一步。MCP SDK 回调是宿主工具转交的唯一来源；ACP 原生工具通知保存到元数据。

每次启动 WorkBuddy CLI 时，插件读取当前 DSH 会话的有效沙箱和审批策略。`danger-full-access` 与 `never` 同时生效时使用 WorkBuddy 的 `bypassPermissions`，其余组合使用 `default`。权限切换从下一次 CLI 请求起生效。CLI 模式变化时，插件从 DSH 历史重建原生会话。

WorkBuddy 仍要求审批的操作通过 ACP `session/request_permission` 进入宿主审批界面，展示工具名、参数、路径和扩展信息。批准一次或拒绝时，按本次请求的选项种类选择并回传原始 optionId。仅提供永久批准的请求保持取消。审批服务缺失、策略为 `never` 或异常时按拒绝处理。官方撤回、会话取消和进程退出使待决审批与迟到批准失效。WB 在审批拒绝后返回取消整轮时，插件保存已停止状态并保留后续排队消息。

CLI 使用 `--max-turns 99`；每次 prompt 持续等待 ACP 的正式响应，支持长时间静默与超过 16 MB 的输出。用户取消时发送 ACP 取消通知，回收本次子进程组并关闭工具桥。凭据读取保留独立的 10 秒时限。

历史摘要和 ACP 绑定一致时加载同一原生会话，新增工具结果和用户上下文以增量材料回填，保留 WB 原生任务状态；旧传输绑定、历史变化、模型或工具变化、加载失败时从 DSH 历史重建。加载回放保持在原生上下文内，本轮正文消费当前 prompt 的通知。

用量从官方 SDK 接收的 ACP `usage_update._meta.usage` 转换为宿主用量流，按 WB 模型请求标识合并同次调用的重复通知并汇总当前 prompt 的实际调用。正式 `PromptResponse.usage` 存在时采用该统计。输入分为未缓存输入、缓存读取和缓存写入，思考为输出的分项；显示与持久化统一沿用宿主的助手消息与用量面板，缺失字段保持未知。账号积分继续通过余额 API 获取。验证入口为 `test/acp.test.mjs`、`test/acp-usage.test.mjs`、`test/acp-session.test.mjs`，官方 SDK Agent 夹具覆盖真实 WB 字段形状与 Session 持久化。

官方文档：[ACP SDK](https://agentclientprotocol.com/libraries/typescript)、[WB 底层 CLI ACP](https://www.codebuddy.cn/docs/cli/acp)。

## 登录与数据

首次关联、切换账号和重新登录的步骤见 [关联 WorkBuddy 账号](../README.md#关联-workbuddy-账号)。

凭据读取适配 WorkBuddy 的桌面保护格式，使用应用自带 Electron 只读解密登录文件，凭据读取保留独立的 10 秒时限。模型认证通过子进程环境传递给官方 CLI。插件在数据目录的 `workbuddy/web-login.json` 私有保存网页登录凭据及当前方式。账号查询按选用方式访问固定的地区服务。网页登录使用 `cli` 传输。

DSH 的 Session 保存会话和原生请求关联。插件的 `traceDir` 按会话 ID 的 SHA-256 文件名保存 JSONL；新建目录权限 `0700`、新建文件权限 `0600`，当前 token 和账号 UID 在写入前替换。诊断包含对话、工具声明和模型输出，适用本机私有数据的管理方式；保留期限和清理由部署者负责。官方 CLI 的自身运行记录由 WorkBuddy 管理。

## 常见错误

| 错误                                | 处理                                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| `WORKBUDDY_AUTH_UNAVAILABLE`        | 在插件详情页确认当前方式并恢复对应的 WorkBuddy 登录        |
| `WORKBUDDY_ACCOUNT_QUERY_FAILED`    | 检查官方服务连通性；详情页的更新时间和错误提示说明快照状态 |
| `WORKBUDDY_CLIENT_INFO_UNAVAILABLE` | 核对 WorkBuddy 安装完整性及 `electronPath`                 |
| `WORKBUDDY_CHANNEL_REJECTED`        | 结束本次调用，核对 WorkBuddy 版本及传输配置，保留错误记录  |
| `WORKBUDDY_ACP_FAILED`              | 根据传输记录核对官方 SDK、WB 版本、认证及 prompt 返回错误  |

DSH 版本兼容检查失败时，安装包声明的 `engines.dsh` 和当前运行版本应对应。支持范围与验证入口见 [DSH 版本兼容](compatibility.md)。

## 更新和卸载

更新时从 Releases 获取新版本安装包，按 DSH 第三方插件流程卸载后重新安装，随后应用安装器提示的重启。卸载使用插件页的卸载操作，或 `dsh plugin --profile web remove dsh-workbuddy`。会话及插件诊断数据继续由 DSH 和本机部署者管理。
