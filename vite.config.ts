import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// 画面に出す最終更新日時（ビルドした時刻、日本時間）とコミット
function buildInfo(): string {
  const time = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());
  let commit = '';
  try {
    commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    // git が無い環境でもビルドできるようにする
  }
  return commit ? `${time}（${commit}）` : time;
}

// GitHub Pages でサブパス配信されても動くよう相対パスでビルドする
export default defineConfig({
  base: './',
  define: {
    __BUILD_INFO__: JSON.stringify(buildInfo()),
  },
});
