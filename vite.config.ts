import { defineConfig } from 'vite';

// GitHub Pages でサブパス配信されても動くよう相対パスでビルドする
export default defineConfig({
  base: './',
});
