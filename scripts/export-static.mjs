/**
 * 导出静态演示站：把当前数据库导成 snapshot.json + 一套纯静态文件。
 * 产物在 static-site/，可以直接丢到 GitHub Pages / 任意静态托管。
 *
 *   node scripts/export-static.mjs
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get } from '../db.js';
import { collectAlerts } from '../lib/alerts.js';
import { ymd, nowStr, periodOf } from '../lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'static-site');
const READINGS_LIMIT = 1600;

const CHANNEL_ZH = { wechat: '微信支付', alipay: '支付宝', bank: '银行代扣', cash: '营业厅现金', mock: '模拟网关' };

/* ------------------------------ 数据 ------------------------------ */

const accounts = all(`
  SELECT a.*, ar.name AS area_name, ar.code AS area_code, c.name AS community_name,
    (SELECT COUNT(*) FROM metering_points p WHERE p.account_id=a.id) points_cnt,
    (SELECT MAX(b.period) FROM bills b WHERE b.account_id=a.id) last_period,
    (SELECT b.total_amount FROM bills b WHERE b.account_id=a.id ORDER BY b.period DESC LIMIT 1) last_amount,
    (SELECT b.status FROM bills b WHERE b.account_id=a.id ORDER BY b.period DESC LIMIT 1) last_status,
    COALESCE((SELECT ROUND(SUM(b.total_amount-b.paid_amount),2) FROM bills b
      WHERE b.account_id=a.id AND b.status NOT IN ('void','paid') AND b.total_amount>b.paid_amount),0) outstanding,
    (SELECT MAX(r.read_at) FROM readings r JOIN metering_points p ON p.id=r.point_id WHERE p.account_id=a.id) last_reading_at,
    (SELECT d.status FROM segments s JOIN devices d ON d.id=s.device_id JOIN metering_points p ON p.id=s.point_id
      WHERE p.account_id=a.id AND s.status='active' LIMIT 1) device_status,
    (SELECT d.asset_no FROM segments s JOIN devices d ON d.id=s.device_id JOIN metering_points p ON p.id=s.point_id
      WHERE p.account_id=a.id AND s.status='active' LIMIT 1) asset_no
  FROM accounts a
  LEFT JOIN areas ar ON ar.id=a.area_id
  LEFT JOIN communities c ON c.id=a.community_id
  ORDER BY a.account_no`);

const points = all('SELECT * FROM metering_points ORDER BY id');

const segments = all(`
  SELECT s.*, d.asset_no, d.model, d.vendor, d.imei, d.status AS device_status, d.last_seen_at,
         d.ratio AS device_ratio, d.phase, p.account_id
  FROM segments s
  JOIN devices d ON d.id=s.device_id
  JOIN metering_points p ON p.id=s.point_id
  ORDER BY s.seq DESC`);

const devices = all(`
  SELECT d.*, s.status AS seg_status, s.start_date AS installed_seg_at,
         a.id AS account_id, a.account_no, a.customer_name, a.address
  FROM devices d
  LEFT JOIN segments s ON s.device_id=d.id AND s.status='active'
  LEFT JOIN metering_points p ON p.id=s.point_id
  LEFT JOIN accounts a ON a.id=p.account_id
  ORDER BY d.id DESC`);

const bills = all(`
  SELECT b.*, a.account_no, a.customer_name, a.phone, a.address, a.property_type,
         ROUND(b.total_amount - b.paid_amount, 2) AS outstanding
  FROM bills b JOIN accounts a ON a.id=b.account_id
  ORDER BY b.period DESC, b.id DESC`).map((b) => {
  let calc = null;
  try { calc = b.calc_detail ? JSON.parse(b.calc_detail) : null; } catch { /* ignore */ }
  const { calc_detail, ...rest } = b;
  return { ...rest, calc };
});

const payments = all(`
  SELECT p.*, a.account_no, a.customer_name,
    (SELECT COUNT(*) FROM allocations al WHERE al.payment_id=p.id) bills_cnt
  FROM payments p JOIN accounts a ON a.id=p.account_id
  ORDER BY p.paid_at DESC, p.id DESC`)
  .map((p) => {
    const { raw, ...rest } = p;
    return { ...rest, channel_name: CHANNEL_ZH[p.channel] || p.channel };
  });

const allocations = all(`
  SELECT al.*, b.period, b.bill_no, b.total_amount
  FROM allocations al JOIN bills b ON b.id=al.bill_id ORDER BY al.id`);

