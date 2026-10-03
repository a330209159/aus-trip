#!/usr/bin/env node
// 从 OpenStreetMap 取每段路线的实际走向，写进 index.html 的 GEO（@geo-begin … @geo-end）。
//
// - 公共交通（有 osm 提示的段）：用 Overpass API 找这条线路的 relation，拼成一条线，
//   截取上车点到下车点之间那一段（方向要对）。找不到时巴士 / 电车 / 轻轨退回按公路规划。
// - 步行、打车、自驾、旅行团：用 FOSSGIS 提供的 OSRM 路线规划（routing.openstreetmap.de）。
// - 已经有形状的步行 / 公路段直接沿用（坐标变了就是新的段，会重新取）；公共交通每次都重新查，
//   查不到就沿用旧的。都没有的段，网页按直线画。设环境变量 FORCE=1 可以全部重取。
//
// 用法：node tools/fetch-routes.mjs
// 一般不用手动跑：GitHub Actions 里的 “Update route shapes” 会跑它并提交结果。
// 只用 Node 18+ 自带的功能，不需要 npm install。

import fs from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const FILE = new URL('../index.html', import.meta.url);
const UA = 'aus-trip-route-builder/1.0 (+https://github.com/a330209159/aus-trip)';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const OSRM = {
  foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/',
  car: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
};
// 简化容差（米）：步行更细，长途自驾更粗
const TOL = { walk: 3, bus: 5, tram: 4, lrt: 5, train: 8, metro: 8, ferry: 10, taxi: 6, car: 12, tour: 25 };
// 总时间预算：超过就不再请求，已经取到的照常写进去（GitHub Actions 那边整个任务限 30 分钟）
const BUDGET_MS = 18 * 60 * 1000;
const T0 = Date.now();
const elapsed = () => ((Date.now() - T0) / 1000).toFixed(0) + 's';
// 上下车点离线路多远以内算「在这条线上」（米）
const SNAP = { bus: 250, tram: 250, lrt: 300, train: 400, metro: 400, ferry: 450 };

// ---------- 读出网页里的行程数据，列出所有要画的小段 ----------
export function readPage(html) {
  const db = html.indexOf('/* @data-begin'), de = html.indexOf('/* @data-end */');
  const gb = html.indexOf('/* @geo-begin */'), ge = html.indexOf('/* @geo-end */');
  if (db < 0 || de < 0 || gb < 0 || ge < 0) throw new Error('index.html 里找不到 @data / @geo 标记');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext('var D2R=Math.PI/180;' + html.slice(db, de) + ';this.__={DAYS:DAYS,legsFor:legsFor,legSegs:legSegs,segKey:segKey};', ctx);
  const { DAYS, legsFor, legSegs, segKey } = ctx.__;
  const oldGeo = JSON.parse(html.slice(gb, ge).replace(/^\/\* @geo-begin \*\/var GEO = /, '').replace(/;\s*$/, ''));
  const segs = new Map();
  for (const d of DAYS) {
    const n = d.options ? d.options.length : 1;
    for (let oi = 0; oi < n; oi++) for (const leg of legsFor(d, oi)) for (const g of legSegs(leg)) {
      if (g.mode === 'flight') continue;
      const k = segKey(g);
      if (!segs.has(k)) segs.set(k, { g: JSON.parse(JSON.stringify(g)), day: d.id });
    }
  }
  return { segs, oldGeo, gb, ge };
}
export function writeGeo(html, gb, ge, geo) {
  const keys = Object.keys(geo).sort();
  const body = keys.length ? '{\n' + keys.map(k => JSON.stringify(k) + ':' + JSON.stringify(geo[k])).join(',\n') + '\n}' : '{}';
  return html.slice(0, gb) + '/* @geo-begin */var GEO = ' + body + ';' + html.slice(ge);
}

// ---------- 几何工具 ----------
const R = 6371000, RAD = Math.PI / 180;
const dist = (a, b) => Math.hypot((b[1] - a[1]) * RAD * Math.cos((a[0] + b[0]) / 2 * RAD), (b[0] - a[0]) * RAD) * R;
const length = line => line.reduce((s, p, i) => i ? s + dist(line[i - 1], p) : 0, 0);

