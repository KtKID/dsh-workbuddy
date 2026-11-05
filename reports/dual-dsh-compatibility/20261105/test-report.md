# 双版本 DSH 兼容测试报告

任务：[同一安装包兼容两套 DSH](../../../docs/task/task-dual-dsh-compatibility.md)。比较基线：`d400037cef029795e819fb897fc31a4651ba4177`；产品源码沿用基线，兼容验证与交付文件见本任务④。批次：20261105。状态：本地验收通过，待 GitHub 发布。

## 本次结果

- 同一 `dsh-workbuddy@0.2.1` 安装包在 DSH `0.2.1-rc.2` 与 `0.2.2-alpha.2` 下各通过 70 项回归、0 失败、0 跳过，并各通过类型检查。
- 本地构建、严格类型、ESLint 和格式检查通过。官方旧版桌面已安装并运行统一版本，余额和 39 个模型读取成功；新版官方 CLI 隔离安装及组合层配置核对通过。
- 已取得旧包缺少旧版支持的有效红灯。实际 GitHub 发布及兼容矩阵运行在推送后记录；工作流配置已核对为等待两套兼容检查后发布。
- V8 改动行映射命中 131/131，相关分支 18/19；下述采集关闭路径保留量化缺口。既有项目未设置覆盖率阈值。
- 对话、工具、审批、持久化与用量采用实际 DSH 服务和本地 ACP Agent；WorkBuddy 远端登录余额与模型目录在官方旧版桌面实测。本轮 agent 额外真实模型请求为 0 次。

两个宿主均加载以下同一归档：`SHA256: ed76d228071d2e5a8e2144c14be05faa5c818b0f91a09f4372604727170f4ff9`。后续说明文档的同步只影响包内文档，发布工作流会再次对最终构建的同一归档执行矩阵。

## 修改及覆盖率

采用 Node 24.14.0 原生 V8 覆盖数据，v8-to-istanbul 9.3.0 映射到原始 `.mjs` 行；本批测试合计。新脚本按全文纳入，测试装配按 Git 比较基线新增行取交集；原始数据及精确缺口见 `evidence/coverage-summary.json`。配置、文档和生成锁文件为 0 个 JS 可执行行，通过包范围探针、格式检查和实际安装核对。

| 修改文件                                                            | 改动行命中               | 相关分支命中 | 缺口                                                                 |
| ------------------------------------------------------------------- | ------------------------ | ------------ | -------------------------------------------------------------------- |
| scripts/verify-compatibility.mjs                                    | 125/125                  | 14/15        | 第 121 行覆盖环境关闭分支，本地采集保持开启；CI 正常运行采用关闭路径 |
| test/support/session-runtime.mjs                                    | 6/6                      | 4/4          | 两套执行器选择与回归路径均命中                                       |
| package.json、两套锁文件、workflow、README、docs、报告及 .gitignore | 不适用：0 个 JS 可执行行 | 不适用       | 版本范围、冻结安装、工作流依赖、格式和实际安装分别核对               |

脚本行数为 V8 / Istanbul 可定位的行映射计数，分支统计限与本次改动行相交的可定位范围。运行时文件系统或外部进程异常的完整故障注入属于本批边界，失败会以原始退出状态和隔离目录定位。

## 专项与人工用例

| 用例 | 实际准备与操作                                              | 预期及实际结果                                            | 依据与证据                          |
| ---- | ----------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------- |
| T1   | Node 24，旧版冻结依赖，加载归档 lib 并运行类型与现有测试    | 版本和 peer 通过，70/70 通过                              | D1、D2；E04                         |
| T2   | 同一归档，新版冻结依赖，加载包内 lib                        | 版本和 peer 通过，70/70 通过，SHA256 与 T1 相同           | D1、D2；E05                         |
| T3   | 旧版内置执行器与新版独立执行器                              | 宿主工具、审批、取消、后续 step、用量和持久化回归通过     | D2；E04、E05，逐例见下表            |
| T4   | 官方桌面卸载可恢复旧本地包并安装统一版本                    | WorkBuddy v0.2.1 开启，1 组件运行，余额和 39 模型读取成功 | D1；E09 桌面观察及 profile 版本核对 |
| T5   | 工作流构建一次并由两套矩阵消费该产物，发布等待所有检查      | 配置核对通过；实际远端运行待推送                          | D3；E08，后续远端记录               |
| VT1  | 检查包清单和 workflow，并以未列入的 0.2.2-rc.1 调用兼容脚本 | 两套目标均接受，其他目标在安装前拒绝，release 依赖完整    | E08；技术验收增量                   |