const adjustments = all(`
  SELECT j.*, a.account_no, a.customer_name FROM adjustments j
  JOIN accounts a ON a.id=j.account_id ORDER BY j.id DESC`);

const replacements = all(`
  SELECT r.*, a.account_no, a.customer_name, a.phone, a.address, a.property_type,
         od.asset_no AS old_asset_no, nd.asset_no AS new_asset_no
  FROM replacements r
  JOIN accounts a ON a.id=r.account_id
  LEFT JOIN devices od ON od.id=r.old_device_id
  LEFT JOIN devices nd ON nd.id=r.new_device_id
  ORDER BY r.id DESC`);

const readings = all(`
  SELECT r.id, r.point_id, r.segment_id, r.device_id, r.read_at, r.reading, r.source,
         r.quality, r.note, a.account_no, a.customer_name, d.asset_no, s.seq AS seg_seq
  FROM readings r
  JOIN metering_points p ON p.id=r.point_id
  JOIN accounts a ON a.id=p.account_id
  JOIN devices d ON d.id=r.device_id
  LEFT JOIN segments s ON s.id=r.segment_id
  ORDER BY r.read_at DESC, r.id DESC
  LIMIT ${READINGS_LIMIT}`);

/* 户 × 账期 用电量（一次查询，避免逐户跑窗口函数） */
const usageRows = all(`
  WITH r AS (
    SELECT point_id, read_at, reading,
           LAG(reading) OVER (PARTITION BY point_id ORDER BY read_at, id) prev,
           LAG(read_at) OVER (PARTITION BY point_id ORDER BY read_at, id) prev_at
    FROM readings WHERE superseded_by IS NULL AND quality <> 'suspect')
  SELECT p.account_id, substr(r.read_at,1,7) period, SUM(r.reading - r.prev) kwh
  FROM r JOIN metering_points p ON p.id=r.point_id
  WHERE r.prev IS NOT NULL AND r.prev_at IS NOT NULL
  GROUP BY p.account_id, period`);
const usage = {};
for (const u of usageRows) {
  usage[u.account_id] = usage[u.account_id] || {};
  usage[u.account_id][u.period] = Math.round(u.kwh * 10) / 10;
}

/* 断档：与 api.js 同口径 */
const gapPoints = all(`
  SELECT p.id, p.point_no, a.id account_id, a.account_no, a.customer_name, a.phone,
         s.id seg_id, s.device_id, d.asset_no, d.status device_status,
         (SELECT MAX(read_at) FROM readings r WHERE r.point_id=p.id) last_at
  FROM metering_points p
  JOIN accounts a ON a.id=p.account_id
  JOIN segments s ON s.point_id=p.id AND s.status='active'
  JOIN devices d ON d.id=s.device_id
  WHERE a.status <> 'closed'`);
const gapCurrent = [];
for (const p of gapPoints) {
  if (!p.last_at) { gapCurrent.push({ ...p, days: null, type: 'no_data' }); continue; }
  const days = Math.floor((Date.now() - new Date(p.last_at.replace(' ', 'T')).getTime()) / 86400000);
  if (days >= 2) gapCurrent.push({ ...p, days, type: days >= 7 ? 'long_gap' : 'gap' });
}
const gapHistory = all(`
  WITH x AS (
    SELECT point_id, read_at, LAG(read_at) OVER (PARTITION BY point_id ORDER BY read_at) prev_at
    FROM readings WHERE superseded_by IS NULL)
  SELECT x.*, p.point_no, a.account_no, a.customer_name,
         CAST(julianday(x.read_at) - julianday(x.prev_at) AS INTEGER) days
  FROM x
  JOIN metering_points p ON p.id=x.point_id
  JOIN accounts a ON a.id=p.account_id
  WHERE x.prev_at IS NOT NULL AND julianday(x.read_at) - julianday(x.prev_at) > 5
  ORDER BY days DESC LIMIT 30`);

const faultDevices = all(`
  SELECT d.asset_no, d.vendor, d.model, d.offline_since, a.account_no, a.customer_name
  FROM devices d
  LEFT JOIN segments s ON s.id = (SELECT id FROM segments WHERE device_id=d.id ORDER BY seq DESC LIMIT 1)
  LEFT JOIN metering_points p ON p.id=s.point_id
  LEFT JOIN accounts a ON a.id=p.account_id
  WHERE d.status IN ('fault','returned')
  ORDER BY CASE d.status WHEN 'fault' THEN 0 ELSE 1 END, d.id DESC LIMIT 3`);

