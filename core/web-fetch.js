// 网页抓取 → Markdown
// 通道：route/工具层（主进程）原生 fetch —— Hana 权限模型管 SDK 接口不管代码沙盒，
// allowedHosts 不支持全通配，任意网页抓取只能走这里（官方指南：动态业务数据放 route 层获取）。
// Readability 是 Firefox 阅读模式同款算法，覆盖静态网页正文提取（公众号/博客/新闻/文档站）。
// JS 重渲染页面（SPA）不在本层解决——检测到内容过短时给明确提示。
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MIN_CONTENT_CHARS = 200; // 低于此视为提取失败（多半是 JS 渲染页或反爬拦截）
const CRAWL4AI_BASE = process.env.HANA_KB_CRAWL4AI_URL || "http://127.0.0.1:11235";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

// SSRF 防护：拦截内网/本机地址（我们走 route 层原生 fetch 绕开了 allowedHosts，这道墙必须自己补）。
// 边界：只拦字面私有地址与 localhost 主机名，不防 DNS  rebinding（域名解析到内网）——本地自用插件接受该残余风险。
function isPrivateHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "[::1]" || h === "0.0.0.0") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // 链路本地/云元数据
  }
  return false;
}

export async function fetchUrlToMarkdown(url, { fetchImpl = globalThis.fetch, timeoutMs = 25000 } = {}) {
  const target = String(url ?? "").trim();
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error("URL 格式不正确");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("只支持 http/https 链接");
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error("不支持抓取内网或本机地址");
  }

  // SSRF 防护：手动跟随重定向，每跳重新校验主机（防止公开地址 302 到内网）
  const MAX_REDIRECTS = 3;
  let currentUrl = target;
  let response;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetchImpl(currentUrl, {
        signal: controller.signal,
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
        redirect: "manual",
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("重定向缺少 Location 头");
      const next = new URL(location, currentUrl);
      if (next.protocol !== "http:" && next.protocol !== "https:") throw new Error("重定向目标不是 http/https");
      if (isPrivateHost(next.hostname)) throw new Error("重定向目标是内网或本机地址");
      currentUrl = next.href;
      continue;
    }
    break;
  }
  if (!response) throw new Error("重定向次数超限");
  if (!response.ok) throw new Error(`网页请求失败（HTTP ${response.status}）`);

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType && !contentType.includes("html") && !contentType.includes("text/")) {
    throw new Error(`该链接不是网页（${contentType.split(";")[0]}），文件类资源请直接入库`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  // JSDOM 接受 Buffer 时按 meta charset 嗅探编码，兼容 GBK 老站
  const dom = new JSDOM(buffer, { url: target });
  const doc = dom.window.document;
  // 反爬/懒加载适配：公众号等会把正文容器设为 visibility:hidden 由页面 JS 解禁，
  // Readability 会跳过不可见节点导致提取失败；抓取侧无 JS 执行，先剥离该隐藏属性。
  doc.querySelectorAll('[style*="visibility"]').forEach((el) => { el.style.visibility = ""; });
  // 懒加载图片：真实地址在 data-src，回填以便正文保留图片
  doc.querySelectorAll("img[data-src]").forEach((img) => {
    if (!img.getAttribute("src")) img.setAttribute("src", img.getAttribute("data-src"));
  });
  const article = new Readability(doc).parse();
  if (!article || !article.textContent || article.textContent.trim().length < MIN_CONTENT_CHARS) {
    // 静态提取失败（JS 渲染页/反爬，如公众号新版页面）→ 依次尝试真浏览器降级
    const viaBrowser = await tryPlaywright(target, { fetchImpl, timeoutMs });
    if (viaBrowser) return viaBrowser;
    const viaCrawl4ai = await tryCrawl4ai(target, { fetchImpl, timeoutMs });
    if (viaCrawl4ai) return viaCrawl4ai;
    throw new Error("正文提取失败：该页面是 JS 动态渲染或触发了反爬，且本机未检测到可用的 Chrome/Edge 或 crawl4ai 服务（端口 11235）");
  }

  const title = String(article.title || parsed.hostname).trim();
  const bodyMd = turndown.turndown(article.content);
  const fetchedAt = new Date().toISOString();
  const markdown = [
    "---",
    `source: ${target}`,
    `fetched_at: ${fetchedAt}`,
    "---",
    "",
    `# ${title}`,
    "",
    bodyMd.trim(),
    "",
  ].join("\n");
  return { markdown, title, url: target, warnings: [] };
}

// playwright-core 驱动本机已装的 Chrome/Edge（不下载浏览器二进制），覆盖 JS 渲染页（公众号新版等）
let playwrightModulePromise;
async function tryPlaywright(url, { timeoutMs }) {
  let chromium;
  try {
    playwrightModulePromise ??= import("playwright-core");
    ({ chromium } = await playwrightModulePromise);
  } catch {
    return null;
  }
  let browser = null;
  try {
    for (const channel of ["chrome", "msedge"]) {
      try {
        browser = await chromium.launch({ channel, headless: true, timeout: 8000 });
        break;
      } catch { /* 试下一个渠道 */ }
    }
    if (!browser) return null;
    const page = await browser.newPage({ userAgent: UA });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(timeoutMs, 30000) });
    await page.waitForSelector("#js_content", { timeout: 6000 }).catch(() => {}); // 公众号正文容器
    await page.waitForTimeout(1800); // 等正文异步注入
    const html = await page.content();
    const dom2 = new JSDOM(html, { url });
    const doc2 = dom2.window.document;
    doc2.querySelectorAll('[style*="visibility"]').forEach((el) => { el.style.visibility = ""; });
    doc2.querySelectorAll("img[data-src]").forEach((img) => {
      if (!img.getAttribute("src")) img.setAttribute("src", img.getAttribute("data-src"));
    });
    const article = new Readability(doc2).parse();
    if (!article || !article.textContent || article.textContent.trim().length < MIN_CONTENT_CHARS) return null;
    const title = String(article.title || url).trim();
    const bodyMd = turndown.turndown(article.content);
    const markdown = [
      "---",
      `source: ${url}`,
      `fetched_at: ${new Date().toISOString()}`,
      "via: browser",
      "---",
      "",
      `# ${title}`,
      "",
      bodyMd.trim(),
      "",
    ].join("\n");
    return { markdown, title, url, warnings: [] };
  } catch {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// 本机 crawl4ai 服务（docker 起在 11235）兜底：不可达时静默返回 null，由调用方报错
async function tryCrawl4ai(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${CRAWL4AI_BASE}/crawl`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: [url], priority: 10 }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const item = data?.results?.[0];
    const mdField = item?.markdown;
    const text = typeof mdField === "string" ? mdField : (mdField?.fit_markdown || mdField?.raw_markdown || "");
    if (!text || text.trim().length < MIN_CONTENT_CHARS) return null;
    const title = String(item?.metadata?.title || url).trim();
    const markdown = [
      "---",
      `source: ${url}`,
      `fetched_at: ${new Date().toISOString()}`,
      "via: crawl4ai",
      "---",
      "",
      `# ${title}`,
      "",
      text.trim(),
      "",
    ].join("\n");
    return { markdown, title, url, warnings: [] };
  } catch {
    return null; // 服务未启动/超时/网络拒绝
  } finally {
    clearTimeout(timer);
  }
}
