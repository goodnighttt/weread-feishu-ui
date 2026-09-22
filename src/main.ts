import { installCanvasCapture } from './reader/canvas-capture';
import { installReaderContentSourceDiagnostics } from './reader/content-source-diagnostics';
import { refreshReaderArticle } from './pages/reader';
import { startRouter } from './router';
import { ensureGlobalStyle } from './ui/shell';
import { VERSION } from '../version';
import { alreadyRunning, pageWindow } from './core/page-window';

if (pageWindow.top !== pageWindow) {
  // The reading page embeds other WeRead applications; never skin those frames.
} else if (alreadyRunning) {
  console.info('[微信读书·飞书UI] 已检测到运行实例，忽略重复注入');
} else {
  // Canvas hooks must be installed before WeRead paints the chapter.
  installCanvasCapture(refreshReaderArticle);

  function boot(): void {
    ensureGlobalStyle();
    startRouter(VERSION);
    installReaderContentSourceDiagnostics();
    console.info(`[微信读书·飞书UI] v${VERSION} 已启动，Alt+F 可切换外观`);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
