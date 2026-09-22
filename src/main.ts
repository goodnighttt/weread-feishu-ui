import { installCanvasCapture } from './reader/canvas-capture';
import { refreshReaderArticle } from './pages/reader';
import { startRouter } from './router';
import { ensureGlobalStyle } from './ui/shell';
import { VERSION } from '../version';
import { alreadyRunning, pageWindow } from './core/page-window';

if (pageWindow.top !== pageWindow) {
  // The reading page embeds other WeRead applications; never skin those frames.
} else if (alreadyRunning) {
  console.info('[wr-feishu-ui] duplicate instance ignored');
} else {
  // Canvas hooks must be installed before WeRead paints the chapter.
  installCanvasCapture(refreshReaderArticle);

  function boot(): void {
    ensureGlobalStyle();
    startRouter(VERSION);
    console.info(`[wr-feishu-ui] v${VERSION} ready. Alt+F toggles the skin.`);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
