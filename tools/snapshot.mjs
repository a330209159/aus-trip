#!/usr/bin/env node
// 把某一版的网页冻结成 v/<号>/index.html，网页上的「版本」菜单和总览页的「版本记录」会链接过去。
//
// 用法：node tools/snapshot.mjs <版本号> [git 版本，默认 origin/main]
//   例：要开始做 v3 之前，先在 index.html 的 VERSIONS 最前面加上 v3 的说明，
//       再跑 node tools/snapshot.mjs 2 —— 把线上（main）现在的 v2 存成 v/2/。
//
// 副本是那一版 index.html 的原样拷贝（路线形状、照片都在里面），只多了三处：
//   <html data-snapshot="号">、标题后面加「旧版本 vN」、页面最上面一条提示横幅（链接回最新版）。
// 以后不会再改它；Update route shapes / Update photos 只改根目录的 index.html。
// 只用 Node 18+ 自带的功能，不需要 npm install。

import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function versionsOf(html) {
  const db = html.indexOf('/* @data-begin'), de = html.indexOf('/* @data-end */');
  if (db < 0 || de < 0) return [];
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext('var D2R=Math.PI/180;' + html.slice(db, de) + ';this.__=typeof VERSIONS==="undefined"?[]:VERSIONS;', ctx);
  return JSON.parse(JSON.stringify(ctx.__));
}

export function makeSnapshot(html, ver) {
  // 只动文件里第一次出现的 <html>、<title>、<body>，也就是真正的标签（它们在任何脚本之前）
  const tag = html.match(/<html\b[^>]*>/);
  if (!tag || !/<title>[^<]*<\/title>/.test(html) || !/<body\b[^>]*>/.test(html)) throw new Error('页面里找不到 <html>、<title> 或 <body>');
  if (/data-snapshot=/.test(tag[0])) throw new Error('这个页面已经是旧版本副本了');
  const n = ver.v;
  const bar = `
<!-- 旧版本副本（tools/snapshot.mjs 生成，不再更新） -->
<style>
.snapbar{--sb-bg:#FFF1CC;--sb-line:#E3BE5C;--sb-ink:#3D2E05;background:var(--sb-bg);border-bottom:1px solid var(--sb-line);color:var(--sb-ink);font-size:13.5px;line-height:1.5}
.snapbar .in{max-width:1440px;margin:0 auto;padding:9px 16px;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 12px}
.snapbar b{font-weight:600}
.snapbar a{color:inherit;font-weight:600;white-space:nowrap}
@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]) .snapbar{--sb-bg:#3A3016;--sb-line:#7A6426;--sb-ink:#F3E2B3} }
:root[data-theme="dark"] .snapbar{--sb-bg:#3A3016;--sb-line:#7A6426;--sb-ink:#F3E2B3}
</style>
<div class="snapbar" role="note"><div class="in"><span><b>旧版本 v${n}</b> · ${esc(ver.date)} · ${esc(ver.title)}</span><span>这是之前的计划，只用来对照，不再更新。</span><a href="../../">看最新版 →</a></div></div>
`;
  return html
    .replace(/<html\b([^>]*)>/, `<html$1 data-snapshot="${n}">`)
    .replace(/<title>([^<]*)<\/title>/, (m, t) => `<title>${t} · 旧版本 v${n}</title>`)
    .replace(/<body\b[^>]*>/, m => m + bar);
}

export function main(argv = process.argv.slice(2)) {
  const n = +argv[0], ref = argv[1] || 'origin/main';
  if (!n) throw new Error('用法：node tools/snapshot.mjs <版本号> [git 版本]');
  const cur = fs.readFileSync(new URL('index.html', ROOT), 'utf8');
  const ver = versionsOf(cur).find(x => x.v === n);
  if (!ver) throw new Error(`index.html 的 VERSIONS 里没有 v${n}，先把它写进去`);
  const html = execFileSync('git', ['show', `${ref}:index.html`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  const out = new URL(`v/${n}/index.html`, ROOT);
  if (fs.existsSync(out)) throw new Error(`v/${n}/index.html 已经存在；旧版本不要覆盖`);
  fs.mkdirSync(new URL(`v/${n}/`, ROOT), { recursive: true });
  fs.writeFileSync(out, makeSnapshot(html, ver));
  console.log(`已把 ${ref} 的 index.html 存成 v/${n}/index.html（${ver.date} · ${ver.title}）`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
