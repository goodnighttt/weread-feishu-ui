# WeRead Feishu UI

把微信读书网页版重新呈现成飞书云文档界面。微信读书继续负责登录、书籍数据、章节加载和原生交互；本项目负责飞书式首页、Reader、目录树和正文文档层。

当前开发版本：`0.5.0`

## 0.5.0：正式工程化

从这一版开始，不再直接维护一个两三千行的 `weread-feishu-ui.user.js`。

正式源码位于 `src/`，通过 TypeScript + Vite 打包，最终仍然只生成一个可安装的油猴脚本：

```text
dist/weread-feishu-ui.user.js
```

根目录的 `weread-feishu-ui.user.js` 已标记为 **LEGACY 0.4.4**，只用于回归对照，不再作为开发源码。

## 工程结构

```text
weread-feishu-ui/
├─ src/
│  ├─ main.ts
│  ├─ router.ts
│  │
│  ├─ adapter/
│  │  └─ weread.ts              # 微信读书 DOM / 元数据 / 原生交互
│  │
│  ├─ pages/
│  │  ├─ home.ts                # 首页生命周期
│  │  └─ reader.ts              # Reader 生命周期
│  │
│  ├─ reader/
│  │  ├─ content.ts             # 正文抽取与 Feishu/Markdown block
│  │  ├─ canvas-capture.ts      # Canvas fillText/strokeText 捕获
│  │  ├─ toc.ts                 # 目录层级、折叠、持久化、active 定位
│  │  └─ chapter-navigation.ts  # chapterUid / WeRead reader URL / 跳转
│  │
│  ├─ ui/
│  │  ├─ shell.ts
│  │  ├─ sidebar.ts
│  │  ├─ topbar.ts
│  │  ├─ home-view.ts
│  │  ├─ reader-view.ts
│  │  └─ icons.ts
│  │
│  ├─ core/
│  │  ├─ dom.ts
│  │  ├─ route.ts
│  │  ├─ state.ts
│  │  ├─ storage.ts
│  │  ├─ types.ts
│  │  └─ page-window.ts
│  │
│  └─ styles/
│     ├─ tokens.css
│     ├─ common.css
│     ├─ home.css
│     ├─ reader.css
│     ├─ toc.css
│     └─ native.css
│
├─ dist/
│  └─ weread-feishu-ui.user.js  # 实际安装文件
├─ legacy/
│  └─ README.md
├─ userscript.meta.ts
├─ package.json
├─ tsconfig.json
└─ vite.config.ts
```

## 开发

首次使用：

```bash
npm install
```

持续构建：

```bash
npm run dev
```

正式构建：

```bash
npm run build
```

类型检查：

```bash
npm run typecheck
```

完整检查：

```bash
npm run check
```

## 安装到 Tampermonkey

不要再复制根目录 legacy 文件。

构建后打开：

```text
D:\WorkSpace\Web\weread-feishu-ui\dist\weread-feishu-ui.user.js
```

把 `dist/weread-feishu-ui.user.js` 的完整内容覆盖到 Tampermonkey 中保存，然后对微信读书页面 `Ctrl + F5`。

脚本头部应显示：

```js
// @version      0.5.0
```

## 模块职责

### `adapter/weread.ts`

只处理微信读书本身：

- 首页书籍 DOM 解析
- 分类 / 作者 / 链接
- `__INITIAL_STATE__`
- 原生目录 / 笔记 / 阅读设置按钮
- `bookId` / book hash / chapter uid

UI 层不应该到处写 `.readerCatalog`、`.readerControls` 之类的选择器。

### `reader/toc.ts`

只处理目录树：

- H1/H2/H3 式层级推断
- chapterInfos 层级合并
- 展开 / 折叠
- 每本书独立保存折叠状态
- 章节切换后自动展开祖先节点
- 自动滚动到当前章节

### `reader/chapter-navigation.ts`

只处理章节跳转：

- `chapterUid`
- 微信读书 `_e()` reader id 编码
- `/web/reader/{bookHash}k{chapterHash}`
- 原生目录 fallback

### `reader/content.ts`

只处理正文：

- 优先读取语义 HTML
- fallback 到原生 DOM 文本
- fallback 到 Canvas 捕获
- 统一转换为 `h2 / h3 / p / quote / code` block

### `ui/*`

只负责生成飞书 UI，不应该知道微信读书具体 DOM selector。

## 当前保留能力

- 微信读书首页 → 飞书云文档首页
- 书籍去重、分类、作者、置顶文档
- 飞书 Reader 页面
- 飞书式 Markdown 正文层
- Canvas 文本捕获
- 层级目录树
- 目录折叠 / 展开
- 目录展开状态持久化
- 当前章节自动定位
- chapterUid 章节跳转
- `Alt + F` 飞书 / 原界面双向切换

## Legacy

根目录：

```text
weread-feishu-ui.user.js
```

是 `0.4.4` 单文件原型备份。以后功能修改全部进入 `src/`，再通过 Vite 生成 `dist/`，不要再直接修改 legacy 文件。
