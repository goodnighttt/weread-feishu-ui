// ==UserScript==
// @name         微信读书 · 飞书云文档外观
// @namespace    https://weread.qq.com/
// @version      0.5.8
// @description  将微信读书网页版重构为飞书云文档风格。
// @author       local
// @match        https://weread.qq.com/*
// @icon         https://weread.qq.com/favicon.ico
// @run-at       document-start
// @noframes
// @grant        unsafeWindow
// ==/UserScript==

(function() {
	//#region src/core/dom.ts
	function cleanText(value = "") {
		return String(value).replace(/\s+/g, " ").trim();
	}
	function escapeHtml(value = "") {
		return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#039;");
	}
	function normalizeUrl(value = "") {
		try {
			return new URL(value, location.origin).href;
		} catch {
			return "";
		}
	}
	function canonicalText(value = "") {
		return cleanText(value).toLowerCase().replace(/[\s·•—–_\-:：，,。.!！?？'"“”‘’（）()【】\[\]<>《》]/g, "");
	}
	function queryByText(selectors, keywords) {
		return [...document.querySelectorAll(selectors.join(","))].find((node) => {
			const text = `${node.textContent || ""} ${node.getAttribute("title") || ""} ${node.getAttribute("aria-label") || ""}`;
			return keywords.some((key) => text.includes(key));
		}) || null;
	}
	function nextFrame(callback) {
		requestAnimationFrame(() => requestAnimationFrame(callback));
	}
	//#endregion
	//#region src/core/page-window.ts
	var pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
	var alreadyRunning = Boolean(pageWindow.__wrFeishuUIRunning);
	if (!alreadyRunning) pageWindow.__wrFeishuUIRunning = true;
	//#endregion
	//#region src/core/storage.ts
	var STORAGE = {
		enabled: "wr-feishu-ui:enabled",
		pinnedBooks: "wr-feishu-ui:pinned-books",
		readerTocOpen: "wr-feishu-ui:reader-toc-open",
		readerTocCollapsed: "wr-feishu-ui:reader-toc-collapsed",
		readerTocMigration: "wr-feishu-ui:reader-toc-v2"
	};
	function readBoolean(key, fallback) {
		const value = localStorage.getItem(key);
		if (value == null) return fallback;
		return value === "1";
	}
	function writeBoolean(key, value) {
		localStorage.setItem(key, value ? "1" : "0");
	}
	function readJson(key, fallback) {
		try {
			const value = localStorage.getItem(key);
			return value ? JSON.parse(value) : fallback;
		} catch {
			return fallback;
		}
	}
	function writeJson(key, value) {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch {}
	}
	function migrateReaderTocDefaultOpen() {
		if (localStorage.getItem(STORAGE.readerTocMigration) !== "1") {
			localStorage.setItem(STORAGE.readerTocMigration, "1");
			writeBoolean(STORAGE.readerTocOpen, true);
			return true;
		}
		return readBoolean(STORAGE.readerTocOpen, true);
	}
	function readPinnedBooks() {
		return readJson(STORAGE.pinnedBooks, []);
	}
	function readCollapsedToc() {
		return readJson(STORAGE.readerTocCollapsed, {});
	}
	//#endregion
	//#region src/core/state.ts
	var state = {
		enabled: readBoolean(STORAGE.enabled, true),
		page: "none",
		lastUrl: location.href,
		observer: null,
		refreshTimer: 0,
		host: null,
		root: null,
		shellMarker: "",
		homeDataSignature: "",
		readerTocOpen: migrateReaderTocDefaultOpen(),
		readerTocItems: [],
		readerOfficialToc: [],
		readerOfficialTocPromise: null,
		readerArticleSignature: "",
		readerBookKey: "",
		readerTocPrimeTimer: 0,
		readerTocPrimeAttempts: 0,
		metadataCache: /* @__PURE__ */ new Map(),
		canvasCapture: /* @__PURE__ */ new Map(),
		canvasRefreshTimer: 0,
		pinnedBooks: readPinnedBooks(),
		readerTocCollapsedByBook: readCollapsedToc()
	};
	//#endregion
	//#region src/reader/canvas-capture.ts
	var refreshCallback = null;
	function scheduleCanvasRefresh() {
		window.clearTimeout(state.canvasRefreshTimer);
		state.canvasRefreshTimer = window.setTimeout(() => {
			if (state.enabled && state.page === "reader") refreshCallback?.();
		}, 180);
	}
	function captureCanvasText(ctx, text, x, y) {
		if (!location.pathname.startsWith("/web/reader/")) return;
		const canvas = ctx.canvas;
		const value = cleanText(String(text ?? ""));
		if (!canvas || value.length === 0 || value.length > 800) return;
		let bucket = state.canvasCapture.get(canvas);
		if (!bucket) {
			bucket = {
				records: /* @__PURE__ */ new Map(),
				updatedAt: 0
			};
			state.canvasCapture.set(canvas, bucket);
		}
		const font = String(ctx.font || "16px sans-serif");
		let drawX = Number(x) || 0;
		let drawY = Number(y) || 0;
		let scale = 1;
		try {
			const matrix = ctx.getTransform();
			const originalX = drawX;
			const originalY = drawY;
			drawX = matrix.a * originalX + matrix.c * originalY + matrix.e;
			drawY = matrix.b * originalX + matrix.d * originalY + matrix.f;
			scale = Math.max(.01, Math.hypot(matrix.a, matrix.b));
		} catch {}
		const key = `${Math.round(drawX)}|${Math.round(drawY)}|${font}|${value}`;
		bucket.records.set(key, {
			text: value,
			x: drawX,
			y: drawY,
			font,
			scale,
			align: String(ctx.textAlign || "start"),
			width: (() => {
				try {
					return (ctx.measureText(value).width || 0) * scale;
				} catch {
					return 0;
				}
			})()
		});
		bucket.updatedAt = Date.now();
		scheduleCanvasRefresh();
	}
	function installCanvasCapture(onRefresh) {
		refreshCallback = onRefresh;
		const proto = pageWindow.CanvasRenderingContext2D?.prototype;
		if (!proto || proto.__wrfCaptureInstalled) return;
		proto.__wrfCaptureInstalled = true;
		const originalFillText = proto.fillText;
		proto.fillText = function(...args) {
			try {
				captureCanvasText(this, args[0], args[1], args[2]);
			} catch {}
			return originalFillText.apply(this, args);
		};
		if (typeof proto.strokeText === "function") {
			const originalStrokeText = proto.strokeText;
			proto.strokeText = function(...args) {
				try {
					captureCanvasText(this, args[0], args[1], args[2]);
				} catch {}
				return originalStrokeText.apply(this, args);
			};
		}
	}
	function clearCanvasCapture() {
		state.canvasCapture.clear();
	}
	function getCanvasEntries() {
		const entries = [];
		for (const [canvas, bucket] of [...state.canvasCapture.entries()]) {
			if (!canvas.isConnected) {
				state.canvasCapture.delete(canvas);
				continue;
			}
			for (const record of bucket.records.values()) entries.push({
				canvas,
				record
			});
		}
		return entries;
	}
	//#endregion
	//#region src/adapter/weread.ts
	var HOME_SECTION_NAMES = [
		"最近热搜",
		"大家都在看",
		"大家都在读",
		"热门推荐",
		"编辑推荐",
		"飙升榜",
		"新书榜",
		"总榜",
		"热搜榜",
		"榜单",
		"我的书架",
		"最近阅读"
	];
	function canonicalBookTitle(value = "") {
		return canonicalText(value).replace(/全集|全本|完整版/g, "");
	}
	function normalizeSectionName(value = "") {
		const text = cleanText(value);
		if (!text || text.length > 32) return "";
		if (text.includes("最近热搜")) return "最近热搜";
		if (text.includes("大家都在看") || text.includes("大家都在读")) return "大家都在看";
		if (text.includes("飙升榜")) return "飙升榜";
		if (text.includes("新书榜")) return "新书榜";
		if (text.includes("热搜榜")) return "热搜榜";
		if (text.includes("总榜")) return "总榜";
		if (text === "榜单") return "榜单";
		if (text.includes("我的书架")) return "我的书架";
		if (text.includes("最近阅读")) return "最近阅读";
		if (text.includes("热门推荐")) return "热门推荐";
		if (text.includes("编辑推荐")) return "编辑推荐";
		return HOME_SECTION_NAMES.includes(text) ? text : "";
	}
	function collectHomeSectionMarkers() {
		const selectors = [
			"h1",
			"h2",
			"h3",
			"h4",
			"h5",
			"[class*=\"section\"] [class*=\"title\"]",
			"[class*=\"header\"] [class*=\"title\"]",
			"[class*=\"ranking\"] [class*=\"title\"]",
			"[class*=\"rank\"] [class*=\"title\"]",
			"[class*=\"title\"]"
		];
		const seen = /* @__PURE__ */ new Set();
		const markers = [];
		for (const node of document.querySelectorAll(selectors.join(","))) {
			if (seen.has(node)) continue;
			const name = normalizeSectionName(node.textContent || "");
			if (!name) continue;
			seen.add(node);
			markers.push({
				node,
				name
			});
		}
		return markers;
	}
	function detectBookSection(anchor, markers) {
		let result = "";
		for (const marker of markers) {
			if (marker.node === anchor || marker.node.contains(anchor)) continue;
			if (marker.node.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING) result = marker.name;
		}
		if (result) return result;
		let cursor = anchor.parentElement;
		for (let depth = 0; depth < 7 && cursor && cursor !== document.body; depth += 1) {
			for (const child of cursor.children) {
				const name = normalizeSectionName(child.textContent || "");
				if (name) return name;
			}
			cursor = cursor.parentElement;
		}
		return "其他";
	}
	function getBookContainer(anchor) {
		let node = anchor;
		for (let i = 0; i < 5 && node.parentElement; i += 1) {
			const parent = node.parentElement;
			const text = cleanText(parent.textContent || "");
			if (text.length > 0 && text.length < 260) node = parent;
			else break;
		}
		return node;
	}
	function pickText(root, selectors, reject = []) {
		for (const selector of selectors) {
			const nodes = root.matches(selector) ? [root] : [...root.querySelectorAll(selector)];
			for (const node of nodes) {
				const value = cleanText(node.textContent || node.getAttribute("title") || node.getAttribute("alt") || "");
				if (!value || value.length > 90) continue;
				if (reject.some((item) => value.includes(item))) continue;
				return value;
			}
		}
		return "";
	}
	function collectRecentHotSearchEntries(sectionMarkers, books) {
		const marker = sectionMarkers.find((item) => item.name === "最近热搜");
		if (!marker) return [];
		let scope = marker.node.parentElement;
		let candidates = [];
		for (let depth = 0; depth < 5 && scope; depth += 1) {
			candidates = [...scope.querySelectorAll("a, button, [role=\"button\"]")].map((node) => ({
				node,
				title: cleanText(node.textContent || node.getAttribute("title") || "")
			})).filter((item) => item.title && item.title !== "最近热搜" && item.title.length >= 2 && item.title.length <= 30).filter((item) => ![
				"搜索",
				"换一批",
				"登录",
				"传书到手机",
				"大家都在看",
				"大家都在读",
				"榜单",
				"飙升榜",
				"新书榜"
			].some((word) => item.title.includes(word)));
			if (candidates.length >= 2 && candidates.length <= 12) break;
			scope = scope.parentElement;
		}
		const seen = /* @__PURE__ */ new Set();
		const entries = [];
		for (const item of candidates.slice(0, 8)) {
			const key = canonicalBookTitle(item.title);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			const matched = books.find((book) => {
				const title = canonicalBookTitle(book.title);
				return title === key || title.includes(key) || key.includes(title);
			});
			const rawHref = item.node.getAttribute("href") || "";
			entries.push({
				href: matched?.href || normalizeUrl(rawHref) || `https://weread.qq.com/web/search/books?keyword=${encodeURIComponent(item.title)}`,
				title: matched?.title || item.title,
				category: "最近热搜",
				author: matched?.author || "未知作者",
				cover: matched?.cover || ""
			});
		}
		return entries;
	}
	function collectHomeBooks() {
		const anchors = [...document.querySelectorAll("a[href*=\"/web/reader/\"], a[href*=\"/web/bookDetail/\"]")];
		const markers = collectHomeSectionMarkers();
		const seenLinks = /* @__PURE__ */ new Set();
		const seenTitles = /* @__PURE__ */ new Set();
		const books = [];
		const titleReject = [
			"大家都在读",
			"大家都在看",
			"榜单",
			"换一批",
			"最近热搜",
			"传书到手机",
			"登录",
			"飙升榜",
			"新书榜"
		];
		for (const anchor of anchors) {
			const href = normalizeUrl(anchor.getAttribute("href") || anchor.href || "");
			if (!href || seenLinks.has(href)) continue;
			const container = getBookContainer(anchor);
			const img = anchor.querySelector("img") || container.querySelector("img");
			let title = pickText(container, [
				"[class*=\"title\"]",
				"[class*=\"name\"]",
				"h1",
				"h2",
				"h3",
				"h4"
			], titleReject);
			if (!title) {
				const direct = cleanText(anchor.textContent || "");
				if (direct && direct.length <= 80 && !titleReject.some((item) => direct.includes(item))) title = direct;
			}
			if (!title && img) title = cleanText(img.getAttribute("alt") || img.getAttribute("title") || "");
			if (!title || title.length < 2) continue;
			const titleKey = canonicalBookTitle(title);
			if (!titleKey || titleReject.some((label) => titleKey === canonicalBookTitle(label)) || seenTitles.has(titleKey)) continue;
			const category = detectBookSection(anchor, markers);
			let author = pickText(container, ["[class*=\"author\"]", "[class*=\"writer\"]"], [title, category]);
			if (!author) author = [...container.querySelectorAll("span, p, div")].map((node) => cleanText(node.textContent || "")).filter((value) => value && value !== title && value !== category && value.length <= 24).filter((value) => ![
				"大家都在读",
				"大家都在看",
				"最近热搜",
				"正在阅读",
				"推荐值",
				"换一批",
				"榜单"
			].some((word) => value.includes(word))).find((value) => !/^\d/.test(value) && !normalizeSectionName(value)) || "";
			seenLinks.add(href);
			seenTitles.add(titleKey);
			books.push({
				href,
				title,
				category,
				author: author || "未知作者",
				cover: img?.currentSrc || img?.src || ""
			});
			if (books.length >= 24) break;
		}
		const merged = [...collectRecentHotSearchEntries(markers, books), ...books];
		const result = [];
		const resultKeys = /* @__PURE__ */ new Set();
		for (const book of merged) {
			const key = canonicalBookTitle(book.title);
			if (!key || resultKeys.has(key)) continue;
			resultKeys.add(key);
			result.push(book);
			if (result.length >= 18) break;
		}
		return result;
	}
	function homeDataSignature(books) {
		return books.map((book) => `${book.href}|${book.title}|${book.author}|${book.category}`).join("::");
	}
	function parseBookMetadataFromHtml(html = "") {
		const doc = new DOMParser().parseFromString(html, "text/html");
		return {
			title: cleanText(doc.querySelector(".bookInfo_title, [class*=\"bookInfo_title\"], h1")?.textContent || doc.querySelector("meta[property=\"og:title\"]")?.getAttribute("content") || ""),
			author: cleanText(doc.querySelector(".bookInfo_author, [class*=\"author\"]")?.textContent || doc.querySelector("meta[name=\"author\"]")?.getAttribute("content") || "")
		};
	}
	async function enrichHomeBooks(books, cache) {
		const targets = books.filter((book) => !book.author || book.author === "未知作者").slice(0, 8);
		if (!targets.length) return false;
		let changed = false;
		await Promise.all(targets.map(async (book) => {
			const cached = cache.get(book.href);
			if (cached?.author) {
				book.author = cached.author;
				changed = true;
				return;
			}
			try {
				const response = await fetch(book.href, { credentials: "include" });
				if (!response.ok) return;
				const meta = parseBookMetadataFromHtml(await response.text());
				cache.set(book.href, meta);
				if (meta.author) {
					book.author = meta.author;
					changed = true;
				}
			} catch {}
		}));
		return changed;
	}
	function getReaderMeta() {
		let reader = null;
		try {
			reader = pageWindow.__INITIAL_STATE__?.reader || null;
		} catch {}
		const textOf = (selectors) => {
			for (const selector of selectors) {
				const text = cleanText(document.querySelector(selector)?.textContent || "");
				if (text) return text;
			}
			return "";
		};
		let book = cleanText(reader?.bookInfo?.title || "") || textOf([
			".readerTopBar_title_link",
			".readerTopBar_title",
			".bookInfo_title",
			"[class*=\"readerTopBar_title\"]"
		]);
		let chapter = textOf([
			".renderTargetPageInfo_header_chapterTitle",
			".readerTopBar_title_chapter",
			".readerChapterContent_title",
			".readerContentHeader_title",
			"[class*=\"readerTopBar_title_chapter\"]"
		]);
		let author = cleanText(reader?.bookInfo?.author || "");
		if (!chapter && book && author) {
			const prefix = `${book} - `;
			const suffix = ` - ${author} - 微信读书`;
			if (document.title.startsWith(prefix) && document.title.endsWith(suffix)) chapter = cleanText(document.title.slice(prefix.length, -suffix.length));
		}
		if (!chapter) chapter = cleanText(reader?.currentChapter?.title || "");
		if (!book) {
			const title = document.title.replace(/\s*[-_|｜].*微信读书.*$/i, "").trim();
			if (title && title !== "微信读书") book = title;
		}
		if (!chapter) chapter = "正文";
		if (!book) book = "微信读书";
		if (!author) author = cleanText(document.querySelector("[class*=\"author\"], [class*=\"writer\"]")?.textContent || "");
		return {
			book,
			chapter,
			author: author || "微信读书"
		};
	}
	function clickNative(action) {
		const config = {
			catalog: {
				direct: [
					".readerControls_item.catalog",
					".readerControls_catalog",
					"[class*=\"readerControls\"][class*=\"catalog\"]"
				],
				text: ["目录"]
			},
			note: {
				direct: [
					".readerControls_item.note",
					".readerControls_note",
					"[class*=\"readerControls\"][class*=\"note\"]"
				],
				text: ["笔记", "想法"]
			},
			font: {
				direct: [
					".readerControls_item.fontSize",
					".readerControls_fontSize",
					"[class*=\"readerControls\"][class*=\"font\"]"
				],
				text: ["字体", "字号"]
			}
		}[action];
		for (const selector of config.direct) {
			const target = document.querySelector(selector);
			if (target instanceof HTMLElement) {
				target.click();
				return true;
			}
		}
		const byText = queryByText([
			".readerControls_item",
			".readerControls button",
			"button",
			"[role=\"button\"]"
		], config.text);
		if (byText instanceof HTMLElement) {
			byText.click();
			return true;
		}
		return false;
	}
	function clickNativeHomeText(keywords) {
		const target = [...document.querySelectorAll("a, button, [role=\"button\"]")].find((node) => keywords.some((keyword) => cleanText(node.textContent || "").includes(keyword)));
		if (target instanceof HTMLElement) {
			target.click();
			return true;
		}
		return false;
	}
	function getReaderBookId() {
		try {
			const fromState = String(pageWindow.__INITIAL_STATE__?.reader?.bookInfo?.bookId || "").trim();
			if (fromState) return fromState;
		} catch {}
		for (const script of document.querySelectorAll("script[type=\"application/ld+json\"]")) try {
			const data = JSON.parse(script.textContent || "{}");
			const values = Array.isArray(data) ? data : [data];
			for (const item of values) {
				const raw = item?.bookId ?? item?.["@Id"] ?? item?.["@id"] ?? "";
				const match = String(raw).match(/(?:bookId[=/:])?([A-Za-z0-9_]+)$/);
				if (match?.[1]) return match[1];
			}
		} catch {}
		for (const script of document.scripts) {
			const text = script.textContent || "";
			if (!text.includes("bookId")) continue;
			const match = text.match(/["']bookId["']\s*:\s*["']([^"']+)["']/);
			if (match?.[1]) return match[1];
		}
		return "";
	}
	function getReaderBookHash() {
		const match = location.pathname.match(/^\/web\/reader\/([^/?#]+)/);
		return match ? match[1].split("k")[0] : "";
	}
	function getCurrentReaderChapterUid() {
		const queryUid = new URLSearchParams(location.search).get("progressChapterUid");
		if (queryUid) return queryUid;
		try {
			const chapter = pageWindow.__INITIAL_STATE__?.reader?.currentChapter;
			return String(chapter?.chapterUid ?? chapter?.uid ?? "").trim();
		} catch {
			return "";
		}
	}
	function extractChapterUid(node) {
		const chain = [node, node.closest("[data-chapter-uid], [data-chapteruid], [data-uid]")].filter(Boolean);
		for (const el of chain) {
			const value = [
				el.getAttribute("data-chapter-uid"),
				el.getAttribute("data-chapteruid"),
				el.getAttribute("data-uid")
			].find((item) => item != null && /^\d+$/.test(String(item)));
			if (value != null) return String(value);
		}
		return "";
	}
	function getActionHref(node) {
		const anchor = node.matches("a[href]") ? node : node.closest("a[href]") || node.querySelector("a[href]");
		return anchor instanceof HTMLAnchorElement ? normalizeUrl(anchor.getAttribute("href") || anchor.href || "") : "";
	}
	function getNativeTocPanel() {
		return document.querySelector(".readerCatalog, [class*=\"readerCatalog\"]");
	}
	//#endregion
	//#region src/reader/chapter-navigation.ts
	var NAV_LOG = "[微信读书·飞书UI][目录跳转]";
	var PANEL = "data-wrf-native-hit-panel";
	var ROW = "data-wrf-native-hit";
	var PATH = "data-wrf-native-hit-path";
	var rectProperties = [
		"--wrf-hit-left",
		"--wrf-hit-top",
		"--wrf-hit-width",
		"--wrf-hit-height"
	];
	var marked = /* @__PURE__ */ new Set();
	var trackedRows = /* @__PURE__ */ new WeakSet();
	var boundRoots = /* @__PURE__ */ new WeakSet();
	var frame = 0;
	var resizeObserver = null;
	var observedOutline = null;
	var windowEventsBound = false;
	var navigationId = 0;
	function nativeTitle(row) {
		return cleanText(row.querySelector(".readerCatalog_list_item_title_text")?.textContent || row.getAttribute("title") || "");
	}
	function mark(element, attribute, value = "1") {
		if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
		marked.add(element);
	}
	function unmark(element) {
		element.removeAttribute(PANEL);
		element.removeAttribute(ROW);
		element.removeAttribute(PATH);
		rectProperties.forEach((property) => element.style.removeProperty(property));
		marked.delete(element);
	}
	function clearNativeTocHitTargets() {
		cancelAnimationFrame(frame);
		frame = 0;
		[...marked].forEach(unmark);
		resizeObserver?.disconnect();
		observedOutline = null;
	}
	function recordNativeClick(row) {
		if (trackedRows.has(row)) return;
		trackedRows.add(row);
		row.addEventListener("click", (event) => {
			if (!row.hasAttribute(ROW) || !event.isTrusted) return;
			const title = nativeTitle(row);
			const beforeHref = location.href;
			const id = ++navigationId;
			console.info(`${NAV_LOG} 原生目录收到真实点击`, {
				章节: title,
				isTrusted: event.isTrusted
			});
			const started = performance.now();
			const check = () => {
				if (id !== navigationId || !state.enabled || state.page !== "reader") return;
				if (location.href !== beforeHref && getReaderMeta().chapter === title) {
					console.info(`${NAV_LOG} 已确认目标章节`, {
						章节: title,
						地址: location.href
					});
					syncNativeTocHitTargets();
				} else if (performance.now() - started < 8e3) window.setTimeout(check, 150);
				else console.warn(`${NAV_LOG} 尚未确认目标章节，请检查原生阅读页的登录或购买提示`, { 章节: title });
			};
			window.setTimeout(check, 150);
		}, { capture: true });
		row.addEventListener("wheel", (event) => {
			if (!row.hasAttribute(ROW) || !observedOutline) return;
			event.preventDefault();
			const scale = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? observedOutline.clientHeight : 1;
			observedOutline.scrollTop += event.deltaY * scale;
			updateHitTargets();
		}, { passive: false });
	}
	function updateHitTargets() {
		frame = 0;
		const outline = state.root?.querySelector(".wrf-reader-outline");
		if (!state.enabled || state.page !== "reader" || !state.readerTocOpen || !outline?.isConnected || outline.classList.contains("hidden")) {
			clearNativeTocHitTargets();
			return;
		}
		if (observedOutline !== outline) {
			resizeObserver?.disconnect();
			observedOutline = outline;
			resizeObserver ??= new ResizeObserver(syncNativeTocHitTargets);
			resizeObserver.observe(outline);
		}
		const panel = getNativeTocPanel();
		if (!(panel instanceof HTMLElement)) {
			[...marked].forEach(unmark);
			return;
		}
		const rows = [...panel.querySelectorAll(".readerCatalog_list_item")];
		const byTitle = /* @__PURE__ */ new Map();
		const byUid = /* @__PURE__ */ new Map();
		for (const row of rows) {
			const title = nativeTitle(row);
			if (title) byTitle.set(title, [...byTitle.get(title) || [], row]);
			const uid = extractChapterUid(row);
			if (uid) byUid.set(uid, [...byUid.get(uid) || [], row]);
		}
		const keep = /* @__PURE__ */ new Set();
		const bounds = outline.getBoundingClientRect();
		for (const visual of outline.querySelectorAll(".wrf-outline-item")) {
			const item = state.readerTocItems[Number(visual.dataset.tocIndex)];
			if (!item || item.locked) continue;
			const candidates = item.chapterUid && byUid.get(String(item.chapterUid)) || byTitle.get(cleanText(item.title)) || [];
			if (candidates.length !== 1) continue;
			const row = candidates[0];
			if (!row.querySelector(".readerCatalog_list_item_inner")) continue;
			const rect = visual.getBoundingClientRect();
			const left = Math.max(rect.left, bounds.left, 0);
			const top = Math.max(rect.top, bounds.top, 0);
			const right = Math.min(rect.right, bounds.right, innerWidth);
			const bottom = Math.min(rect.bottom, bounds.bottom, innerHeight);
			if (right <= left || bottom <= top) continue;
			mark(panel, PANEL);
			keep.add(panel);
			for (let parent = row.parentElement; parent && parent !== panel; parent = parent.parentElement) {
				mark(parent, PATH);
				keep.add(parent);
			}
			mark(row, ROW, visual.dataset.tocIndex);
			keep.add(row);
			[
				left,
				top,
				right - left,
				bottom - top
			].forEach((value, index) => {
				const text = `${value}px`;
				if (row.style.getPropertyValue(rectProperties[index]) !== text) row.style.setProperty(rectProperties[index], text);
			});
			recordNativeClick(row);
		}
		for (const element of [...marked]) if (!keep.has(element)) unmark(element);
	}
	function syncNativeTocHitTargets() {
		if (!windowEventsBound) {
			windowEventsBound = true;
			window.addEventListener("resize", syncNativeTocHitTargets, { passive: true });
			window.addEventListener("scroll", syncNativeTocHitTargets, {
				passive: true,
				capture: true
			});
		}
		if (state.root && !boundRoots.has(state.root)) {
			boundRoots.add(state.root);
			state.root.addEventListener("scroll", updateHitTargets, {
				passive: true,
				capture: true
			});
		}
		if (!frame) frame = requestAnimationFrame(updateHitTargets);
	}
	function resolveCurrentReaderChapterUid(items = state.readerTocItems) {
		const title = getReaderMeta().chapter;
		const matches = items.filter((item) => item.title === title && item.chapterUid);
		return matches.length === 1 ? String(matches[0].chapterUid) : getCurrentReaderChapterUid();
	}
	async function navigateToReaderTocItem(index, title) {
		syncNativeTocHitTargets();
		console.warn(`${NAV_LOG} 未命中原生目录，请切回原界面使用目录`, {
			章节: title,
			目录序号: index
		});
		return false;
	}
	//#endregion
	//#region src/reader/content.ts
	function parseFontPx(font = "") {
		const match = String(font).match(/([\d.]+)px/i);
		return match ? Number(match[1]) || 16 : 16;
	}
	function shouldInsertSpace(left = "", right = "", gap = 0, fontPx = 16) {
		if (gap < Math.max(2, fontPx * .16)) return false;
		return /[A-Za-z0-9_)\]]$/.test(left) && /^[A-Za-z0-9_(\[]/.test(right);
	}
	function getCapturedReaderLines() {
		const entries = getCanvasEntries();
		const fragments = [];
		for (const { canvas, record } of entries) {
			if (!canvas.closest(".readerContent, .app_content, .readerChapterContent")) continue;
			const rect = canvas.getBoundingClientRect();
			if (rect.width < 20 || rect.height < 20 || !canvas.width || !canvas.height) continue;
			const scaleX = rect.width / canvas.width;
			const scaleY = rect.height / canvas.height;
			const fontPx = parseFontPx(record.font) * (record.scale || 1) * scaleY;
			const width = record.width * scaleX;
			let x = rect.left + record.x * scaleX;
			if (record.align === "center") x -= width / 2;
			else if (record.align === "right" || record.align === "end") x -= width;
			fragments.push({
				text: cleanText(record.text),
				x,
				y: rect.top + window.scrollY + record.y * scaleY,
				width,
				fontPx,
				font: record.font,
				align: record.align
			});
		}
		fragments.sort((a, b) => a.y - b.y || a.x - b.x);
		const rows = [];
		for (const fragment of fragments) {
			if (!fragment.text) continue;
			let row = rows[rows.length - 1];
			const tolerance = Math.max(3, fragment.fontPx * .22);
			if (!row || Math.abs(row.y - fragment.y) > tolerance) {
				row = {
					y: fragment.y,
					fragments: [],
					fontPx: fragment.fontPx,
					font: fragment.font
				};
				rows.push(row);
			}
			if (!row.fragments.some((item) => Math.abs(item.x - fragment.x) < 1.5 && item.text === fragment.text)) row.fragments.push(fragment);
			row.fontPx = Math.max(row.fontPx, fragment.fontPx);
		}
		const seen = /* @__PURE__ */ new Set();
		const lines = [];
		for (const row of rows) {
			row.fragments.sort((a, b) => a.x - b.x);
			let text = "";
			let previousEnd = null;
			for (const fragment of row.fragments) {
				const gap = previousEnd == null ? 0 : fragment.x - previousEnd;
				if (text && shouldInsertSpace(text, fragment.text, gap, row.fontPx)) text += " ";
				if (!text.endsWith(fragment.text) || fragment.text.length > 1) text += fragment.text;
				previousEnd = Math.max(previousEnd ?? -Infinity, fragment.x + Math.max(fragment.width, 1));
			}
			text = cleanText(text);
			if (!text || text.length > 1e3) continue;
			const signature = `${Math.round(row.y / 3)}|${text}`;
			if (seen.has(signature)) continue;
			seen.add(signature);
			lines.push({
				text,
				y: row.y,
				x: row.fragments[0]?.x || 0,
				fontPx: row.fontPx,
				font: row.font
			});
		}
		return lines;
	}
	function getInitialStateReaderBlocks() {
		let reader = null;
		try {
			reader = pageWindow.__INITIAL_STATE__?.reader || null;
		} catch {}
		if (!reader) return [];
		const candidates = [
			reader.currentChapter?.content,
			reader.currentChapter?.html,
			reader.chapterData?.content,
			reader.chapterContent,
			reader.content
		].filter((value) => typeof value === "string" && value.trim().length > 20);
		if (!candidates.length) return [];
		const source = [...candidates].sort((a, b) => b.length - a.length)[0];
		if (!/[<>]/.test(source)) return source.split(/\n{2,}|\r\n{2,}/).map((text) => ({
			type: "p",
			text: cleanText(text)
		})).filter((block) => block.text);
		try {
			const root = new DOMParser().parseFromString(`<div id="wrf-source">${source}</div>`, "text/html").getElementById("wrf-source");
			root?.querySelectorAll("script,style,noscript").forEach((node) => node.remove());
			const blocks = [];
			for (const node of root?.querySelectorAll("h1,h2,h3,h4,h5,h6,p,blockquote,pre,li") || []) {
				const text = cleanText(node.textContent || "");
				if (!text) continue;
				const tag = node.tagName.toLowerCase();
				if (tag === "h1" || tag === "h2") blocks.push({
					type: "h2",
					text
				});
				else if (/^h[3-6]$/.test(tag)) blocks.push({
					type: "h3",
					text
				});
				else if (tag === "blockquote") blocks.push({
					type: "quote",
					text
				});
				else if (tag === "pre") blocks.push({
					type: "code",
					text: node.textContent || ""
				});
				else blocks.push({
					type: "p",
					text
				});
			}
			return blocks;
		} catch {
			return [];
		}
	}
	function getNativeReaderLines() {
		const root = document.querySelector(".readerChapterContent");
		const source = root?.innerText || root?.textContent || "";
		if (!cleanText(source) || source.length < 20) return [];
		return source.split(/\n+/).map((value, index) => ({
			text: cleanText(value),
			y: index * 30,
			x: 0,
			fontPx: 16,
			font: ""
		})).filter((item) => item.text);
	}
	function getReaderBlocks() {
		const semantic = getInitialStateReaderBlocks();
		if (semantic.length >= 2) return semantic.slice(0, 800);
		const meta = getReaderMeta();
		let lines = getCapturedReaderLines();
		if (lines.length < 3) lines = getNativeReaderLines();
		if (!lines.length) return [];
		const fontValues = lines.map((line) => line.fontPx).filter((value) => value >= 8 && value <= 64).sort((a, b) => a - b);
		const bodyFont = fontValues[Math.floor(fontValues.length * .45)] || 16;
		const ignored = [
			"上一章",
			"下一章",
			"目录",
			"笔记",
			"阅读设置",
			"返回顶部",
			"微信读书"
		];
		const chapterKey = canonicalBookTitle(meta.chapter);
		const bookKey = canonicalBookTitle(meta.book);
		const filtered = lines.filter((line) => {
			const key = canonicalBookTitle(line.text);
			return Boolean(key) && key !== chapterKey && key !== bookKey && !ignored.includes(line.text);
		});
		const blocks = [];
		let paragraph = [];
		let paragraphLast = null;
		const flush = () => {
			if (!paragraph.length) return;
			let value = "";
			for (const line of paragraph) if (!value) value = line.text;
			else if (/[A-Za-z0-9,.;:!?)]$/.test(value) && /^[A-Za-z0-9([]/.test(line.text)) value += ` ${line.text}`;
			else value += line.text;
			value = cleanText(value);
			if (value) blocks.push({
				type: "p",
				text: value
			});
			paragraph = [];
			paragraphLast = null;
		};
		for (const line of filtered) {
			const isMono = /mono|consolas|courier/i.test(line.font || "");
			if (line.text.length <= 90 && line.fontPx >= bodyFont * 1.24 || isMono || /^>\s?/.test(line.text)) {
				flush();
				if (isMono) blocks.push({
					type: "code",
					text: line.text
				});
				else if (/^>\s?/.test(line.text)) blocks.push({
					type: "quote",
					text: line.text.replace(/^>\s?/, "")
				});
				else blocks.push({
					type: line.fontPx >= bodyFont * 1.55 ? "h2" : "h3",
					text: line.text
				});
				continue;
			}
			if (paragraphLast) {
				const gap = line.y - paragraphLast.y;
				const indentDelta = Math.abs(line.x - paragraph[0].x);
				if (gap > Math.max(bodyFont * 2.05, 31) || indentDelta > bodyFont * 2.6) flush();
			}
			paragraph.push(line);
			paragraphLast = line;
		}
		flush();
		return blocks.filter((block, index, list) => {
			const previous = list[index - 1];
			return !previous || previous.type !== block.type || previous.text !== block.text;
		}).slice(0, 800);
	}
	function readerBlocksHtml(blocks) {
		if (!blocks.length) return "<div class=\"wrf-article-loading\">正在把微信读书正文转换成飞书文档排版…<br>如果刚进入章节，请等待正文完成渲染。</div>";
		return blocks.map((block) => {
			const text = escapeHtml(block.text);
			if (block.type === "h2") return `<h2 class="wrf-md-h2">${text}</h2>`;
			if (block.type === "h3") return `<h3 class="wrf-md-h3">${text}</h3>`;
			if (block.type === "quote") return `<blockquote class="wrf-md-quote">${text}</blockquote>`;
			if (block.type === "code") return `<pre class="wrf-md-code">${text}</pre>`;
			return `<p class="wrf-md-p">${text}</p>`;
		}).join("");
	}
	//#endregion
	//#region src/reader/toc.ts
	var TOC_LOG = "[wr-feishu-ui][toc]";
	function isTocVolumeTitle(title = "") {
		return /^(第[一二三四五六七八九十百千万零〇0-9]+[卷部篇辑册编]|卷[一二三四五六七八九十百千万零〇0-9]+|part\s*[ivx0-9]+)/i.test(cleanText(title));
	}
	function isTocChapterTitle(title = "") {
		return /^(第[一二三四五六七八九十百千万零〇0-9]+章|chapter\s*\d+)/i.test(cleanText(title));
	}
	function isTocFrontMatterTitle(title = "") {
		return /^(序章|序言|前言|楔子|引子|版权信息|版权声明|书籍封面|封面|目录|后记|附录|跋|致谢)/.test(cleanText(title));
	}
	function isTocSubsectionTitle(title = "") {
		return /^(\d+(?:\.\d+)+|[一二三四五六七八九十]+、|\([一二三四五六七八九十0-9]+\)|（[一二三四五六七八九十0-9]+）|第[一二三四五六七八九十百千万零〇0-9]+[节小节])/.test(cleanText(title));
	}
	function inferTocLevelFromTitle(title = "", context = {}) {
		const text = cleanText(title);
		if (!text) return 0;
		if (isTocFrontMatterTitle(text) || isTocVolumeTitle(text)) return 0;
		if (isTocChapterTitle(text)) return context.hasVolume ? 1 : 0;
		if (isTocSubsectionTitle(text)) return Math.min(4, (context.currentChapterLevel ?? (context.hasVolume ? 1 : 0)) + 1);
		if (context.seenChapter) return Math.min(4, (context.currentChapterLevel ?? 0) + 1);
		return 0;
	}
	function getNativeTocRawIndent(node) {
		const target = node.closest("a,button,[role=\"button\"],[class*=\"item\"],[class*=\"chapter\"]") || node;
		try {
			const style = getComputedStyle(target);
			return Math.max(0, (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.marginLeft) || 0));
		} catch {
			return 0;
		}
	}
	function isNativeTocLocked(node) {
		const row = node.closest("li,[class*=\"chapter\"],[class*=\"item\"]") || node;
		if (row.matches("[disabled],[aria-disabled=\"true\"],[data-locked=\"1\"],[data-lock=\"1\"]")) return true;
		if (row.querySelector("[class*=\"lock\"],[class*=\"Lock\"],[aria-label*=\"锁\"],[title*=\"锁\"]")) return true;
		const classText = [row, ...Array.from(row.querySelectorAll("[class]")).slice(0, 24)].map((item) => item.getAttribute("class") || "").join(" ").toLowerCase();
		if (/(^|[\s_-])locked?([\s_-]|$)/.test(classText)) return true;
		const hint = cleanText(`${row.getAttribute("aria-label") || ""} ${row.getAttribute("title") || ""}`);
		return /锁定|未购买|需购买|付费章节/.test(hint);
	}
	function normalizeTocLevels(items) {
		if (!items.length) return items;
		const explicitValues = items.filter((item) => Number.isFinite(item.level)).map((item) => item.level);
		const explicitUseful = [...new Set(explicitValues)].length > 1;
		const explicitMin = explicitUseful ? Math.min(...explicitValues) : 0;
		const indents = [...new Set(items.map((item) => Math.round(item.rawIndent || 0)).filter((value) => value > 0))].sort((a, b) => a - b);
		const hasVolume = items.some((item) => isTocVolumeTitle(item.title));
		let seenChapter = false;
		let currentChapterLevel = hasVolume ? 1 : 0;
		return items.map((item) => {
			let level = explicitUseful ? item.level - explicitMin : null;
			if (level == null && (item.rawIndent || 0) > 0 && indents.length > 1) {
				let nearestIndex = 0;
				let nearestDistance = Infinity;
				indents.forEach((value, index) => {
					const distance = Math.abs(value - (item.rawIndent || 0));
					if (distance < nearestDistance) {
						nearestIndex = index;
						nearestDistance = distance;
					}
				});
				level = nearestIndex;
			}
			if (level == null) {
				if (isTocChapterTitle(item.title)) {
					seenChapter = true;
					currentChapterLevel = hasVolume ? 1 : 0;
				}
				level = inferTocLevelFromTitle(item.title, {
					hasVolume,
					seenChapter,
					currentChapterLevel
				});
			}
			return {
				...item,
				level: Math.max(0, Math.min(4, Number(level) || 0))
			};
		});
	}
	function collectNativeTocItems() {
		const panel = getNativeTocPanel();
		if (!panel) {
			console.info(`${TOC_LOG} native catalog panel not found`);
			return [];
		}
		const candidates = [...panel.querySelectorAll(".readerCatalog_list_item")];
		const seen = /* @__PURE__ */ new Set();
		const items = [];
		for (const node of candidates) {
			const title = cleanText(node.querySelector(".readerCatalog_list_item_title_text")?.textContent || node.getAttribute("title") || "");
			if (!title || title.length > 120 || [
				"目录",
				"关闭",
				"返回"
			].includes(title)) continue;
			const key = canonicalBookTitle(title);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			const nativeLevel = node.querySelector(".readerCatalog_list_item_inner")?.className.match(/readerCatalog_list_item_level_(\d+)/)?.[1];
			const dataLevel = [
				node.getAttribute("data-level"),
				node.getAttribute("data-depth"),
				nativeLevel
			].filter((value) => value != null).map(Number).find(Number.isFinite);
			const locked = isNativeTocLocked(node);
			items.push({
				title,
				href: getActionHref(node),
				chapterUid: extractChapterUid(node),
				level: Number.isFinite(dataLevel) ? Number(dataLevel) : 0,
				rawIndent: getNativeTocRawIndent(node),
				node,
				locked,
				lockSource: locked ? "native" : void 0
			});
			if (items.length >= 300) break;
		}
		console.info(`${TOC_LOG} native catalog collected`, {
			count: items.length,
			locked: items.filter((item) => item.locked).length,
			withUid: items.filter((item) => item.chapterUid).length,
			withHref: items.filter((item) => item.href).length
		});
		return normalizeTocLevels(items);
	}
	async function fetchOfficialReaderToc() {
		if (state.readerOfficialToc.length) return state.readerOfficialToc;
		if (state.readerOfficialTocPromise) return state.readerOfficialTocPromise;
		const bookId = getReaderBookId();
		if (!bookId) {
			console.warn(`${TOC_LOG} cannot request chapterInfos: bookId not found`, {
				href: location.href,
				bookHash: getReaderBookHash(),
				meta: getReaderMeta()
			});
			return [];
		}
		console.info(`${TOC_LOG} requesting chapterInfos`, { bookId });
		state.readerOfficialTocPromise = fetch("/web/book/chapterInfos", {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json;charset=UTF-8" },
			body: JSON.stringify({ bookIds: [bookId] })
		}).then((response) => {
			if (!response.ok) throw new Error(`chapterInfos ${response.status}`);
			return response.json();
		}).then((payload) => {
			const record = (Array.isArray(payload?.data) ? payload.data : [])[0] || payload?.data || payload || {};
			const chapters = record?.updated || record?.chapters || payload?.updated || payload?.chapters || [];
			state.readerOfficialToc = normalizeTocLevels(Array.isArray(chapters) ? chapters.map((chapter) => {
				const rawLevel = [
					chapter?.level,
					chapter?.depth,
					chapter?.indent,
					chapter?.chapterLevel,
					chapter?.hierarchy
				].map(Number).find(Number.isFinite);
				const price = Number(chapter?.price ?? 0);
				const paid = Number(chapter?.paid ?? 0);
				const locked = Number.isFinite(price) && price > 0 && paid !== 1;
				return {
					title: cleanText(chapter?.title || ""),
					chapterUid: String(chapter?.chapterUid ?? ""),
					chapterIdx: Number(chapter?.chapterIdx ?? -1),
					level: Number.isFinite(rawLevel) ? Number(rawLevel) : 0,
					price: Number.isFinite(price) ? price : 0,
					paid: Number.isFinite(paid) ? paid : 0,
					locked,
					lockSource: locked ? "official" : void 0
				};
			}).filter((chapter) => chapter.title && chapter.chapterUid) : []);
			console.info(`${TOC_LOG} chapterInfos ready`, {
				bookId,
				count: state.readerOfficialToc.length,
				locked: state.readerOfficialToc.filter((item) => item.locked).length,
				first: state.readerOfficialToc.slice(0, 3).map((item) => ({
					title: item.title,
					chapterUid: item.chapterUid,
					price: item.price,
					paid: item.paid,
					locked: item.locked
				}))
			});
			return state.readerOfficialToc;
		}).catch((error) => {
			console.warn(`${TOC_LOG} chapterInfos failed`, error);
			return [];
		}).finally(() => {
			state.readerOfficialTocPromise = null;
		});
		return state.readerOfficialTocPromise;
	}
	function getReaderTocStorageKey() {
		const hash = getReaderBookHash();
		if (hash) return `hash:${hash}`;
		const bookId = getReaderBookId();
		if (bookId) return `id:${bookId}`;
		const title = canonicalBookTitle(getReaderMeta().book);
		return title ? `title:${title}` : "unknown";
	}
	function tocItemStableKey(item, index) {
		return item.chapterUid ? `uid:${item.chapterUid}` : `title:${canonicalBookTitle(item.title)}|level:${item.level}|index:${index}`;
	}
	function getReaderCollapsedTocSet() {
		const values = state.readerTocCollapsedByBook[getReaderTocStorageKey()];
		return new Set(Array.isArray(values) ? values : []);
	}
	function saveReaderCollapsedTocSet(collapsed) {
		state.readerTocCollapsedByBook[getReaderTocStorageKey()] = [...collapsed];
		writeJson(STORAGE.readerTocCollapsed, state.readerTocCollapsedByBook);
	}
	function setReaderTocOpen(open) {
		state.readerTocOpen = open;
		writeBoolean(STORAGE.readerTocOpen, open);
	}
	function findActiveTocIndex(items, meta = getReaderMeta()) {
		const currentUid = resolveCurrentReaderChapterUid(items);
		if (currentUid) {
			const byUid = items.findIndex((item) => String(item.chapterUid || "") === currentUid);
			if (byUid >= 0) return byUid;
		}
		const wanted = canonicalBookTitle(meta.chapter);
		return wanted ? items.findIndex((item) => canonicalBookTitle(item.title) === wanted) : -1;
	}
	function hasTocChildren(items, index) {
		if (index >= items.length - 1) return false;
		return (items[index + 1]?.level || 0) > (items[index]?.level || 0);
	}
	function ensureActiveTocAncestorsExpanded(items, meta = getReaderMeta()) {
		const activeIndex = findActiveTocIndex(items, meta);
		if (activeIndex <= 0) return false;
		const collapsed = getReaderCollapsedTocSet();
		let level = items[activeIndex]?.level || 0;
		let changed = false;
		for (let index = activeIndex - 1; index >= 0 && level > 0; index -= 1) {
			const parentLevel = items[index]?.level || 0;
			if (parentLevel >= level) continue;
			if (collapsed.delete(tocItemStableKey(items[index], index))) changed = true;
			level = parentLevel;
		}
		if (changed) saveReaderCollapsedTocSet(collapsed);
		return changed;
	}
	function toggleReaderTocGroup(index) {
		const items = state.readerTocItems;
		if (!items[index] || !hasTocChildren(items, index)) return;
		const collapsed = getReaderCollapsedTocSet();
		const key = tocItemStableKey(items[index], index);
		if (collapsed.has(key)) collapsed.delete(key);
		else collapsed.add(key);
		saveReaderCollapsedTocSet(collapsed);
	}
	function scrollReaderTocToActive(behavior = "auto") {
		if (!state.readerTocOpen || !state.root) return;
		nextFrame(() => {
			const outline = state.root?.querySelector(".wrf-reader-outline");
			const active = state.root?.querySelector(".wrf-outline-row.active");
			if (!(outline instanceof HTMLElement) || !(active instanceof HTMLElement)) return;
			const top = active.offsetTop;
			const bottom = top + active.offsetHeight;
			if (top >= outline.scrollTop + 24 && bottom <= outline.scrollTop + outline.clientHeight - 24) return;
			outline.scrollTo({
				top: Math.max(0, top - outline.clientHeight * .38),
				behavior
			});
		});
	}
	async function primeReaderToc(onUpdated) {
		if (state.readerTocItems.length) {
			ensureActiveTocAncestorsExpanded(state.readerTocItems);
			onUpdated?.();
			scrollReaderTocToActive();
			return;
		}
		const existing = collectNativeTocItems();
		if (existing.length) {
			state.readerTocItems = existing;
			ensureActiveTocAncestorsExpanded(state.readerTocItems);
			console.info(`${TOC_LOG} using native catalog already in DOM`, { count: existing.length });
			onUpdated?.();
			scrollReaderTocToActive();
			return;
		}
		const official = await fetchOfficialReaderToc();
		if (!state.enabled || state.page !== "reader") return;
		if (official.length) {
			state.readerTocItems = official;
			ensureActiveTocAncestorsExpanded(state.readerTocItems);
			onUpdated?.();
			scrollReaderTocToActive();
			return;
		}
		const opened = clickNative("catalog");
		console.info(`${TOC_LOG} opening native catalog for discovery`, { opened });
		if (!opened) return;
		await new Promise((resolve) => window.setTimeout(resolve, 220));
		const items = collectNativeTocItems();
		clickNative("catalog");
		if (items.length) {
			state.readerTocItems = items;
			ensureActiveTocAncestorsExpanded(items);
			console.info(`${TOC_LOG} using native catalog after opening`, { count: items.length });
			onUpdated?.();
			scrollReaderTocToActive();
		}
	}
	function scheduleReaderTocPrimeRetry(onUpdated) {
		window.clearTimeout(state.readerTocPrimeTimer);
		if (!state.enabled || state.page !== "reader" || state.readerTocItems.length || state.readerTocPrimeAttempts >= 8) return;
		state.readerTocPrimeTimer = window.setTimeout(async () => {
			state.readerTocPrimeAttempts += 1;
			await primeReaderToc(onUpdated);
			if (!state.readerTocItems.length) scheduleReaderTocPrimeRetry(onUpdated);
		}, Math.min(1200, 160 + state.readerTocPrimeAttempts * 130));
	}
	//#endregion
	//#region src/ui/icons.ts
	function icon(name, size = 18) {
		return `<svg ${`width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`}>${{
			home: "<path d=\"M3 11.5 12 4l9 7.5\"/><path d=\"M5.5 10.5V20h13v-9.5\"/><path d=\"M9.5 20v-6h5v6\"/>",
			shelf: "<path d=\"M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z\"/><path d=\"M4 5.5v16\"/><path d=\"M8 7h8\"/>",
			search: "<circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"m20 20-4-4\"/>",
			catalog: "<path d=\"M4 6h16M4 12h16M4 18h16\"/>",
			note: "<path d=\"M5 4h14v16H5z\"/><path d=\"M8 8h8M8 12h8M8 16h5\"/>",
			recent: "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7v5l3 2\"/>",
			rank: "<path d=\"M5 20V10M12 20V4M19 20v-7\"/>",
			menu: "<path d=\"M4 7h16M4 12h16M4 17h16\"/>",
			share: "<circle cx=\"18\" cy=\"5\" r=\"2\"/><circle cx=\"6\" cy=\"12\" r=\"2\"/><circle cx=\"18\" cy=\"19\" r=\"2\"/><path d=\"m8 11 8-5M8 13l8 5\"/>",
			dots: "<circle cx=\"5\" cy=\"12\" r=\"1\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"12\" cy=\"12\" r=\"1\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"19\" cy=\"12\" r=\"1\" fill=\"currentColor\" stroke=\"none\"/>",
			chevron: "<path d=\"m9 6 6 6-6 6\"/>",
			eye: "<path d=\"M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z\"/><circle cx=\"12\" cy=\"12\" r=\"2.5\"/>",
			edit: "<path d=\"M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16v4Z\"/><path d=\"m13.5 6.5 4 4\"/>",
			bell: "<path d=\"M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7\"/><path d=\"M10 19h4\"/>",
			plus: "<path d=\"M12 5v14M5 12h14\"/>",
			lock: "<rect x=\"6.5\" y=\"10\" width=\"11\" height=\"9\" rx=\"2\"/><path d=\"M9 10V7.5a3 3 0 0 1 6 0V10\"/>"
		}[name]}</svg>`;
	}
	function larkLogo() {
		return "<span class=\"wrf-logo\" aria-hidden=\"true\"><i class=\"wrf-logo-a\"></i><i class=\"wrf-logo-b\"></i><i class=\"wrf-logo-c\"></i><i class=\"wrf-logo-d\"></i></span>";
	}
	//#endregion
	//#region src/ui/sidebar.ts
	function pinnedBooksHtml(books) {
		const seen = /* @__PURE__ */ new Set();
		return books.filter((book) => book.category === "最近热搜" || book.category === "大家都在看").filter((book) => {
			const key = canonicalBookTitle(book.title);
			if (!key || seen.has(key)) return false;
			seen.add(key);
			return true;
		}).slice(0, 8).map((book) => `
      <button class="wrf-nav-item" data-action="open-book" data-href="${escapeHtml(book.href)}" title="${escapeHtml(book.title)}">
        ${icon("note")}<span>${escapeHtml(book.title)}</span>
      </button>`).join("");
	}
	function sidebarHtml(page, books, version) {
		const reader = page === "reader";
		const pinned = pinnedBooksHtml(books);
		return `
    <aside class="wrf-sidebar">
      <div class="wrf-brand">${larkLogo()}<span>飞书云文档</span></div>
      <div class="wrf-search" data-action="search">${icon("search", 16)}<span>搜索</span></div>
      <nav class="wrf-nav">
        <button class="wrf-nav-item ${reader ? "" : "active"}" data-action="home">${icon("home")}<span>主页</span></button>
        <button class="wrf-nav-item" data-action="shelf">${icon("shelf")}<span>云盘</span></button>
        ${reader ? `<button class="wrf-nav-item active" data-action="toc-toggle">${icon("catalog")}<span>目录</span></button>` : ""}
        ${reader ? `<button class="wrf-nav-item" data-action="note">${icon("note")}<span>知识库</span></button>` : `<button class="wrf-nav-item" data-action="recent">${icon("recent")}<span>知识库</span></button>`}
        ${reader ? "" : `<button class="wrf-nav-item" data-action="rank">${icon("rank")}<span>智能纪要</span></button>`}
      </nav>
      <div class="wrf-section-title">置顶文档</div>
      <nav class="wrf-nav">${pinned || "<div class=\"wrf-version\">暂无置顶文档</div>"}</nav>
      <div class="wrf-spacer"></div>
      <div class="wrf-version">WeRead Feishu UI · v${version}</div>
    </aside>`;
	}
	//#endregion
	//#region src/ui/topbar.ts
	function homeTopbarHtml() {
		return `
    <header class="wrf-topbar">
      <div class="wrf-breadcrumb"><span class="wrf-home-title">主页</span></div>
      <div class="wrf-top-actions">
        <button class="wrf-btn wrf-icon-btn" data-action="search" title="搜索">${icon("search", 17)}</button>
        <button class="wrf-btn wrf-icon-btn" data-action="share" title="复制页面链接">${icon("share", 17)}</button>
        <button class="wrf-btn wrf-icon-btn" data-action="more" title="更多">${icon("dots", 18)}</button>
      </div>
    </header>`;
	}
	function readerTopbarHtml(meta) {
		return `
    <header class="wrf-topbar">
      <div class="wrf-breadcrumb">
        <span class="strong">${escapeHtml(meta.book)}</span>${icon("chevron", 13)}
        <span class="strong" style="font-weight:400;color:#646a73">${escapeHtml(meta.chapter)}</span>
      </div>
      <div class="wrf-top-actions">
        <button class="wrf-btn primary" data-action="share">${icon("share", 15)}<span>分享</span></button>
        <button class="wrf-btn">${icon("edit", 15)}<span>编辑⌄</span></button>
        <button class="wrf-btn wrf-icon-btn" data-action="note" title="通知 / 笔记">${icon("bell", 17)}</button>
        <button class="wrf-btn wrf-icon-btn" data-action="more" title="更多">${icon("dots", 18)}</button>
        <span class="wrf-top-divider"></span>
        <button class="wrf-btn wrf-icon-btn" data-action="search" title="搜索">${icon("search", 17)}</button>
        <button class="wrf-btn wrf-icon-btn" title="新建">${icon("plus", 18)}</button>
        <span class="wrf-avatar-dot">阅</span>
      </div>
    </header>`;
	}
	function moreMenuHtml() {
		return `
    <div class="wrf-more-menu" data-more-menu>
      <button class="wrf-more-item" data-action="note">笔记</button>
      <button class="wrf-more-item" data-action="font">阅读设置</button>
      <button class="wrf-more-item" data-action="toggle-native">切回微信读书原界面 <span class="wrf-more-shortcut">Alt+F</span></button>
    </div>`;
	}
	//#endregion
	//#region src/ui/reader-view.ts
	function outlineHtml(meta, items, open, collapsed, activeIndex) {
		if (!items.length) return `<aside class="wrf-reader-outline ${open ? "" : "hidden"}"><div class="wrf-outline-title">目录</div><div class="wrf-outline-empty">正在读取目录…</div></aside>`;
		const collapsedAncestors = [];
		const rows = [];
		items.forEach((item, index) => {
			const level = Math.max(0, Math.min(4, Number(item.level) || 0));
			while (collapsedAncestors.length && level <= collapsedAncestors[collapsedAncestors.length - 1].level) collapsedAncestors.pop();
			const hiddenByAncestor = collapsedAncestors.length > 0;
			const hasChildren = hasTocChildren(items, index);
			const key = tocItemStableKey(item, index);
			const isCollapsed = hasChildren && collapsed.has(key);
			const locked = Boolean(item.locked);
			if (!hiddenByAncestor) {
				const fold = hasChildren ? `<button class="wrf-outline-fold ${isCollapsed ? "collapsed" : ""}" data-action="toc-fold" data-toc-index="${index}" aria-label="${isCollapsed ? "展开" : "收起"} ${escapeHtml(item.title)}">${icon("chevron", 13)}</button>` : `<span class="wrf-outline-fold placeholder">${icon("chevron", 13)}</span>`;
				const itemTitle = locked ? `${item.title}（已锁定）` : item.title;
				rows.push(`
        <div class="wrf-outline-row ${index === activeIndex ? "active" : ""} ${locked ? "locked" : ""}" data-toc-index="${index}" data-level="${level}" style="--wrf-toc-level:${level}">
          ${fold}<button class="wrf-outline-item" data-action="toc-item" data-toc-index="${index}" title="${escapeHtml(itemTitle)}" ${locked ? "disabled aria-disabled=\"true\"" : ""}>${escapeHtml(item.title)}</button>${locked ? `<span class="wrf-outline-lock" title="该章节在微信读书中处于锁定状态">${icon("lock", 13)}</span>` : ""}
        </div>`);
			}
			if (isCollapsed) collapsedAncestors.push({
				level,
				index
			});
		});
		return `<aside class="wrf-reader-outline ${open ? "" : "hidden"}"><div class="wrf-outline-title">目录</div>${rows.join("")}</aside>`;
	}
	function readerViewHtml(args) {
		const { meta, blocks, tocItems, tocOpen, collapsed, activeIndex, pinnedBooks, version } = args;
		const tooltip = tocOpen ? "收起目录" : "展开目录";
		return `
    <div class="wrf-shell wrf-reader-shell">
      ${sidebarHtml("reader", pinnedBooks, version)}
      ${readerTopbarHtml(meta)}
      ${moreMenuHtml()}
      ${outlineHtml(meta, tocItems, tocOpen, collapsed, activeIndex)}
      <button class="wrf-toc-toggle ${tocOpen ? "open" : ""}" data-action="toc-toggle" data-tooltip="${tooltip}" aria-label="${tooltip}">${icon("catalog", 18)}</button>
      <main class="wrf-reader-main ${tocOpen ? "with-outline" : ""}" data-reader-main>
        <article class="wrf-article">
          <h1 class="wrf-article-title">${escapeHtml(meta.chapter)}</h1>
          <div class="wrf-article-meta"><span>${escapeHtml(meta.author)}</span><span>·</span><span>${escapeHtml(meta.book)}</span></div>
          <div class="wrf-article-divider"></div>
          <div class="wrf-article-body" data-reader-body>${readerBlocksHtml(blocks)}</div>
        </article>
      </main>
    </div>`;
	}
	function nativeReturnViewHtml() {
		return "<div class=\"wrf-shell\"><button class=\"wrf-native-return\" data-action=\"return-feishu\" title=\"也可以按 Alt+F\">返回飞书模式</button></div>";
	}
	//#endregion
	//#region src/styles/native.css?inline
	var native_default = "html.wrf-enabled,html.wrf-enabled body{background:#fff!important}html.wrf-enabled body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",Arial,sans-serif!important}\nhtml.wrf-enabled[data-wrf-page=\"home\"] body{overflow:hidden!important}html.wrf-enabled[data-wrf-page=\"home\"] #routerView,html.wrf-enabled[data-wrf-page=\"home\"] .wr_header,html.wrf-enabled[data-wrf-page=\"home\"] .wr_navBar,html.wrf-enabled[data-wrf-page=\"home\"] .wr_index_page_header{display:none!important}\nhtml.wrf-enabled[data-wrf-page=\"reader\"] body{background:#fff!important}html.wrf-enabled[data-wrf-page=\"reader\"] .readerTopBar{display:none!important}html.wrf-enabled[data-wrf-page=\"reader\"] .readerContent{box-sizing:border-box!important;margin-left:0!important;width:100%!important;padding-top:58px!important;background:#fff!important}html.wrf-enabled[data-wrf-page=\"reader\"] .readerContent .app_content,html.wrf-enabled[data-wrf-page=\"reader\"] .app_content:not(#routerView){box-sizing:border-box!important;opacity:0!important;pointer-events:none!important;user-select:none!important;max-width:1040px!important;width:min(1040px,calc(100vw - 120px))!important;margin-left:auto!important;margin-right:auto!important;padding-left:72px!important;padding-right:72px!important;background:#fff!important}html.wrf-enabled[data-wrf-page=\"reader\"] .readerControls{opacity:0!important;pointer-events:none!important}html.wrf-enabled[data-wrf-page=\"reader\"] .readerCatalog,html.wrf-enabled[data-wrf-page=\"reader\"] .readerNotePanel{z-index:999995!important;top:58px!important;bottom:0!important;border-radius:0!important;border:0!important;background:#fff!important}html.wrf-enabled[data-wrf-page=\"reader\"] .readerNotePanel{z-index:1000010!important}html.wrf-enabled[data-wrf-page=\"reader\"] .wr_mask{z-index:999991!important}\n@media(max-width:1100px){html.wrf-enabled[data-wrf-page=\"reader\"] .readerContent .app_content,html.wrf-enabled[data-wrf-page=\"reader\"] .app_content:not(#routerView){width:min(900px,calc(100vw - 48px))!important;padding-left:24px!important;padding-right:24px!important}}\n";
	//#endregion
	//#region src/styles/native-toc.css?inline
	var native_toc_default = "/* Real Vue-owned rows receive input; the shadow DOM supplies the visuals. */\nhtml.wrf-enabled[data-wrf-page=\"reader\"] [data-wrf-native-hit-panel] {\n  display: block !important;\n  visibility: visible !important;\n  position: fixed !important;\n  inset: 0 !important;\n  margin: 0 !important;\n  width: 100vw !important;\n  height: 100vh !important;\n  max-width: none !important;\n  max-height: none !important;\n  transform: none !important;\n  overflow: visible !important;\n  opacity: 0 !important;\n  pointer-events: none !important;\n  z-index: 1000002 !important;\n}\nhtml.wrf-enabled [data-wrf-native-hit-panel] * {\n  pointer-events: none !important;\n  visibility: hidden !important;\n}\nhtml.wrf-enabled [data-wrf-native-hit-path] {\n  display: block !important;\n  overflow: visible !important;\n  transform: none !important;\n  contain: none !important;\n}\nhtml.wrf-enabled [data-wrf-native-hit] {\n  display: block !important;\n  position: fixed !important;\n  left: var(--wrf-hit-left) !important;\n  top: var(--wrf-hit-top) !important;\n  width: var(--wrf-hit-width) !important;\n  height: var(--wrf-hit-height) !important;\n  min-height: 0 !important;\n  max-height: none !important;\n  box-sizing: border-box !important;\n  margin: 0 !important;\n  padding: 0 !important;\n  border: 0 !important;\n  transform: none !important;\n  overflow: hidden !important;\n}\nhtml.wrf-enabled [data-wrf-native-hit] .readerCatalog_list_item_inner {\n  visibility: visible !important;\n  pointer-events: auto !important;\n  position: absolute !important;\n  inset: 0 !important;\n  width: 100% !important;\n  height: 100% !important;\n  min-height: 0 !important;\n  max-height: none !important;\n  margin: 0 !important;\n  padding: 0 !important;\n  border: 0 !important;\n  cursor: pointer !important;\n}\n";
	//#endregion
	//#region src/styles/tokens.css?inline
	var tokens_default = ":host { all: initial; }\n.wrf-shell {\n  --wrf-text: #1f2329;\n  --wrf-muted: #8f959e;\n  --wrf-line: #e5e6eb;\n  --wrf-hover: #f2f3f5;\n  --wrf-blue: #3370ff;\n  --wrf-side: #f5f6f7;\n  --wrf-sidebar-width: 208px;\n}\n";
	//#endregion
	//#region src/styles/common.css?inline
	var common_default = "* { box-sizing: border-box; }\nbutton, input { font: inherit; }\nbutton { color: inherit; }\n.wrf-shell {\n  position: fixed; inset: 0; pointer-events: none;\n  font-family: -apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif;\n  color: var(--wrf-text);\n}\n.wrf-sidebar {\n  position: absolute; inset: 0 auto 0 0; width: var(--wrf-sidebar-width);\n  background: var(--wrf-side); border-right: 1px solid #ebecef; pointer-events: auto;\n  padding: 12px 8px 18px; z-index: 6; display:flex; flex-direction:column;\n}\n.wrf-brand { height:38px; display:flex; align-items:center; gap:10px; padding:0 10px 8px; font-weight:600; font-size:15px; }\n.wrf-logo { width:24px; height:24px; position:relative; display:inline-block; flex:0 0 auto; }\n.wrf-logo i { position:absolute; width:9px; height:9px; border-radius:3px; transform:rotate(12deg); }\n.wrf-logo-a{left:2px;top:2px;background:#2b74ff}.wrf-logo-b{right:2px;top:2px;background:#20c2da}.wrf-logo-c{left:2px;bottom:2px;background:#7b67ee}.wrf-logo-d{right:2px;bottom:2px;background:#36cfc9}\n.wrf-search { height:34px; display:flex; align-items:center; gap:8px; margin:8px 2px 12px; padding:0 11px; background:#fff; color:#8f959e; border:1px solid #e1e3e6; border-radius:6px; cursor:pointer; }\n.wrf-nav { display:flex; flex-direction:column; gap:2px; }\n.wrf-nav-item { width:100%; min-height:38px; border:0; border-radius:6px; background:transparent; padding:0 11px; display:flex; align-items:center; gap:10px; cursor:pointer; font-size:14px; color:#4e5969; text-align:left; }\n.wrf-nav-item:hover{background:#ebecef}.wrf-nav-item.active{background:#e1e9ff;color:#245bdb}.wrf-nav-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.wrf-section-title { padding:20px 12px 8px; color:#8f959e; font-size:12px; }\n.wrf-spacer { flex:1; }.wrf-version{color:#bbbfc4;font-size:11px;padding:8px 12px 0}\n.wrf-topbar { position:absolute; top:0; left:var(--wrf-sidebar-width); right:0; height:58px; display:flex; align-items:center; gap:12px; padding:0 22px; background:rgba(255,255,255,.96); border-bottom:1px solid #eceef1; backdrop-filter:blur(12px); pointer-events:auto; z-index:5; }\n.wrf-breadcrumb{min-width:0;flex:1;display:flex;align-items:center;gap:8px;font-size:14px;color:#646a73}.wrf-breadcrumb .strong{max-width:460px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:#1f2329}\n.wrf-top-actions{display:flex;align-items:center;gap:8px}.wrf-btn{height:32px;border:0;border-radius:6px;background:transparent;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 10px;cursor:pointer;font-size:13px;color:#4e5969}.wrf-btn:hover{background:var(--wrf-hover)}.wrf-btn.primary{background:var(--wrf-blue);color:white;padding-inline:14px}.wrf-icon-btn{width:32px;padding:0;border-radius:50%}.wrf-top-divider{width:1px;height:20px;background:#e5e6eb}.wrf-avatar-dot{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:#e8edff;color:#245bdb;font-size:12px;font-weight:600}\n.wrf-more-menu{display:none;position:absolute;right:12px;top:52px;width:220px;padding:6px;background:#fff;border:1px solid #e5e6eb;border-radius:8px;box-shadow:0 10px 32px rgba(31,35,41,.14);z-index:30;pointer-events:auto}.wrf-more-menu.open{display:block}.wrf-more-item{width:100%;height:34px;border:0;background:transparent;border-radius:5px;padding:0 10px;text-align:left;cursor:pointer;font-size:13px}.wrf-more-item:hover{background:#f5f6f7}.wrf-more-shortcut{float:right;color:#8f959e}\n.wrf-toast{position:fixed;left:50%;top:72px;transform:translateX(-50%);pointer-events:none;z-index:99;background:#1f2329;color:white;padding:9px 14px;border-radius:7px;font-size:13px;box-shadow:0 7px 24px rgba(0,0,0,.18)}\n.wrf-native-return{position:fixed;right:18px;top:14px;height:34px;padding:0 14px;border:1px solid #d9dde3;border-radius:7px;background:#fff;color:#245bdb;font-size:13px;font-weight:500;cursor:pointer;pointer-events:auto;box-shadow:0 4px 16px rgba(31,35,41,.10);z-index:99}\n@media(max-width:1100px){.wrf-shell{--wrf-sidebar-width:72px}.wrf-sidebar{align-items:center;padding-inline:7px}.wrf-brand{padding:0 0 8px;justify-content:center}.wrf-brand span:last-child,.wrf-search span,.wrf-nav-item span,.wrf-section-title,.wrf-version{display:none}.wrf-search{width:42px;justify-content:center;padding:0}.wrf-nav{width:100%}.wrf-nav-item{justify-content:center;padding:0}}\n";
	//#endregion
	//#region src/styles/home.css?inline
	var home_default = ".wrf-home-main{position:absolute;top:58px;left:var(--wrf-sidebar-width);right:0;bottom:0;overflow:auto;background:#fff;pointer-events:auto}.wrf-home-inner{width:min(1180px,calc(100% - 64px));margin:0 auto;padding:28px 0 72px}.wrf-home-title{font-weight:650;font-size:18px;color:#1f2329}\n.wrf-quick-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;max-width:760px;margin-bottom:28px}.wrf-quick-card{height:76px;border:1px solid #dee1e6;border-radius:8px;background:#fff;display:flex;align-items:center;gap:12px;padding:0 18px;cursor:pointer;text-align:left}.wrf-quick-card:hover{background:#fafbfc;border-color:#cfd3da;box-shadow:0 3px 10px rgba(31,35,41,.05)}.wrf-quick-icon{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;flex:0 0 auto;background:#eef3ff;color:#3370ff}.wrf-quick-card:nth-child(2) .wrf-quick-icon{background:#fff3e8;color:#ff8800}.wrf-quick-card:nth-child(3) .wrf-quick-icon{background:#f3efff;color:#7b67ee}.wrf-quick-copy{min-width:0}.wrf-quick-title{font-size:14px;font-weight:600;color:#1f2329}.wrf-quick-desc{margin-top:3px;font-size:12px;color:#8f959e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.wrf-home-tabs{height:42px;display:flex;align-items:flex-end;gap:28px;border-bottom:1px solid #ebecef;margin-bottom:10px}.wrf-home-tab{position:relative;height:42px;padding:0 1px;border:0;background:transparent;color:#646a73;font-size:14px;cursor:pointer}.wrf-home-tab.active{color:#3370ff;font-weight:500}.wrf-home-tab.active::after{content:\"\";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:#3370ff;border-radius:2px}.wrf-list-toolbar{height:44px;display:flex;align-items:center;justify-content:flex-end;gap:8px}.wrf-ghost-action{height:30px;border:0;background:transparent;border-radius:6px;padding:0 9px;color:#646a73;cursor:pointer;font-size:12px}.wrf-ghost-action:hover{background:#f2f3f5}\n.wrf-doc-table{width:100%;border-collapse:collapse;table-layout:fixed}.wrf-doc-table th{height:38px;border-bottom:1px solid #ebecef;color:#8f959e;font-size:12px;font-weight:400;text-align:left;padding:0 12px}.wrf-doc-table td{height:52px;border-bottom:1px solid #f0f1f2;color:#4e5969;font-size:13px;padding:0 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wrf-doc-row{cursor:pointer}.wrf-doc-row:hover td{background:#f7f8fa}.wrf-doc-title-cell{display:flex;align-items:center;gap:10px;min-width:0;height:52px}.wrf-file-icon{width:20px;height:24px;border-radius:4px;background:#3370ff;flex:0 0 auto;position:relative}.wrf-file-icon::before,.wrf-file-icon::after{content:\"\";position:absolute;left:5px;right:5px;height:1px;background:rgba(255,255,255,.85)}.wrf-file-icon::before{top:9px}.wrf-file-icon::after{top:13px}.wrf-doc-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#1f2329;font-weight:500}.wrf-doc-location{display:inline-flex;align-items:center;gap:5px;color:#8f959e}.wrf-avatar{width:24px;height:24px;border-radius:50%;display:inline-grid;place-items:center;background:#eef3ff;color:#245bdb;font-size:11px;margin-right:7px;vertical-align:middle}.wrf-empty{padding:58px 20px;text-align:center;color:#8f959e;font-size:13px}\n.wrf-home-searchbar{display:none;position:absolute;left:calc(var(--wrf-sidebar-width) + 16px);top:12px;width:min(520px,calc(100vw - 620px));height:34px;z-index:9;pointer-events:auto}.wrf-home-searchbar.open{display:block}.wrf-home-searchbar input{width:100%;height:100%;border:1px solid #c9cdd4;outline:0;border-radius:7px;padding:0 12px 0 34px;color:#1f2329;background:#fff;box-shadow:0 4px 14px rgba(31,35,41,.08);font-size:13px}.wrf-home-searchbar svg{position:absolute;left:10px;top:8px;color:#8f959e}\n@media(max-width:1100px){.wrf-home-inner{width:min(calc(100% - 28px),980px)}.wrf-quick-actions{grid-template-columns:1fr;max-width:none}.wrf-home-searchbar{width:calc(100vw - 190px)}}\n";
	//#endregion
	//#region src/styles/reader.css?inline
	var reader_default = ".wrf-reader-shell .wrf-topbar{left:var(--wrf-sidebar-width)}.wrf-reader-main{position:absolute;top:58px;left:var(--wrf-sidebar-width);right:0;bottom:0;overflow:auto;background:#fff;pointer-events:auto;z-index:3;transition:left .16s ease}.wrf-reader-main.with-outline{left:calc(var(--wrf-sidebar-width) + 220px)}\n.wrf-article{width:min(760px,calc(100% - 96px));margin:0 auto;padding:54px 0 160px;color:#1f2329;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif}.wrf-article-title{margin:0;color:#1f2329;font-size:32px;line-height:1.32;font-weight:700;letter-spacing:-.02em}.wrf-article-meta{display:flex;align-items:center;gap:12px;margin:14px 0 24px;color:#8f959e;font-size:12px}.wrf-article-divider{height:1px;background:#f0f1f2;margin:0 0 28px}.wrf-article-body{font-size:16px;line-height:1.78;color:#1f2329}.wrf-md-p{margin:0 0 13px;white-space:pre-wrap;word-break:break-word}.wrf-md-h2{margin:34px 0 14px;font-size:23px;line-height:1.4;font-weight:700;letter-spacing:-.01em}.wrf-md-h3{margin:28px 0 12px;font-size:18px;line-height:1.45;font-weight:650}.wrf-md-quote{margin:16px 0;padding:2px 0 2px 13px;border-left:3px solid #c9cdd4;color:#646a73}.wrf-md-code{margin:16px 0;padding:14px 16px;border:1px solid #e5e6eb;border-radius:6px;background:#f5f6f7;color:#1f2329;font:13px/1.65 \"SFMono-Regular\",Consolas,\"Liberation Mono\",monospace;white-space:pre-wrap;overflow-wrap:anywhere}.wrf-article-loading{padding:40px 0;color:#8f959e;font-size:13px;line-height:1.8}\n@media(max-width:1100px){.wrf-article{width:min(760px,calc(100% - 44px));padding-top:38px}.wrf-reader-main.with-outline{left:calc(var(--wrf-sidebar-width) + 220px)}}\n";
	//#endregion
	//#region src/styles/toc.css?inline
	var toc_default = ".wrf-toc-toggle{position:absolute;left:calc(var(--wrf-sidebar-width) + 10px);top:74px;width:34px;height:34px;border:0;border-radius:7px;background:#fff;color:#3370ff;display:grid;place-items:center;cursor:pointer;pointer-events:auto;z-index:8;box-shadow:0 3px 12px rgba(31,35,41,.10);transition:left .16s ease}.wrf-toc-toggle.open{left:calc(var(--wrf-sidebar-width) + 228px)}.wrf-toc-toggle:hover{background:#f5f7ff}.wrf-toc-toggle::after{content:attr(data-tooltip);position:absolute;left:0;top:-36px;padding:7px 10px;border-radius:6px;background:#1f2329;color:#fff;font-size:12px;line-height:1;white-space:nowrap;opacity:0;transform:translateY(4px);pointer-events:none;transition:opacity .12s ease,transform .12s ease}.wrf-toc-toggle:hover::after{opacity:1;transform:translateY(0)}\n.wrf-reader-outline{position:absolute;top:58px;left:var(--wrf-sidebar-width);bottom:0;width:220px;background:#fff;border-right:1px solid #eceef1;pointer-events:auto;overflow:auto;z-index:4;padding:12px 8px 24px;transition:transform .16s ease,opacity .16s ease}.wrf-reader-outline.hidden{transform:translateX(-100%);opacity:0;pointer-events:none}.wrf-outline-title{padding:4px 10px 8px;color:#8f959e;font-size:12px;font-weight:500}.wrf-outline-row{width:100%;min-height:31px;border-radius:5px;display:flex;align-items:flex-start;padding-left:calc(6px + var(--wrf-toc-level,0)*16px);transition:background .12s ease}.wrf-outline-row:hover{background:#f5f6f7}.wrf-outline-row.active{background:#eef3ff}.wrf-outline-fold{width:18px;height:31px;flex:0 0 18px;border:0;padding:0;background:transparent;color:#8f959e;display:grid;place-items:center;cursor:pointer}.wrf-outline-fold svg{width:13px;height:13px;transition:transform .14s ease;transform:rotate(90deg)}.wrf-outline-fold.collapsed svg{transform:rotate(0deg)}.wrf-outline-fold.placeholder{visibility:hidden;pointer-events:none}.wrf-outline-fold:hover{color:#3370ff}.wrf-outline-item{min-width:0;flex:1;min-height:31px;border:0;background:transparent;color:#646a73;display:block;padding:6px 8px 5px 2px;text-align:left;cursor:pointer;font-size:12px;line-height:1.35;overflow:hidden;text-overflow:ellipsis}.wrf-outline-row[data-level=\"0\"] .wrf-outline-item{color:#3f4752;font-weight:600}.wrf-outline-row[data-level=\"1\"] .wrf-outline-item{color:#59636f;font-weight:500}.wrf-outline-row[data-level=\"2\"] .wrf-outline-item,.wrf-outline-row[data-level=\"3\"] .wrf-outline-item,.wrf-outline-row[data-level=\"4\"] .wrf-outline-item{color:#7a838d;font-size:11.5px}.wrf-outline-row.active .wrf-outline-item{color:#245bdb;font-weight:600}.wrf-outline-row.locked{opacity:.62}.wrf-outline-row.locked:hover{background:transparent}.wrf-outline-row.locked .wrf-outline-item{color:#8f959e!important;cursor:not-allowed}.wrf-outline-row.locked .wrf-outline-item:disabled{opacity:1}.wrf-outline-lock{width:22px;height:31px;flex:0 0 22px;color:#8f959e;display:grid;place-items:center}.wrf-outline-lock svg{width:13px;height:13px}.wrf-outline-empty{padding:14px 10px;color:#8f959e;font-size:12px;line-height:1.6}\n";
	//#endregion
	//#region src/ui/shell.ts
	var HOST_ID = "wr-feishu-ui-host";
	var STYLE_ID = "wr-feishu-ui-global-style";
	var shellCss = [
		tokens_default,
		common_default,
		home_default,
		reader_default,
		toc_default
	].join("\n");
	function ensureGlobalStyle() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement("style");
		style.id = STYLE_ID;
		style.textContent = `${native_default}\n${native_toc_default}`;
		(document.head || document.documentElement).appendChild(style);
	}
	function ensureHost() {
		if (state.root && state.host?.isConnected) return state.root;
		let host = document.getElementById(HOST_ID);
		if (!host) {
			host = document.createElement("div");
			host.id = HOST_ID;
			host.style.cssText = "position:fixed;inset:0;z-index:1000000;pointer-events:none;";
			(document.body || document.documentElement).appendChild(host);
		}
		const root = host.shadowRoot || host.attachShadow({ mode: "open" });
		state.host = host;
		state.root = root;
		return root;
	}
	function setShellHtml(html) {
		const root = ensureHost();
		root.innerHTML = `<style>${shellCss}</style>${html}`;
	}
	function hideHost() {
		if (state.host) state.host.style.display = "none";
	}
	function showHost() {
		if (state.host) state.host.style.display = "";
	}
	function toast(message) {
		if (!state.root) return;
		state.root.querySelector(".wrf-toast")?.remove();
		const element = document.createElement("div");
		element.className = "wrf-toast";
		element.textContent = message;
		state.root.appendChild(element);
		window.setTimeout(() => element.remove(), 1800);
	}
	//#endregion
	//#region src/pages/reader.ts
	function renderReader(version) {
		clearNativeTocHitTargets();
		const meta = getReaderMeta();
		const blocks = getReaderBlocks();
		if (state.readerTocItems.length) ensureActiveTocAncestorsExpanded(state.readerTocItems, meta);
		const activeIndex = findActiveTocIndex(state.readerTocItems, meta);
		setShellHtml(readerViewHtml({
			meta,
			blocks,
			tocItems: state.readerTocItems,
			tocOpen: state.readerTocOpen,
			collapsed: getReaderCollapsedTocSet(),
			activeIndex,
			pinnedBooks: state.pinnedBooks,
			version
		}));
		queueMicrotask(() => {
			syncNativeTocHitTargets();
		});
		if (state.readerTocOpen) queueMicrotask(() => {
			if (!state.readerTocItems.length) {
				primeReaderToc(() => renderReader(version));
				scheduleReaderTocPrimeRetry(() => renderReader(version));
			} else scrollReaderTocToActive();
		});
	}
	function refreshReaderMeta(version) {
		if (!state.root || state.page !== "reader") return;
		const meta = getReaderMeta();
		const parts = state.root.querySelectorAll(".wrf-breadcrumb .strong");
		if (parts[0] && parts[0].textContent !== meta.book) parts[0].textContent = meta.book;
		if (parts[1] && parts[1].textContent !== meta.chapter) parts[1].textContent = meta.chapter;
		const title = state.root.querySelector(".wrf-article-title");
		if (title && title.textContent !== meta.chapter) title.textContent = meta.chapter;
		if (!state.readerTocItems.length) return;
		if (ensureActiveTocAncestorsExpanded(state.readerTocItems, meta)) {
			renderReader(version);
			return;
		}
		const activeIndex = findActiveTocIndex(state.readerTocItems, meta);
		const previousActive = state.root.querySelector(".wrf-outline-row.active")?.getAttribute("data-toc-index");
		state.root.querySelectorAll(".wrf-outline-row").forEach((row) => {
			row.classList.toggle("active", Number(row.getAttribute("data-toc-index")) === activeIndex);
		});
		if (previousActive !== String(activeIndex)) scrollReaderTocToActive();
		syncNativeTocHitTargets();
	}
	function refreshReaderArticle() {
		if (!state.enabled || !state.root || state.page !== "reader") return;
		const body = state.root.querySelector("[data-reader-body]");
		if (!(body instanceof HTMLElement)) return;
		const blocks = getReaderBlocks();
		const signature = blocks.map((block) => `${block.type}:${block.text}`).join("|");
		if (!signature || signature === state.readerArticleSignature) return;
		state.readerArticleSignature = signature;
		const main = state.root.querySelector("[data-reader-main]");
		const scrollTop = main instanceof HTMLElement ? main.scrollTop : 0;
		body.innerHTML = readerBlocksHtml(blocks);
		if (main instanceof HTMLElement) main.scrollTop = scrollTop;
	}
	//#endregion
	//#region src/core/route.ts
	function detectPage(path = location.pathname) {
		if (path.startsWith("/web/reader/")) return "reader";
		if (path === "/" || path === "/web" || path.startsWith("/web/shelf") || path.startsWith("/web/search") || path.startsWith("/web/category")) return "home";
		return "none";
	}
	function patchHistory(onChange) {
		for (const method of ["pushState", "replaceState"]) {
			const original = history[method];
			if (original.__wrfPatched) continue;
			const wrapped = function(...args) {
				const result = original.apply(this, args);
				queueMicrotask(onChange);
				return result;
			};
			wrapped.__wrfPatched = true;
			history[method] = wrapped;
		}
		window.addEventListener("popstate", onChange, { passive: true });
	}
	//#endregion
	//#region src/ui/home-view.ts
	function initials(text = "") {
		return text.trim().slice(0, 1).toUpperCase() || "文";
	}
	function homeRowsHtml(books) {
		if (!books.length) return "<tr><td colspan=\"6\"><div class=\"wrf-empty\">正在读取微信读书首页内容…</div></td></tr>";
		return books.map((book, index) => `
    <tr class="wrf-doc-row" data-action="open-book" data-href="${escapeHtml(book.href)}">
      <td><div class="wrf-doc-title-cell"><span class="wrf-file-icon"></span><span class="wrf-doc-title">${escapeHtml(book.title)}</span></div></td>
      <td><span class="wrf-doc-location">${icon("shelf", 14)} ${escapeHtml(book.category || "其他")}</span></td>
      <td><span class="wrf-avatar">${escapeHtml(initials(book.author))}</span>${escapeHtml(book.author)}</td>
      <td>${index < 4 ? "今天" : "最近"}</td>
      <td>${index === 0 ? "刚刚" : `${Math.min(index + 1, 9)} 小时前`}</td>
      <td style="text-align:right;color:#8f959e">${icon("dots", 16)}</td>
    </tr>`).join("");
	}
	function homeViewHtml(books, pinnedBooks, version) {
		return `
    <div class="wrf-shell">
      ${sidebarHtml("home", pinnedBooks.length ? pinnedBooks : books, version)}
      ${homeTopbarHtml()}
      ${moreMenuHtml()}
      <div class="wrf-home-searchbar" data-searchbar>${icon("search", 17)}<input data-search-input type="text" placeholder="搜索文档、书籍" autocomplete="off" /></div>
      <main class="wrf-home-main">
        <div class="wrf-home-inner">
          <div class="wrf-quick-actions">
            <button class="wrf-quick-card" data-action="search"><span class="wrf-quick-icon">${icon("note", 19)}</span><span class="wrf-quick-copy"><span class="wrf-quick-title">新建</span><span class="wrf-quick-desc">搜索并打开一本书</span></span></button>
            <button class="wrf-quick-card" data-action="upload"><span class="wrf-quick-icon">${icon("shelf", 19)}</span><span class="wrf-quick-copy"><span class="wrf-quick-title">上传</span><span class="wrf-quick-desc">传书到手机或管理书架</span></span></button>
            <button class="wrf-quick-card" data-action="rank"><span class="wrf-quick-icon">${icon("rank", 19)}</span><span class="wrf-quick-copy"><span class="wrf-quick-title">模板库</span><span class="wrf-quick-desc">浏览微信读书榜单内容</span></span></button>
          </div>
          <div class="wrf-home-tabs"><button class="wrf-home-tab active">最近访问</button><button class="wrf-home-tab">归我所有</button><button class="wrf-home-tab">与我共享</button><button class="wrf-home-tab">收藏</button><button class="wrf-home-tab">＋</button></div>
          <div class="wrf-list-toolbar"><button class="wrf-ghost-action">筛选</button><button class="wrf-ghost-action">显示设置</button><button class="wrf-ghost-action">☰</button><button class="wrf-ghost-action">▦</button></div>
          <table class="wrf-doc-table"><colgroup><col style="width:36%"><col style="width:18%"><col style="width:16%"><col style="width:12%"><col style="width:14%"><col style="width:4%"></colgroup><thead><tr><th>标题</th><th>位置</th><th>所有者</th><th>创建时间</th><th>最近访问 ↓</th><th></th></tr></thead><tbody>${homeRowsHtml(books)}</tbody></table>
        </div>
      </main>
    </div>`;
	}
	//#endregion
	//#region src/pages/home.ts
	function updatePinnedBooks(books) {
		const seen = /* @__PURE__ */ new Set();
		const pinned = books.filter((book) => book.category === "最近热搜" || book.category === "大家都在看").filter((book) => {
			const key = book.title.trim().toLowerCase();
			if (!key || seen.has(key)) return false;
			seen.add(key);
			return true;
		}).slice(0, 8);
		if (!pinned.length) return;
		state.pinnedBooks = pinned;
		writeJson(STORAGE.pinnedBooks, pinned);
	}
	function renderHome(version) {
		const books = collectHomeBooks();
		state.homeDataSignature = homeDataSignature(books);
		updatePinnedBooks(books);
		setShellHtml(homeViewHtml(books, state.pinnedBooks, version));
		return books;
	}
	async function enrichAndRefreshHome(version, books) {
		if (!await enrichHomeBooks(books, state.metadataCache) || !state.enabled || state.page !== "home") return false;
		state.homeDataSignature = homeDataSignature(books);
		updatePinnedBooks(books);
		setShellHtml(homeViewHtml(books, state.pinnedBooks, version));
		return true;
	}
	function refreshHome(version) {
		if (!state.enabled || state.page !== "home") return null;
		const books = collectHomeBooks();
		const signature = homeDataSignature(books);
		if (signature === state.homeDataSignature) return null;
		state.homeDataSignature = signature;
		updatePinnedBooks(books);
		setShellHtml(homeViewHtml(books, state.pinnedBooks, version));
		return books;
	}
	//#endregion
	//#region src/router.ts
	var uiEventsBound = false;
	function triggerHomeSearch() {
		if (state.page === "home" && state.root) {
			state.root.querySelector("[data-searchbar]")?.classList.add("open");
			const input = state.root.querySelector("[data-search-input]");
			if (input instanceof HTMLInputElement) queueMicrotask(() => input.focus());
			return;
		}
		location.href = "https://weread.qq.com/";
	}
	function submitHomeSearch(keyword) {
		const value = cleanText(keyword);
		if (value) location.href = `https://weread.qq.com/web/search/books?keyword=${encodeURIComponent(value)}`;
	}
	async function shareCurrentPage() {
		try {
			await navigator.clipboard.writeText(location.href);
			toast("已复制当前页面链接");
		} catch {
			const area = document.createElement("textarea");
			area.value = location.href;
			area.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
			document.body.appendChild(area);
			area.select();
			try {
				document.execCommand("copy");
				toast("已复制当前页面链接");
			} catch {
				toast("复制失败，请手动复制地址栏链接。");
			}
			area.remove();
		}
	}
	function afterRender(version) {
		if (!state.root || state.page !== "reader" || !state.enabled) return;
		const readerMain = state.root.querySelector("[data-reader-main]");
		if (!(readerMain instanceof HTMLElement) || readerMain.dataset.wrfScrollBound === "1") return;
		readerMain.dataset.wrfScrollBound = "1";
		let syncing = false;
		readerMain.addEventListener("scroll", () => {
			if (syncing) return;
			syncing = true;
			requestAnimationFrame(() => {
				const overlayMax = Math.max(1, readerMain.scrollHeight - readerMain.clientHeight);
				const nativeMax = Math.max(0, document.documentElement.scrollHeight - innerHeight);
				if (nativeMax > 0) window.scrollTo(0, readerMain.scrollTop / overlayMax * nativeMax);
				syncing = false;
			});
		}, { passive: true });
		if (state.readerTocOpen) scrollReaderTocToActive();
	}
	function bindUiEvents(version) {
		if (uiEventsBound) return;
		const root = ensureHost();
		uiEventsBound = true;
		root.addEventListener("click", (event) => {
			const target = event.target?.closest("[data-action]");
			if (!target) return;
			switch (target.dataset.action) {
				case "home":
					location.href = "https://weread.qq.com/";
					break;
				case "shelf":
					location.href = "https://weread.qq.com/web/shelf";
					break;
				case "search":
					triggerHomeSearch();
					break;
				case "note":
					if (!clickNative("note")) toast("没有找到微信读书原生笔记按钮");
					break;
				case "font":
					if (!clickNative("font")) toast("没有找到微信读书原生阅读设置");
					break;
				case "open-book":
					if (target.dataset.href) location.href = target.dataset.href;
					break;
				case "upload":
					if (!clickNativeHomeText(["传书到手机", "上传"])) location.href = "https://weread.qq.com/web/shelf";
					break;
				case "recent":
					state.root?.querySelector(".wrf-home-main")?.scrollTo({
						top: 0,
						behavior: "smooth"
					});
					break;
				case "rank": {
					const native = queryByText([
						"a",
						"button",
						"[role=\"button\"]"
					], ["榜单"]);
					if (native instanceof HTMLElement) native.click();
					else toast("当前页面没有可打开的榜单入口");
					break;
				}
				case "share":
					shareCurrentPage();
					break;
				case "toggle-native":
					setEnabled(false, version);
					break;
				case "return-feishu":
					setEnabled(true, version);
					break;
				case "more":
					state.root?.querySelector("[data-more-menu]")?.classList.toggle("open");
					break;
				case "toc-toggle":
					setReaderTocOpen(!state.readerTocOpen);
					renderReader(version);
					afterRender(version);
					if (state.readerTocOpen && !state.readerTocItems.length) primeReaderToc(() => {
						renderReader(version);
						afterRender(version);
					});
					break;
				case "toc-fold": {
					const index = Number(target.dataset.tocIndex);
					if (Number.isInteger(index)) {
						toggleReaderTocGroup(index);
						renderReader(version);
						afterRender(version);
					}
					break;
				}
				case "toc-item": {
					const index = Number(target.dataset.tocIndex);
					const title = cleanText(target.textContent || "");
					if (!Number.isInteger(index)) return;
					navigateToReaderTocItem(index, title).then((ok) => {
						if (!ok) toast(`暂时无法跳转到「${title}」`);
					});
					break;
				}
			}
		});
		root.addEventListener("keydown", (event) => {
			const keyboardEvent = event;
			const input = keyboardEvent.target;
			if (!(input instanceof HTMLInputElement) || !input.matches("[data-search-input]")) return;
			if (keyboardEvent.key === "Enter") {
				keyboardEvent.preventDefault();
				submitHomeSearch(input.value);
			} else if (keyboardEvent.key === "Escape") state.root?.querySelector("[data-searchbar]")?.classList.remove("open");
		});
	}
	function renderCurrentPage(version, force = false) {
		if (!state.enabled || state.page !== "reader") clearNativeTocHitTargets();
		if (state.page === "none") {
			hideHost();
			return;
		}
		showHost();
		if (!state.enabled) {
			state.shellMarker = `native:${state.page}:${location.pathname}`;
			setShellHtml(nativeReturnViewHtml());
			return;
		}
		const marker = `feishu:${state.page}:${location.pathname}`;
		if (!force && state.shellMarker === marker) {
			if (state.page === "reader") {
				refreshReaderMeta(version);
				refreshReaderArticle();
			}
			return;
		}
		state.shellMarker = marker;
		if (state.page === "home") enrichAndRefreshHome(version, renderHome(version)).then((changed) => {
			if (changed) afterRender(version);
		});
		else renderReader(version);
		bindUiEvents(version);
		afterRender(version);
	}
	function applyPageState(version, force = false) {
		const nextPage = detectPage();
		const previousPage = state.page;
		const urlChanged = state.lastUrl !== location.href;
		const changed = previousPage !== nextPage || urlChanged;
		if (changed) clearNativeTocHitTargets();
		const nextReaderBookKey = nextPage === "reader" ? getReaderTocStorageKey() : "";
		const readerBookChanged = Boolean(nextPage === "reader" && state.readerBookKey && nextReaderBookKey && state.readerBookKey !== nextReaderBookKey);
		if (changed && nextPage === "reader") {
			clearCanvasCapture();
			state.readerArticleSignature = "";
			state.readerTocPrimeAttempts = 0;
			if (previousPage !== "reader" || readerBookChanged) {
				state.readerTocItems = [];
				state.readerOfficialToc = [];
				state.readerOfficialTocPromise = null;
			}
			state.readerBookKey = nextReaderBookKey;
		} else if (nextPage !== "reader") state.readerBookKey = "";
		state.page = nextPage;
		state.lastUrl = location.href;
		document.documentElement.classList.toggle("wrf-enabled", state.enabled && nextPage !== "none");
		if (nextPage === "none") document.documentElement.removeAttribute("data-wrf-page");
		else document.documentElement.setAttribute("data-wrf-page", nextPage);
		renderCurrentPage(version, force || changed);
	}
	function setEnabled(enabled, version) {
		state.enabled = enabled;
		writeBoolean(STORAGE.enabled, enabled);
		document.documentElement.classList.toggle("wrf-enabled", enabled && state.page !== "none");
		renderCurrentPage(version, true);
		if (enabled) toast("已切换到飞书云文档外观");
	}
	function startRouter(version) {
		ensureHost();
		bindUiEvents(version);
		patchHistory(() => applyPageState(version, true));
		window.addEventListener("keydown", (event) => {
			if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "f") {
				event.preventDefault();
				setEnabled(!state.enabled, version);
			}
		}, true);
		state.observer?.disconnect();
		state.observer = new MutationObserver(() => {
			window.clearTimeout(state.refreshTimer);
			state.refreshTimer = window.setTimeout(() => {
				if (state.lastUrl !== location.href) {
					applyPageState(version, true);
					return;
				}
				if (!state.enabled) return;
				if (state.page === "reader") {
					refreshReaderMeta(version);
					refreshReaderArticle();
					syncNativeTocHitTargets();
				} else if (state.page === "home") {
					const books = refreshHome(version);
					if (books) {
						bindUiEvents(version);
						enrichAndRefreshHome(version, books);
					}
				}
			}, 140);
		});
		state.observer.observe(document.documentElement, {
			childList: true,
			subtree: true
		});
		applyPageState(version, true);
	}
	//#endregion
	//#region version.ts
	var VERSION = "0.5.8";
	//#endregion
	//#region src/main.ts
	if (pageWindow.top !== pageWindow) {} else if (alreadyRunning) console.info("[wr-feishu-ui] duplicate instance ignored");
	else {
		installCanvasCapture(refreshReaderArticle);
		function boot() {
			ensureGlobalStyle();
			startRouter(VERSION);
			console.info(`[wr-feishu-ui] v${VERSION} ready. Alt+F toggles the skin.`);
		}
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
		else boot();
	}
	//#endregion
})();
