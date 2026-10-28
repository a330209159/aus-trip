// 临时：查 10/29 回程两处加油站（Colac、Todd Road 一带）在 OSM 里的信息和怎么进出，用完删掉
const UA = 'aus-trip-route-builder/1.0 (+https://github.com/a330209159/aus-trip)';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const OSRM = 'https://routing.openstreetmap.de/routed-car/route/v1/driving/';
const PC = [-38.6196, 142.9954], HOME = [-37.8187, 144.9543], COLAC_W = [-38.3400, 143.50], GEEL = [-38.15, 144.36];
const C = {
  'Colac 7-Eleven': [-38.33840, 143.57873], 'Colac BP W': [-38.33491, 143.55364], 'Colac BP E': [-38.33930, 143.59179],
  'Colac Shell': [-38.34097, 143.59215], 'Colac Liberty': [-38.33434, 143.54466],
  'PM United N': [-37.82922, 144.91902], 'PM United S': [-37.83090, 144.91891], 'PM Shell': [-37.82948, 144.91766],
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, opt = {}) { for (let i = 0; i < 4; i++) { try { const r = await fetch(url, { ...opt, headers: { 'user-agent': UA, ...(opt.headers || {}) } }); if (r.ok) return await r.json(); console.log('  http', r.status, url.slice(0, 60)); } catch (e) { console.log('  err', e.message); } await sleep(2000 * (i + 1)); } return null; }
async function op(q) { for (const u of OVERPASS) { const j = await get(u, { method: 'POST', body: 'data=' + encodeURIComponent('[out:json][timeout:60];' + q), headers: { 'content-type': 'application/x-www-form-urlencoded' } }); if (j) return j; } return null; }
const ll = p => p[1] + ',' + p[0];
async function route(pts) { const j = await get(OSRM + pts.map(ll).join(';') + '?overview=false&steps=true'); if (!j || !j.routes) return null; return j; }
const fmt = r => (r.distance / 1000).toFixed(1) + ' km ' + (r.duration / 60).toFixed(0) + ' min';

const direct = await route([PC, HOME]); console.log('direct PC→home', direct && fmt(direct.routes[0]));
const dirTail = await route([GEEL, HOME]); console.log('direct Geelong→home', dirTail && fmt(dirTail.routes[0]));
const dirCol = await route([COLAC_W, GEEL]); console.log('direct ColacW→Geelong', dirCol && fmt(dirCol.routes[0]));
for (const [n, p] of Object.entries(C)) {
  console.log('\n## ' + n, p.join(','));
  const pc = n.startsWith('PM');
  const a = pc ? GEEL : COLAC_W, b = pc ? HOME : GEEL;
  const r = await route([a, p, b]);
  if (r) {
    const w = r.waypoints[1];
    console.log('  via', fmt(r.routes[0]), '| snapped', w.location.slice().reverse().join(','), 'name', JSON.stringify(w.name), 'dist', w.distance.toFixed(0) + 'm');
    for (const leg of r.routes[0].legs) {
      const st = leg.steps.slice(-4).concat(['--']);
      console.log('   ', leg.steps.slice(Math.max(0, leg.steps.length - 4)).map(s => s.maneuver.type + '/' + (s.maneuver.modifier || '') + ' ' + JSON.stringify(s.name) + (s.ref ? '[' + s.ref + ']' : '') + ' ' + (s.distance).toFixed(0) + 'm').join(' | '));
    }
  }
  await sleep(1200);
  const nr = await get(`https://routing.openstreetmap.de/routed-car/nearest/v1/driving/${ll(p)}?number=4`);
  if (nr && nr.waypoints) console.log('  nearest:', nr.waypoints.map(w => JSON.stringify(w.name) + ' ' + w.distance.toFixed(0) + 'm').join(' ; '));
  const o = await op(`(nwr(around:80,${p.join(',')})[amenity=fuel];);out center tags;way(around:120,${p.join(',')})[highway];out tags center;`);
  if (o) for (const e of o.elements) {
    const t = e.tags || {}; const c = e.center || e;
    if (t.amenity) console.log('  fuel', e.type + '/' + e.id, (c.lat || '').toString().slice(0, 9) + ',' + (c.lon || '').toString().slice(0, 9), JSON.stringify({ name: t.name, brand: t.brand, opening_hours: t.opening_hours, addr: [t['addr:housenumber'], t['addr:street'], t['addr:suburb'] || t['addr:city']].filter(Boolean).join(' ') }));
    else console.log('  road', t.highway, JSON.stringify(t.name || ''), t.ref || '', t.oneway || '', t.destination ? 'dest=' + t.destination : '', (c.lat || '').toString().slice(0, 8) + ',' + (c.lon || '').toString().slice(0, 9));
  }
  await sleep(1500);
}
