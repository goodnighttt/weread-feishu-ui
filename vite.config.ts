import { userscriptMeta } from './userscript.meta.ts';

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
      generateBundle(_options: unknown, bundle: Record<string, any>) {
        for (const item of Object.values(bundle)) {
          if (item.type === 'chunk' && item.fileName.endsWith('.user.js')) {
            item.code = `${userscriptMeta}\n${item.code}`;
          }
        }
      },
    },
  ],
};
