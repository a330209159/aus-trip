#!/usr/bin/env node
// 给每个地点找一张风景小图，写进 index.html 的 PHOTO（@photo-begin … @photo-end）。
//
// - 每站的 img 写维基百科（英文）条目名，可以写几个备选；按顺序找第一张合适的图。
//   先看条目的主图，不合适再看条目里的其他图片；跳过地图、标志、示意图和 SVG。
// - 备选也可以写成 'File:xxx.jpg'（直接用 Commons 上这张图），
//   或 'search:关键词'（在 Commons 搜图，用第一张合适的；比如 'search:intitle:"Royal Arcade" Melbourne'
//   只要文件名里有 Royal Arcade 的图）。日志里会列出搜到的其他几张，想固定某张就改成 File: 写法。
// - 只用 Wikimedia Commons 上自由授权的图片（非自由的「合理使用」图不在 Commons 上，自然排除），
//   记下作者和授权，网页上显示署名并链接到图片页。
// - 这次没找到、但以前找到过的沿用旧的。
//
// 用法：node tools/fetch-photos.mjs（GitHub Actions 的 “Update photos” 会跑它并提交结果）
// 只用 Node 18+ 自带的功能，不需要 npm install。

import fs from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const FILE = new URL('../index.html', import.meta.url);
const UA = 'aus-trip-photo-picker/1.0 (+https://github.com/a330209159/aus-trip)';
const WIKI = 'https://en.wikipedia.org/api/rest_v1/page/';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const WIDTH = 320;
const SKIP = /\.svg$|\bmaps?\b|locator|location map|\blogo|\bflag\b|coat[_ ]of[_ ]arms|diagram|\bplan\b|signage|\bicon\b|\bseal\b/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url) {
  for (let k = 0; k < 3; k++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (res.status === 404) return null;
      if (res.ok) { await sleep(150); return await res.json(); }
    } catch { /* retry */ }
    await sleep(1500 * (k + 1));
  }
  return null;
}
const strip = h => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const fileOf = src => { try { return 'File:' + decodeURIComponent(src.split('/').pop()).replace(/_/g, ' '); } catch { return null; } };

export function readPage(html) {
  const db = html.indexOf('/* @data-begin'), de = html.indexOf('/* @data-end */');
  const pb = html.indexOf('/* @photo-begin */'), pe = html.indexOf('/* @photo-end */');
  if (db < 0 || de < 0 || pb < 0 || pe < 0) throw new Error('index.html 里找不到 @data / @photo 标记');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext('var D2R=Math.PI/180;' + html.slice(db, de) + ';this.__={DAYS:DAYS};', ctx);
  const places = new Map();
  const add = s => { if (s && s.img) { const c = [].concat(s.img); if (!places.has(c[0])) places.set(c[0], { cands: c.slice(), name: s.n }); } };
  for (const d of ctx.__.DAYS) {
    [].concat(d.stops || [], d.tail || [], ...(d.options || []).map(o => o.stops)).forEach(add);
    if (typeof d.start === 'object') add(d.start);
    if (typeof d.end === 'object') add(d.end);
  }
  const old = JSON.parse(html.slice(pb, pe).replace(/^\/\* @photo-begin \*\/var PHOTO = /, '').replace(/;\s*$/, ''));
  return { places, old, pb, pe };
}
export function writePhotos(html, pb, pe, photos) {
  const keys = Object.keys(photos).sort();
  const body = keys.length ? '{\n' + keys.map(k => JSON.stringify(k) + ':' + JSON.stringify(photos[k])).join(',\n') + '\n}' : '{}';
  return html.slice(0, pb) + '/* @photo-begin */var PHOTO = ' + body + ';' + html.slice(pe);
}

