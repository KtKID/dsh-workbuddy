# dsh-workbuddy

在 **DeepSeek Harness（DSH）** 中使用 WorkBuddy 桌面账号的模型与积分。聊天、上下文、工具审批和执行由 DSH 管理，模型请求通过本机 WorkBuddy 官方 CLI 完成。

- 在模型选择器中选择 `workbuddy` 分组，查看官方返回的积分倍率。
- 在插件详情查看总积分、分类余额、更新时间和模型目录。
- 支持流式文本、思考、工具调用、续聊以及请求诊断记录。

## 安装前准备

| 项目       | 当前要求                                                 |
| ---------- | -------------------------------------------------------- |
| 运行位置   | 安装 DSH 的同一台 Mac                                    |
| WorkBuddy  | 安装在 `/Applications/WorkBuddy.app`，并在桌面版完成登录 |
| DSH        | `0.2.2-alpha.2`                                          |
| Node.js    | `>=24.9.0`；使用命令行安装时需要可运行的 `dsh` 和 pnpm   |
| 已验证版本 | WorkBuddy `5.9.3`，内置 CLI `2.165.0`                    |

当前包声明支持 macOS。WorkBuddy 凭据保护格式和 CLI 协议随其版本变化，升级后的兼容性以具体版本的验证记录为准。

## 安装

### DSH 界面安装

1. 打开 DSH 的「插件」→「添加插件」。
2. 填入下面的预构建安装包地址，完成安装并选择「立即启用」。
3. 按下面的「关联 WorkBuddy 账号」确认登录，再选择模型。

```text
https://github.com/KtKID/dsh-workbuddy/releases/download/v0.2.0/dsh-workbuddy-0.2.0.tgz
```

Release 安装包包含已构建的 `lib/`、界面模块和组合包配置，安装时可直接加载。包内的 DSH 依赖由当前宿主提供，`zod` 由包管理器安装。

### 命令行安装到 Web profile

```sh
dsh plugin --profile web add https://github.com/KtKID/dsh-workbuddy/releases/download/v0.2.0/dsh-workbuddy-0.2.0.tgz
dsh --profile web --dump-config
dsh web
```

`--dump-config` 的输出应包含 `dsh-workbuddy` 层及 `workbuddy` 插件行。对已经运行的实例，按 DSH 的安装结果提示应用变更或重新启动。其他 profile 将命令中的 `web` 替换为目标 profile 名称；Desktop 用户使用界面安装。

网络下载受限时，从 [Releases](https://github.com/KtKID/dsh-workbuddy/releases) 下载同一文件，再用绝对路径安装：

```sh
dsh plugin --profile web add /absolute/path/dsh-workbuddy-0.2.0.tgz
```

### 从源码开发

```sh
git clone https://github.com/KtKID/dsh-workbuddy.git
cd dsh-workbuddy
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
pnpm pack --pack-destination dist
```

构建依赖均从公开 npm 源获取。开发安装使用构建后的本地绝对目录，`dsh plugin --profile web add /absolute/path/dsh-workbuddy`。GitHub 仓库保存 TypeScript 源码，普通安装使用上面的 Release `.tgz`。

## 关联 WorkBuddy 账号

插件直接沿用 **WorkBuddy 桌面版当前登录的账号**。账号由运行 DSH 的这台 Mac、这个系统用户的本地登录态决定；插件会读取该登录态，并交给 WorkBuddy 官方 CLI 发起模型请求。

1. 打开 `/Applications/WorkBuddy.app`，完成登录，确认桌面版当前使用的是你准备接入的 WorkBuddy 账号。
2. 用同一个 macOS 系统用户启动 DSH，并安装、启用本插件。
3. 打开 DSH「插件」→ **WorkBuddy** 详情页。总积分、模型数量和更新时间正常显示，就说明插件已读到有效登录态并成功查询该账号。有正确结果时直接使用；登录后页面仍显示错误时，点击一次「刷新余额和模型」。
4. 新建聊天，在模型选择器的 **workbuddy** 分组中选择模型，发送一条简短消息。收到回复后，即可在 DSH 中使用这个 WorkBuddy 账号对话；用量与积分归该账号，实际消耗以 WorkBuddy 官方记录为准。

### 切换账号或登录失效

在 WorkBuddy 桌面版退出原账号、登录目标账号，再回到插件详情页点击一次「刷新余额和模型」。插件会重新读取本地登录态，并按账号隔离余额和模型缓存。出现 `WORKBUDDY_AUTH_UNAVAILABLE` 时，先在桌面版重新完成登录，再刷新一次。

自定义安装位置、登录文件路径及凭据读取方式见 [使用与维护](docs/usage.md#登录与数据)。

## 查看额度与选择模型

打开「插件」中的 **WorkBuddy** 详情页，查看可用积分、套餐分类和模型目录。余额成功结果缓存五分钟；需要最新值时点击一次「刷新余额和模型」。查询失败时页面显示错误，并保留同账号上次成功的结果；账号切换后重新查询。

模型名称后的 `×0.11` 等数字是 WorkBuddy 返回的积分倍率。可用模型、调用权限和实际积分消耗由 WorkBuddy 服务端决定。CLI 提供单次 `credit` 时插件记录该值；缺值保留为未知，实际扣费以官方账单为准。聊天会话的自动标题生成也可能单独请求模型。

## 配置

用户配置写在目标 profile 的 `cordis.patch.yml` 中，行 id 为 `workbuddy`。按需设置以下字段，其他值使用默认配置：

```yaml
- id: workbuddy
  name: dsh-workbuddy
  config:
    transport: cli
    timeoutMs: 60000
    electronPath: /Applications/WorkBuddy.app/Contents/MacOS/Electron
```

完整配置、数据保存位置和故障处理见 [使用与维护](docs/usage.md)。

## 验证与维护

2026-11-04，官方 ACP 传输、原生与宿主工具、审批、跨步状态、用量和取消已在 60000 实际页面验收。独立包 70 项测试通过；实际页面、自动测试与平台覆盖范围见 [验证记录](docs/verification.md)。

插件源自 [Kongming OS](https://github.com/KtKID/kongming-os) 的 `packages/kmh-workbuddy`，初始导入基线为提交 `7de7687a9053168278283b2b54226a3a637c6e72`。独立包使用官方 ACP SDK，保留第三方组合包的详情页、安装配置与可选的 CLI 路径和私有凭据接入。维护问题提交到 [Issues](https://github.com/KtKID/dsh-workbuddy/issues)。

发布流程与 DSH 官方打包规则见 [发布说明](docs/releasing.md)。
