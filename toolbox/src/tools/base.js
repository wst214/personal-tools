// 描边风 SVG 图标辅助（24x24，currentColor 取色）
export const svg = (content) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">${content}</g></svg>`;

// 工具对象约定：
// {
//   id: string            唯一标识
//   title: string         侧边栏名称
//   icon: string          svg() 返回的字符串
//   render(container): void   渲染到主区
//   onLeave?(): void           离开时清理（可选）
// }