// 点 p 投影到折线上：d 离线距离，pos 沿线位置，i 落在第 i-1 到第 i 个点之间
export function project(line, p) {
  let best = { d: Infinity }, acc = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], c = line[i], kx = Math.cos(a[0] * RAD) * RAD * R, ky = RAD * R;
    const cx = (c[1] - a[1]) * kx, cy = (c[0] - a[0]) * ky, px = (p[1] - a[1]) * kx, py = (p[0] - a[0]) * ky;
    const L2 = cx * cx + cy * cy, seg = Math.sqrt(L2);
    const t = L2 ? Math.max(0, Math.min(1, (px * cx + py * cy) / L2)) : 0;
    const d = Math.hypot(px - cx * t, py - cy * t);
    if (d < best.d) best = { d, pos: acc + seg * t, i, pt: [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t] };
    acc += seg;
  }
  return best;
}
export function cut(line, pa, pb) {
  const out = [pa.pt];
  for (let j = pa.i; j < pb.i; j++) out.push(line[j]);
  out.push(pb.pt);
  return out;
}
// 按 relation 里成员的顺序把各段路拼起来，必要时翻转方向
export function stitch(ways) {
  let line = [];
  ways.forEach((w0, n) => {
    let w = w0.slice();
    if (!line.length) { line = w; return; }
    const end = line[line.length - 1], start = line[0];
    const opts = [[dist(end, w[0]), 'a'], [dist(end, w[w.length - 1]), 'ar']];
    if (n === 1) opts.push([dist(start, w[0]), 'ra'], [dist(start, w[w.length - 1]), 'rar']);
    opts.sort((x, y) => x[0] - y[0]);
    const how = opts[0][1];
    if (how[0] === 'r') line.reverse();
    if (how.endsWith('ar')) w.reverse();
    line = line.concat(dist(line[line.length - 1], w[0]) < 1 ? w.slice(1) : w);
  });
  return line;
}
// Douglas–Peucker，容差单位是米
export function simplify(line, tol) {
  if (line.length < 3) return line.slice();
  const keep = new Uint8Array(line.length); keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop(); let md = 0, mi = -1;
    for (let i = s + 1; i < e; i++) { const d = project([line[s], line[e]], line[i]).d; if (d > md) { md = d; mi = i; } }
    if (md > tol) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
  }
  return line.filter((_, i) => keep[i]);
}
export function encode(line) {
  let out = '', plat = 0, plng = 0;
  const enc = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [la, ln] of line) { const a = Math.round(la * 1e5), b = Math.round(ln * 1e5); out += enc(a - plat) + enc(b - plng); plat = a; plng = b; }
  return out;
}

