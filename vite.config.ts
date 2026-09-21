import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createUserscriptMeta } from './userscript.meta.ts';

const versionFile = fileURLToPath(new URL('./version.ts', import.meta.url));

function readVersion(): string {
  const source = readFileSync(versionFile, 'utf-8');
  const match = source.match(/VERSION\s*=\s*['\"]([^'\"]+)['\"]/);
  if (!match?.[1]) throw new Error('无法从 version.ts 读取版本号');
  return match[1];
}

export default {
  build: {
    target: 'es2022',
    minify: false,
    sourcemap: false,
    emptyOutDir: true,
    lib: {
      entry: 'src/main.ts',
      name: 'WeReadFeishuUI',
      formats: ['iife'],
      fileName: () => 'weread-feishu-ui.user.js',
    },
  },
  plugins: [
    {
      name: 'userscript-banner',
      buildStart() {
        this.addWatchFile(versionFile);
      },
      generateBundle(_options: unknown, bundle: Record<string, any>) {
        const userscriptMeta = createUserscriptMeta(readVersion());
        for (const item of Object.values(bundle)) {
          if (item.type === 'chunk' && item.fileName.endsWith('.user.js')) {
            item.code = `${userscriptMeta}\n${item.code}`;
          }
        }
      },
    },
  ],
};
