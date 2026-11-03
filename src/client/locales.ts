/** WorkBuddy 详情页的中英文文案；缺少其他语言时由宿主回退到英文。 */
export const en = {
  summary: "Use models and credits from your WorkBuddy account",
  credits: "Available credits",
  loading: "Loading",
  pending: "Account information pending",
  models: "Available chat models:",
  refresh: "Refresh credits and models",
  refreshing: "Refreshing",
  updatedAt: "Updated at",
  queryFailed:
    "Reading failed. Confirm that WorkBuddy is signed in, then retry",
  previousResult: "; showing the last successful result",
  modelList: "View models",
};
export type WorkBuddyLocaleKey = keyof typeof en;
export const zh: Record<WorkBuddyLocaleKey, string> = {
  summary: "使用 WorkBuddy 当前账号的模型与积分",
  credits: "可用积分",
  loading: "正在读取",
  pending: "账号信息待查询",
  models: "可用对话模型：",
  refresh: "刷新余额和模型",
  refreshing: "正在刷新",
  updatedAt: "更新于",
  queryFailed: "读取失败，请确认 WorkBuddy 已登录后重试",
  previousResult: "；当前展示上次成功结果",
  modelList: "查看模型列表",
};