## 沿用回归逐例

下表两列结果分别来自 E04 与 E05 的逐例输出，70 个既有用例在两组依赖下各执行一次。测试位置关联与逐行覆盖分别核对，替身仅限 WorkBuddy 外部 CLI / HTTP；真实 DSH 会话、工具审批、用量与持久化保留执行。

| 用例 | 名称                                                            | 0.2.1-rc.2 | 0.2.2-alpha.2 | 原定义                                                         |
| ---- | --------------------------------------------------------------- | ---------- | ------------- | -------------------------------------------------------------- |
| R01  | WB ACP 通知用量进入真实 KMH Session 并沿用助手消息持久化        | 通过       | 通过          | [acp-session.test.mjs](../../../test/acp-session.test.mjs#L49) |
| R02  | ACP 拒绝审批后 WB 取消整轮，KMH 保存正式取消状态                | 通过       | 通过          | [acp-session.test.mjs](../../../test/acp-session.test.mjs#L81) |
| R03  | ACP 原生审批 → 真实 KMH Session：allow                          | 通过       | 通过          | test/                                                          |
| R04  | ACP 原生审批 → 真实 KMH Session：deny                           | 通过       | 通过          | test/                                                          |
| R05  | ACP 原生审批 → 真实 KMH Session：never                          | 通过       | 通过          | test/                                                          |
| R06  | ACP 原生审批 → 真实 KMH Session：unavailable                    | 通过       | 通过          | test/                                                          |
| R07  | ACP 原生审批 → 真实 KMH Session：throwing                       | 通过       | 通过          | test/                                                          |
| R08  | ACP + MCP → KMH 工具 → 下一步续跑：allow                        | 通过       | 通过          | test/                                                          |
| R09  | ACP + MCP → KMH 工具 → 下一步续跑：guard-deny                   | 通过       | 通过          | test/                                                          |
| R10  | ACP + MCP → KMH 工具 → 下一步续跑：approval-allow               | 通过       | 通过          | test/                                                          |
| R11  | ACP + MCP → KMH 工具 → 下一步续跑：approval-deny                | 通过       | 通过          | test/                                                          |
| R12  | ACP + MCP → KMH 工具 → 下一步续跑：mcp-offline                  | 通过       | 通过          | test/                                                          |
| R13  | WB 实际双格式用量：两次模型调用完整汇总且相同调用去重           | 通过       | 通过          | [acp-usage.test.mjs](../../../test/acp-usage.test.mjs#L34)     |
| R14  | WB 重复通知保持幂等，等值的独立模型调用分别计入                 | 通过       | 通过          | [acp-usage.test.mjs](../../../test/acp-usage.test.mjs#L40)     |
| R15  | WB 仅 raw 通知也可透传                                          | 通过       | 通过          | test/                                                          |
| R16  | WB 仅 normalized 通知也可透传                                   | 通过       | 通过          | test/                                                          |
| R17  | WB 同一调用更新快照只保留最新值，标准结束用量优先               | 通过       | 通过          | [acp-usage.test.mjs](../../../test/acp-usage.test.mjs#L77)     |
| R18  | WB 缓存读写和思考分别映射，cache miss 保持未缓存输入            | 通过       | 通过          | [acp-usage.test.mjs](../../../test/acp-usage.test.mjs#L109)    |
| R19  | 上下文占用、无效统计与子代理通知保持独立                        | 通过       | 通过          | [acp-usage.test.mjs](../../../test/acp-usage.test.mjs#L140)    |
| R20  | 官方 ACP 子进程透传 WB 通知，续聊排除历史用量回放               | 通过       | 通过          | [acp-usage.test.mjs](../../../test/acp-usage.test.mjs#L157)    |
| R21  | 官方 ACP：正文、思考、用量、会话和扩展通知完成往返              | 通过       | 通过          | [acp.test.mjs](../../../test/acp.test.mjs#L14)                 |
| R22  | 官方 ACP：slow 保留等待与完整输出                               | 通过       | 通过          | test/                                                          |
| R23  | 官方 ACP：large 保留等待与完整输出                              | 通过       | 通过          | test/                                                          |
| R24  | 官方 ACP：native-error 保留等待与完整输出                       | 通过       | 通过          | test/                                                          |
| R25  | 官方 ACP：结束原因 max_tokens                                   | 通过       | 通过          | test/                                                          |
| R26  | 官方 ACP：结束原因 max_turn_requests                            | 通过       | 通过          | test/                                                          |
| R27  | 官方 ACP：结束原因 refusal                                      | 通过       | 通过          | test/                                                          |
| R28  | 官方 ACP：结束原因 cancelled                                    | 通过       | 通过          | test/                                                          |
| R29  | 官方 MCP SDK：mcp 前缀、次数与声明校验                          | 通过       | 通过          | test/                                                          |
| R30  | 官方 MCP SDK：mcp-duplicate 前缀、次数与声明校验                | 通过       | 通过          | test/                                                          |
| R31  | 官方 MCP SDK：mcp-invalid 前缀、次数与声明校验                  | 通过       | 通过          | test/                                                          |
| R32  | 官方 ACP：续聊与历史恢复 {}                                     | 通过       | 通过          | test/                                                          |
| R33  | 官方 ACP：续聊与历史恢复 {"loadSession":false}                  | 通过       | 通过          | test/                                                          |
| R34  | 官方 ACP：续聊与历史恢复 {"loadFails":true}                     | 通过       | 通过          | test/                                                          |
| R35  | 官方 ACP：尾随运行上下文与原任务共同传入，旧绑定从 KMH 历史恢复 | 通过       | 通过          | [acp.test.mjs](../../../test/acp.test.mjs#L186)                |
| R36  | 官方 ACP：failure 明确失败并回收子进程                          | 通过       | 通过          | test/                                                          |
| R37  | 官方 ACP：crash 明确失败并回收子进程                            | 通过       | 通过          | test/                                                          |
| R38  | 官方 ACP：用户取消通知 WB 并回收子进程                          | 通过       | 通过          | [acp.test.mjs](../../../test/acp.test.mjs#L266)                |
| R39  | 官方 ACP：首段增量及时到达，读取者提前结束回收进程              | 通过       | 通过          | [acp.test.mjs](../../../test/acp.test.mjs#L287)                |
| R40  | 官方 ACP：撤回审批取消宿主等待，迟到批准保持无效                | 通过       | 通过          | [acp.test.mjs](../../../test/acp.test.mjs#L308)                |
| R41  | 官方 ACP：撤回审批可结束未响应取消的宿主回调                    | 通过       | 通过          | [acp.test.mjs](../../../test/acp.test.mjs#L335)                |
| R42  | 官方 ACP：允许一次保持为单次授权，永久授权选项保持未选中        | 通过       | 通过          | [acp.test.mjs](../../../test/acp.test.mjs#L354)                |
| R43  | 官方 ACP：literal 保持为内容或观察记录                          | 通过       | 通过          | test/                                                          |
| R44  | 官方 ACP：observed-kmh 保持为内容或观察记录                     | 通过       | 通过          | test/                                                          |
| R45  | 官方 ACP：KMH 结果回填同一会话，私有传输元数据保持在宿主        | 通过       | 通过          | [acp.test.mjs](../../../test/acp.test.mjs#L406)                |
| R46  | 目录采用真实返回并过滤停用和媒体项；余额可表示零，刷新合并      | 通过       | 通过          | [api.test.mjs](../../../test/api.test.mjs#L94)                 |
| R47  | 失败保留同账号旧快照；换账号失败清空旧余额且脱敏                | 通过       | 通过          | [api.test.mjs](../../../test/api.test.mjs#L119)                |
| R48  | T1 解密受保护登录并保持原文件数据                               | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L161)                |
| R49  | T2 过期或缺失的桌面登录给安全错误                               | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L185)                |
| R50  | T3a 真实 Cordis 注册模型路由并回收                              | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L200)                |
| R51  | T3b 单次 HTTP 携带登录凭据和完整文本历史                        | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L216)                |
| R52  | T4 分段 SSE 保留文本、推理、缓存用量和 credit                   | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L272)                |
| R53  | T5 401、非法和截断 SSE 分别返回失败                             | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L290)                |
| R54  | T6a 调用前取消与超时传播到 fetch                                | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L309)                |
| R55  | T5b 渠道校验拒绝保留独立错误码并脱敏                            | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L338)                |
| R56  | T6c 流中取消释放远端读取器                                      | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L355)                |
| R57  | T6b 多媒体输入明确报范围错误                                    | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L388)                |
| R58  | T8 安装版本变化随下次请求生效并遵循 CLI 版本回退                | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L406)                |
| R59  | T9 安装元数据异常在凭据读取与请求前结束                         | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L438)                |
| R60  | T10 HTTP 或渠道拒绝均只发起一次请求                             | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L484)                |
| R61  | T11 真实 hi 响应的空结束原因持续输出直到 stop                   | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L506)                |
| R62  | T12 未知结束原因与缺失最终结束事件继续报错                      | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L529)                |
| R63  | T13 远端目录决定可选模型并解析第二个模型                        | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L546)                |
| R64  | T14 请求与 SSE 响应关联到调用者 session 并排除凭据              | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L570)                |
| R65  | T15 工具声明和结果历史保持关联，分片工具调用交给 KMH            | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L600)                |
| R66  | T16 HTTP 错误体与请求关联保存，脱敏后保留业务码                 | 通过       | 通过          | [mvp.test.mjs](../../../test/mvp.test.mjs#L675)                |
| R67  | Linux 私有凭据文件可读取，客户端标识使用同一显式 CLI 的元数据   | 通过       | 通过          | [portable.test.mjs](../../../test/portable.test.mjs#L47)       |
| R68  | 过期、宽权限、损坏和超大凭据统一拒绝，诊断隐藏文件内容          | 通过       | 通过          | [portable.test.mjs](../../../test/portable.test.mjs#L56)       |
| R69  | 显式 CLI 路径通过官方 ACP SDK 执行，沿用模型与令牌输入          | 通过       | 通过          | [portable.test.mjs](../../../test/portable.test.mjs#L78)       |
| R70  | 正式 Session 保存用户、助手、用量和请求响应关联并可恢复         | 通过       | 通过          | [session.test.mjs](../../../test/session.test.mjs#L17)         |

## 执行与验收记录

| 执行 | 工作目录和命令 / 操作                                     | 退出码与观察                                     | 原始来源                              |
| ---- | --------------------------------------------------------- | ------------------------------------------------ | ------------------------------------- |
| E01  | 独立仓库，旧 0.2.0 归档传入兼容脚本                       | 1；精确诊断旧版本范围缺少 0.2.1-rc.2             | evidence/E01-red.log                  |
| E02  | 独立仓库，pnpm check                                      | 0；类型、lint、格式通过                          | evidence/E02-check.log                |
| E03  | 独立仓库，pnpm pack --pack-destination dist               | 0；生成 0.2.1 归档                               | evidence/E03-pack.log                 |
| E04  | 隔离目录，固定旧版依赖、typecheck、70 项回归              | 0；70 通过                                       | evidence/E04-compat.log，coverage/E04 |
| E05  | 隔离目录，同归档及新版依赖                                | 0；70 通过                                       | evidence/E05-compat.log，coverage/E05 |
| E06  | 新的 DSH_HOME，官方 0.2.2-alpha.2 CLI plugin add 本地归档 | 0；安装包及组合层登记成功                        | evidence/E06-newer-install.log        |
| E07  | 新版隔离 profile，--dump-config                           | 0；包含 dsh-workbuddy 层、workbuddy 行及正确包名 | evidence/E07-newer-config.log         |
| E08  | 独立仓库，设计范围与 workflow 探针、脚本语法              | 0；D1–D3 通过，未列入目标拒绝                    | evidence/E08-tech.log                 |
| E09  | 官方 0.2.1-rc.2 桌面 CUA 安装、详情页及 profile 清单      | 通过；统一版本、1 组件运行、余额与 39 模型成功   | evidence/E09-desktop.json             |

技术验收：D1–D3、R1–R7 的本次适用项通过。R3 跨语言同步不适用，原因是本次为单语言的包元数据、测试与 CI 流程；产品协议和数据归属沿用原实现。模块审查覆盖公开包导入、测试独立目录、包清单的 Zod 校验、冻结锁文件、具名版本选择及错误退出传播。E08 为本轮独立执行增量，回归与原始覆盖数据同时复查。

交付对账：T1–T4、VT1、基线、功能定义、用例映射与覆盖率证据闭合；T5 的实际发布回执在远端完成后记录。该对账复用现有执行记录。

## 附件与边界

本地原始输出、结果 JSON、覆盖率和桌面观察集中在 `evidence/`，由 .gitignore 保留为本机证据；公开远端检查入口为 [Check and Release](https://github.com/KtKID/dsh-workbuddy/actions/workflows/check.yml)。完整源码比较基线可由 Git 恢复，包版本及 SHA256 对应 E04 / E05 的实际输入。

当前覆盖边界为两套明确 DSH 版本。其他 DSH / Cordis 版本及额外真实模型对话在纳入矩阵或实际验收后记录。
