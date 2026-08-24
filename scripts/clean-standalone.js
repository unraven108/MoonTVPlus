// Windows + pnpm 下，Next.js 在清理 .next/standalone 产物时会顺着目录 symlink/junction
// 误删真实 node_modules 里的包内容（官方修复见 next 15.4+ PR #82191）。
// 在 dev / build 前主动删除 .next/standalone，避免触发 Next 的破坏性清理。
const fs = require('fs');
const path = require('path');

const standaloneDir = path.join(process.cwd(), '.next', 'standalone');

if (fs.existsSync(standaloneDir)) {
  fs.rmSync(standaloneDir, { recursive: true, force: true });
  console.log('[clean-standalone] removed .next/standalone');
}