const alerts = collectAlerts();
const periodRuns = all('SELECT * FROM period_runs ORDER BY period DESC');
const lastPeriod = get('SELECT MAX(period) p FROM period_runs')?.p || null;

const stats = {
  accounts: accounts.length,
  activeAccounts: accounts.filter((a) => a.status === 'active').length,
  devices: get('SELECT COUNT(*) c FROM devices').c,
  inService: get("SELECT COUNT(*) c FROM devices WHERE status='in_service'").c,
  fault: get("SELECT COUNT(*) c FROM devices WHERE status='fault'").c,
  inStock: get("SELECT COUNT(*) c FROM devices WHERE status='in_stock'").c,
  offline: gapCurrent.filter((g) => g.type !== 'no_data').length,
  readings: get('SELECT COUNT(*) c FROM readings').c,
  bills: bills.length,
  payments: payments.length,
  replacements: replacements.length,
};

const snapshot = {
  generatedAt: nowStr(),
  asOf: get('SELECT MAX(read_at) m FROM readings')?.m || null,
  stats,
  lastPeriod,
  meta: {
    areas: all('SELECT * FROM areas ORDER BY id'),
    communities: all('SELECT c.*, a.name AS area_name FROM communities c JOIN areas a ON a.id=c.area_id ORDER BY c.id'),
    tariffs: all('SELECT * FROM tariffs ORDER BY id'),
    periods: periodRuns,
    today: ymd(new Date()),
    asOf: get('SELECT MAX(read_at) m FROM readings')?.m || null,
  },
  accounts, points, segments, devices, bills, payments, allocations,
  adjustments, replacements, readings, usage,
  alerts, gaps: { current: gapCurrent, history: gapHistory },
  faultDevices, periodRuns,
};

/* ------------------------------ 产物 ------------------------------ */

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'js'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });

const json = JSON.stringify(snapshot);
await fsp.writeFile(path.join(OUT, 'data/snapshot.json'), json);

await fsp.copyFile(path.join(PUBLIC, 'app.css'), path.join(OUT, 'app.css'));
await fsp.copyFile(path.join(PUBLIC, 'js/charts.js'), path.join(OUT, 'js/charts.js'));
await fsp.copyFile(path.join(PUBLIC, 'js/core.js'), path.join(OUT, 'js/core.js'));
await fsp.copyFile(path.join(PUBLIC, 'js/app.js'), path.join(OUT, 'js/app.js'));
await fsp.copyFile(path.join(PUBLIC, 'js/static-api.js'), path.join(OUT, 'js/static-api.js'));
fs.mkdirSync(path.join(OUT, 'js/pages'), { recursive: true });
for (const f of fs.readdirSync(path.join(PUBLIC, 'js/pages'))) {
  await fsp.copyFile(path.join(PUBLIC, 'js/pages', f), path.join(OUT, 'js/pages', f));
}

function rewrite(html) {
  return html
    .replace(/href="\/app\.css"/g, 'href="./app.css"')
    .replace(/href="\/pay"/g, 'href="./pay.html"')
    .replace(/href="\/"/g, 'href="./index.html"')
    .replace(/src="\/js\//g, 'src="./js/')
    .replace('</head>', '  <script src="./js/static-api.js"></script>\n</head>');
}

const indexHtml = rewrite(await fsp.readFile(path.join(PUBLIC, 'index.html'), 'utf8'))
  .replace('<script type="module" src="./js/app.js"></script>', '<script type="module" src="./js/app.js"></script>');
await fsp.writeFile(path.join(OUT, 'index.html'), indexHtml);

let payHtml = rewrite(await fsp.readFile(path.join(PUBLIC, 'pay.html'), 'utf8'));
payHtml = payHtml.replace('href="/"', 'href="./index.html"').replace('href="/index.html"', 'href="./index.html"');
await fsp.writeFile(path.join(OUT, 'pay.html'), payHtml);

await fsp.writeFile(path.join(OUT, '.nojekyll'), '');

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log('静态站已生成：', OUT);
console.log('  snapshot.json', kb(Buffer.byteLength(json)));
console.log('  账户', accounts.length, '| 账单', bills.length, '| 支付', payments.length,
  '| 抄表', readings.length, '| 告警', alerts.length);
console.log('  数据时点', snapshot.asOf, '| 最后账期', lastPeriod);
