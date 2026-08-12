export const personalChildMessages = {
  "personal.children.label": "Child sessions",
  "personal.children.title": "Agents",
  "personal.children.return": "Return to conversation",
  "personal.children.loading": "Loading agents...",
  "personal.children.error": "Agents could not be loaded.",
  "personal.children.empty": "No active agents.",
} as const

type PersonalChildMessages = Record<keyof typeof personalChildMessages, string>

export const personalChildMessagesZh: PersonalChildMessages = {
  "personal.children.label": "子会话",
  "personal.children.title": "智能体",
  "personal.children.return": "返回对话",
  "personal.children.loading": "正在加载智能体...",
  "personal.children.error": "无法加载智能体。",
  "personal.children.empty": "当前没有活动中的智能体。",
}

export const personalChildMessagesZht: PersonalChildMessages = {
  "personal.children.label": "子工作階段",
  "personal.children.title": "代理程式",
  "personal.children.return": "返回對話",
  "personal.children.loading": "正在載入代理程式...",
  "personal.children.error": "無法載入代理程式。",
  "personal.children.empty": "目前沒有執行中的代理程式。",
}
