// 当前登录身份（角色）：由 App 在 /auth/status 解析后写入，Settings 等页面挂载时读取。
// 角色只在登录门处变化（登录/401 掉线），页面级 mount 时读取足够，不需要响应式 context。
let currentRole: string | null = null;

export function getRole(): string | null {
  return currentRole;
}

export function setRole(role: string | null): void {
  currentRole = role;
}

export const ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  operator: '操作员',
  viewer: '只读',
};
