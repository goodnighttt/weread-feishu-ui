export function createUserscriptMeta(version: string): string {
  return `// ==UserScript==\n// @name         微信读书 · 飞书云文档外观\n// @namespace    https://weread.qq.com/\n// @version      ${version}\n// @description  将微信读书网页版重构为飞书云文档风格。\n// @author       local\n// @match        https://weread.qq.com/*\n// @icon         https://weread.qq.com/favicon.ico\n// @run-at       document-start\n// @grant        unsafeWindow\n// ==/UserScript==\n`;
}