// ---------- 网络 ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function request(url, opts = {}, tries = 2, timeoutMs = 30000) {
  let err;
  for (let k = 0; k < tries; k++) {
    try {
      const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal });
      if (res.ok) return await res.json();
      err = new Error(`HTTP ${res.status}`);
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) { err = e; }
    if (k < tries - 1) await sleep(3000 * (k + 1));
  }
  throw err;
}
// 三个 Overpass 服务器同时问，谁先答用谁，其余的取消（公共服务器经常很忙）
async function overpass(q) {
  const ctrl = new AbortController();
  const asks = OVERPASS.map(url => request(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal }, 1, 100000)
    .then(j => { if (!Array.isArray(j.elements)) throw new Error('返回格式不对'); ctrl.abort(); console.log(`  · ${url.split('/')[2]} 答了（${elapsed()}）`); return j; },
          e => { if (!ctrl.signal.aborted) console.log(`  · ${url.split('/')[2]} 失败：${e.message}（${elapsed()}）`); throw e; }));
  try { return await Promise.any(asks); }
  catch (e) { throw new Error('三个服务器都没答'); }
  finally { await sleep(1000); }
}
async function osrm(profile, pts) {
  const url = OSRM[profile] + pts.map(p => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(';') + '?overview=full&geometries=geojson';
  const j = await request(url, {}, 2, 25000);
  await sleep(400);
  if (j.code !== 'Ok' || !j.routes || !j.routes.length) return null;
  return { line: j.routes[0].geometry.coordinates.map(c => [c[1], c[0]]), meters: j.routes[0].distance };
}

// ---------- 公共交通：Overpass ----------
const relCache = new Map();
function osmFilter(o) {
  let f = `["type"="route"]["route"~"^(${o.route})$"]`;
  if (o.ref) f += `["ref"="${o.ref}"]`;
  if (o.name) f += `["name"~"${o.name}",i]`;
  return f;
}
// 同一条线的所有段一起查一次，bbox 取它们的并集
const groups = new Map();
function groupSegs(segs) {
  for (const [, { g }] of segs) {
    if (!g.osm) continue;
    const f = osmFilter(g.osm);
    const box = groups.get(f) || [90, 180, -90, -180];
    for (const p of [g.A, g.B]) { box[0] = Math.min(box[0], p[0]); box[1] = Math.min(box[1], p[1]); box[2] = Math.max(box[2], p[0]); box[3] = Math.max(box[3], p[1]); }
    groups.set(f, box);
  }
}
async function relationsFor(filter) {
  if (relCache.has(filter)) return relCache.get(filter);
  const b = groups.get(filter), pad = 0.03;
  const q = `[out:json][timeout:90];relation${filter}(${b[0] - pad},${b[1] - pad},${b[2] + pad},${b[3] + pad});out geom;`;
  console.log(`  查线路 ${filter}（${elapsed()}）`);
  let j;
  try { j = await overpass(q); } catch (e) { relCache.set(filter, []); throw e; }
  const rels = (j.elements || []).filter(e => e.type === 'relation').map(r => {
    const ways = r.members.filter(m => m.type === 'way' && m.geometry && !/platform|stop/.test(m.role || '')).map(m => m.geometry.filter(Boolean).map(p => [p.lat, p.lon]));
    return { id: r.id, name: (r.tags && (r.tags.name || r.tags.ref)) || '', line: ways.length ? stitch(ways) : [] };
  }).filter(r => r.line.length > 1);
  console.log(`  → ${rels.length} 条 relation（${elapsed()}）`);
  relCache.set(filter, rels);
  return rels;
}
async function transitShape(g) {
  const rels = await relationsFor(osmFilter(g.osm));
  const snap = SNAP[g.mode] || 300, straight = dist(g.A, g.B);
  let best = null;
  for (const r of rels) {
    const pa = project(r.line, g.A), pb = project(r.line, g.B);
    if (pa.d > snap || pb.d > snap || !(pa.pos < pb.pos)) continue;
    const part = cut(r.line, pa, pb), len = length(part);
    if (len > straight * 4 + 3000) continue;
    const score = pa.d + pb.d + len * 0.01;
    if (!best || score < best.score) best = { score, part, info: `relation ${r.id} ${r.name} · 上下车点离线 ${pa.d.toFixed(0)}/${pb.d.toFixed(0)} m` };
  }
  return best;
}

// ---------- 步行 / 公路 ----------
async function roadShape(g, profile) {
  const pts = [g.A].concat(g.via || []).concat([g.B]);
  const r = await osrm(profile, pts);
  if (!r) return null;
  const straight = length(pts);
  if (r.meters > straight * 3 + 800) return { reject: `绕路太多（${(r.meters / 1000).toFixed(1)} km，直线 ${(straight / 1000).toFixed(1)} km）` };
  const line = r.line.slice();
  if (dist(line[0], g.A) > 5) line.unshift(g.A);
  if (dist(line[line.length - 1], g.B) > 5) line.push(g.B);
  return { part: line, info: `OSRM ${profile} ${(r.meters / 1000).toFixed(2)} km` };
}

// ---------- 主流程 ----------
export async function main() {
let html = fs.readFileSync(FILE, 'utf8');
const { segs, oldGeo, gb, ge } = readPage(html);
groupSegs(segs);
const geo = {}, report = [];
let ok = 0, kept = 0, none = 0;
const FORCE = process.env.FORCE === '1';
// 先做快的（步行、公路），再查公共交通线路
const todo = [...segs].sort((x, y) => (x[1].g.osm ? 1 : 0) - (y[1].g.osm ? 1 : 0));
for (const [k, { g, day }] of todo) {
  let res = null, how = '';
  if (!g.osm && oldGeo[k] && !FORCE) { geo[k] = oldGeo[k]; kept++; continue; }
  if (Date.now() - T0 > BUDGET_MS) res = { reject: '时间预算用完，下次再取' };
  else try {
    if (g.osm) {
      try { res = await transitShape(g); } catch (e) { how = `（线路查询失败：${e.message}）`; }
      // 查不到线路：有旧形状就沿用，没有的巴士 / 电车 / 轻轨按公路画
      if (!res && !oldGeo[k] && /^(bus|tram|lrt)$/.test(g.mode)) { res = await roadShape(g, 'car'); if (res && res.part) how += '（线路没找到，按公路）'; }
    } else if (g.mode === 'walk') res = await roadShape(g, 'foot');
    else if (/^(taxi|car|tour|bus|tram|lrt)$/.test(g.mode)) res = await roadShape(g, 'car');
  } catch (e) { res = { reject: '请求失败：' + e.message }; }
  if (res && res.part) {
    const simple = simplify(res.part, TOL[g.mode] || 5);
    geo[k] = encode(simple); ok++;
    report.push(`✔ ${day} ${g.mode} ${g.line || ''} ${how}${res.info} · ${simple.length} 点（${elapsed()}）`);
  } else if (oldGeo[k]) {
    geo[k] = oldGeo[k]; kept++;
    report.push(`↺ ${day} ${g.mode} ${g.line || ''} 沿用上次的形状${res && res.reject ? '（' + res.reject + '）' : ''}`);
  } else {
    none++;
    report.push(`✘ ${day} ${g.mode} ${g.line || ''} 没取到${res && res.reject ? '：' + res.reject : ''}，网页按直线画 · ${k}`);
  }
  console.log(report[report.length - 1]);
}
console.log(`\n共 ${segs.size} 段：新取到 ${ok}，沿用已有的 ${kept}，没有 ${none}。`);

fs.writeFileSync(FILE, writeGeo(html, gb, ge, geo));
if (!ok && !kept) { console.error('一段都没取到，可能是网络问题。'); process.exitCode = 1; }
}

// 直接运行时：跑完就退出（不等被取消的请求收尾）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then(() => process.exit(process.exitCode || 0), e => { console.error(e); process.exit(1); });
