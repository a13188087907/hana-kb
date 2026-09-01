import test from "node:test";
import assert from "node:assert/strict";
import { fetchUrlToMarkdown } from "../core/web-fetch.js";

function mockFetch(html, { status = 200, contentType = "text/html; charset=utf-8" } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => Buffer.from(html, "utf8"),
  });
}

const ARTICLE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>测试文章标题</title></head><body>
<article>
<h1>休克早期的识别要点</h1>
${"<p>休克是一种危及生命的临床综合征，其根本原因是循环系统无法满足组织氧供需求，导致细胞缺氧、代谢紊乱和器官功能障碍。</p>".repeat(6)}
</article>
</body></html>`;

test("抓取网页转为带 frontmatter 的 Markdown", async () => {
  const { markdown, title, url } = await fetchUrlToMarkdown("https://example.com/a", { fetchImpl: mockFetch(ARTICLE_HTML) });
  assert.equal(url, "https://example.com/a");
  assert.ok(title.length > 0);
  assert.ok(markdown.startsWith("---\nsource: https://example.com/a"));
  assert.ok(markdown.includes("fetched_at:"));
  assert.ok(markdown.includes("休克是一种危及生命的临床综合征"));
});

test("非 http/https 链接被拒绝", async () => {
  await assert.rejects(() => fetchUrlToMarkdown("file:///etc/passwd", { fetchImpl: mockFetch("") }), /http\/https/);
});

test("非法 URL 被拒绝", async () => {
  await assert.rejects(() => fetchUrlToMarkdown("not-a-url", { fetchImpl: mockFetch("") }), /URL 格式/);
});

test("非网页内容类型被拒绝", async () => {
  await assert.rejects(
    () => fetchUrlToMarkdown("https://example.com/f.pdf", { fetchImpl: mockFetch("x", { contentType: "application/pdf" }) }),
    /不是网页/
  );
});

test("内容过短视为提取失败", async () => {
  const thin = `<!DOCTYPE html><html><head><title>x</title></head><body><div>loading...</div></body></html>`;
  await assert.rejects(() => fetchUrlToMarkdown("https://example.com/spa", { fetchImpl: mockFetch(thin) }), /正文提取失败/);
});

test("HTTP 错误状态被拒绝", async () => {
  const failFetch = async () => ({ ok: false, status: 403, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) });
  await assert.rejects(() => fetchUrlToMarkdown("https://example.com/x", { fetchImpl: failFetch }), /403/);
});


test("内网地址被 SSRF 防护拦截", async () => {
  for (const url of ["http://192.168.1.1/admin", "http://10.0.0.1/", "http://127.0.0.1:8080/", "http://localhost/x", "http://169.254.169.254/latest/meta-data", "http://172.16.0.1/"]) {
    await assert.rejects(() => fetchUrlToMarkdown(url), /内网/);
  }
});