// Commons 上的图片信息；不在 Commons 上（本地非自由图）或不是照片就返回 null
async function commonsInfo(file) {
  const q = `${COMMONS}?action=query&format=json&formatversion=2&prop=imageinfo&iiprop=url|extmetadata|mime&iiurlwidth=${WIDTH}&titles=${encodeURIComponent(file)}`;
  const j = await getJSON(q);
  return infoOf(j && j.query && j.query.pages && j.query.pages[0]);
}
function infoOf(p) {
  const ii = p && !p.missing && p.imageinfo && p.imageinfo[0];
  if (!ii || !/^image\/(jpeg|png|webp)$/.test(ii.mime) || !ii.thumburl) return null;
  const m = ii.extmetadata || {};
  const license = strip(m.LicenseShortName && m.LicenseShortName.value);
  if (!license || /fair use|non-free/i.test(license)) return null;
  let artist = strip(m.Artist && m.Artist.value) || '佚名';
  if (artist.length > 48) artist = artist.slice(0, 46) + '…';
  return { src: ii.thumburl, file: p.title, credit: artist + ' · ' + license, desc: strip(m.ImageDescription && m.ImageDescription.value).slice(0, 90) };
}
// Commons 搜图（只搜文件），按搜索结果的顺序返回能用的图
async function searchCommons(q) {
  const u = `${COMMONS}?action=query&format=json&formatversion=2&generator=search&gsrnamespace=6&gsrlimit=12&gsrsearch=${encodeURIComponent(q)}` +
    `&prop=imageinfo&iiprop=url|extmetadata|mime&iiurlwidth=${WIDTH}`;
  const j = await getJSON(u);
  const pages = ((j && j.query && j.query.pages) || []).slice().sort((a, b) => a.index - b.index);
  return pages.filter(p => !SKIP.test(p.title)).map(p => infoOf(p)).filter(Boolean);
}
async function pickFor(title) {
  if (/^File:/.test(title)) {
    const info = await commonsInfo(title);
    return info ? { info } : { why: 'Commons 上没有这张图，或者不是自由授权的照片' };
  }
  if (/^search:/.test(title)) {
    const found = await searchCommons(title.slice(7).trim());
    if (!found.length) return { why: '搜不到合适的图' };
    return { info: found[0], also: found.slice(1, 5).map(f => f.file) };
  }
  const slug = encodeURIComponent(title.replace(/ /g, '_'));
  const files = [];
  const sum = await getJSON(WIKI + 'summary/' + slug);
  if (!sum || sum.type === 'disambiguation') return { why: sum ? '是消歧义页' : '条目不存在' };
  if (sum.originalimage) files.push(fileOf(sum.originalimage.source));
  const media = await getJSON(WIKI + 'media-list/' + slug);
  for (const it of (media && media.items) || []) if (it.type === 'image' && it.title) files.push(it.title.replace(/_/g, ' '));
  const tried = new Set();
  for (const f of files) {
    if (!f || tried.has(f) || SKIP.test(f)) continue;
    tried.add(f);
    if (tried.size > 8) break;
    const info = await commonsInfo(f);
    if (info) return { info, page: sum.content_urls && sum.content_urls.desktop && sum.content_urls.desktop.page };
  }
  return { why: '没有合适的自由授权照片' };
}

export async function main() {
  const html = fs.readFileSync(FILE, 'utf8');
  const { places, old, pb, pe } = readPage(html);
  const photos = {}, lines = [];
  let ok = 0, kept = 0, none = 0;
  for (const [key, { cands, name }] of places) {
    let got = null, why = '';
    for (const t of cands) {
      const r = await pickFor(t);
      if (r.info) { got = r.info; got.title = t; got.also = r.also; break; }
      why = `${t}：${r.why}`;
    }
    if (got) {
      photos[key] = { src: got.src, file: got.file, credit: got.credit };
      ok++; lines.push(`✔ ${name} ← ${got.title} · ${got.file} · ${got.credit}${got.desc ? ' · ' + got.desc : ''}` +
        (got.also && got.also.length ? `\n    其他搜到的：${got.also.join(' ／ ')}` : ''));
    } else if (old[key]) {
      photos[key] = old[key]; kept++; lines.push(`↺ ${name} 沿用上次的图（${why}）`);
    } else {
      none++; lines.push(`✘ ${name} 没找到（${why}），网页显示占位图`);
    }
    console.log(lines[lines.length - 1]);
  }
  console.log(`\n共 ${places.size} 个地点：新找到 ${ok}，沿用 ${kept}，没有 ${none}。`);
  fs.writeFileSync(FILE, writePhotos(html, pb, pe, photos));
  if (!ok && !kept) { console.error('一张都没找到，可能是网络问题。'); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then(() => process.exit(process.exitCode || 0), e => { console.error(e); process.exit(1); });
