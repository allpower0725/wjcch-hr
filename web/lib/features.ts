export type Role = "employee" | "department" | "executive" | "admin"

export const roleLabels: Record<Role, string> = {
  employee: "一般員工",
  department: "部級主管",
  executive: "院級主管",
  admin: "系統管理者",
}

export const rosterFeature = {
  slug: "roster", title: "班表編輯", description: "選擇排班單位與人員", icon: "calendar", group: "personal",
} as const

export const features = [
  { slug: "attendance", title: "我的打卡紀錄", description: "查看個人上下班的打卡時間", icon: "clock", group: "personal" },
  { slug: "schedule", title: "我的班表", description: "查看已生效的出勤安排", icon: "calendar", group: "personal" },
  rosterFeature,
  { slug: "requests", title: "我的申請", description: "查看補簽、請假與調班進度", icon: "clipboard", group: "personal" },
  { slug: "profile", title: "我的個人資料", description: "查看個人資料與證照資訊", icon: "user", group: "personal" },
  { slug: "unit-attendance", title: "單位出勤", description: "查詢授權範圍內的員工出勤", icon: "chart", group: "management" },
  { slug: "directory", title: "人員查詢", description: "查詢授權範圍內的人員資料", icon: "users", group: "management" },
  { slug: "line-management", title: "LINE 綁定管理", description: "管理員工的 LINE 綁定", icon: "link", group: "admin" },
] as const

export type Feature = (typeof features)[number]

export function featureForPath(path: string) {
  return features.find((feature) => path === `/${feature.slug}`)
}

export function canOpenFeature(role: Role, feature: Feature) {
  switch (feature.group) {
    case "personal": return true
    case "management": return role !== "employee"
    case "admin": return role === "admin"
  }
}
