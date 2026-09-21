import { installCanvasCapture } from './reader/canvas-capture';
import { refreshReaderArticle } from './pages/reader';
import { startRouter } from './router';
import { ensureGlobalStyle } from './ui/shell';
import { VERSION } from '../version';

// Canvas hooks must be installed at document-start, before WeRead paints the chapter.
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
