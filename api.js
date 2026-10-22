import crypto from 'node:crypto';
import { all, get, run, tx } from './db.js';
import * as B from './lib/billing.js';
import { seed } from './lib/seed.js';
import { collectAlerts } from './lib/alerts.js';
import { simulateMonth, mockPush, forceFault } from './lib/mock.js';
import {
  nowStr, todayStr, periodOf, prevPeriod, nextPeriod, round1, round2, ymd, parseDate,
  addDays, periodEnd, nonEmpty, randomId,
} from './lib/util.js';

/* ------------------------------------------------------------------ */
/* 基础设施                                                            */
/* ------------------------------------------------------------------ */

export const sessions = new Map();
const SESSION_TTL = 1000 * 60 * 60 * 12;

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const bad = (msg, status = 400) => { throw new HttpError(msg, status); };
const ok = (body, status = 200) => ({ status, body });

const routes = [];
function R(method, pattern, handler, { auth = true } = {}) {
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/:[A-Za-z]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$'
  );
  routes.push({ method, re, keys, handler, auth });
}

export async function dispatch(ctx) {
  const { req } = ctx;
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(ctx.pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
    ctx.params = params;
    ctx.query = Object.fromEntries(ctx.url.searchParams.entries());
    ctx.body = ctx.body || {};
    ctx.ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

    if (r.auth) {
      const user = currentUser(req);
      if (!user) return { status: 401, body: { error: '未登录或登录已过期' } };
      ctx.user = user;
    }
    try {
      return await r.handler(ctx);
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
      throw e;
    }
  }
  return { status: 404, body: { error: `接口不存在: ${req.method} ${ctx.pathname}` } };
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((s) => {
    const i = s.indexOf('=');
    if (i > 0) out[s.slice(0, i).trim()] = decodeURIComponent(s.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) {
  const token = parseCookies(req).psid;
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(token); return null; }
  return s.user;
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}
function verify(password, stored) {
  const [salt, hash] = String(stored).split(':');
  const h = crypto.scryptSync(password, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
}
function audit(ctx, action, targetType, targetId, detail) {
  run(
    `INSERT INTO audit_logs (user_name, action, target_type, target_id, detail, ip, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    ctx.user?.name || '匿名', action, targetType, String(targetId || ''), JSON.stringify(detail || {}), ctx.ip, nowStr()
  );
}

const CHANNEL_NAMES = { wechat: '微信支付', alipay: '支付宝', bank: '银行代扣', cash: '营业厅现金', mock: '模拟网关' };
const STATUS_NAMES = {
  active: '正常', suspended: '暂停', closed: '销户', pending: '待开户',
  in_service: '在运', in_stock: '库存', fault: '故障', returned: '返厂', scrapped: '报废',
};

/* 健康检查（容器 / PaaS 探针，无需登录） */
R('GET', '/api/healthz', () => {
  const db = get('SELECT COUNT(*) c FROM accounts');
  return ok({
    ok: true, service: 'power-admin', version: '1.0.0',
    accounts: db.c, uptime: Math.round(process.uptime()), now: nowStr(),
  });
}, { auth: false });

/* ------------------------------------------------------------------ */
/* 认证                                                                */
/* ------------------------------------------------------------------ */

R('POST', '/api/auth/login', ({ body, req, res }) => {
  const { username, password } = body;
  if (!username || !password) bad('请输入账号和密码');
  const user = get('SELECT * FROM users WHERE username = ?', username);
  if (!user || !verify(password, user.password)) bad('账号或密码错误', 401);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, {
    user: { id: user.id, name: user.name, role: user.role, username: user.username },
    exp: Date.now() + SESSION_TTL,
  });
  run('UPDATE users SET last_login = ? WHERE id = ?', nowStr(), user.id);
  res.setHeader('Set-Cookie', `psid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`);
  return ok({ user: { id: user.id, name: user.name, role: user.role, username: user.username } });
}, { auth: false });

R('POST', '/api/auth/logout', ({ req, res }) => {
  const token = parseCookies(req).psid;
  sessions.delete(token);
  res.setHeader('Set-Cookie', 'psid=; Path=/; HttpOnly; Max-Age=0');
  return ok({ success: true });
}, { auth: false });

R('GET', '/api/auth/me', ({ user }) => ok({ user }));

/* ------------------------------------------------------------------ */
/* 基础字典                                                            */
/* ------------------------------------------------------------------ */

R('GET', '/api/meta', () => ok({
  areas: all('SELECT * FROM areas ORDER BY id'),
  communities: all(`SELECT c.*, a.name AS area_name FROM communities c JOIN areas a ON a.id=c.area_id ORDER BY c.id`),
  tariffs: all('SELECT * FROM tariffs ORDER BY id'),
  channels: Object.entries(CHANNEL_NAMES).map(([k, v]) => ({ value: k, label: v })),
  statuses: Object.entries(STATUS_NAMES).map(([k, v]) => ({ value: k, label: v })),
  today: todayStr(),
  asOf: get('SELECT MAX(read_at) m FROM readings')?.m || null,
  periods: all('SELECT period, ran_at, accounts_cnt, kwh, amount FROM period_runs ORDER BY period DESC'),
}));

/* ------------------------------------------------------------------ */
/* 看板                                                                */
/* ------------------------------------------------------------------ */

R('GET', '/api/dashboard', ({ query }) => {
  const lastRun = get('SELECT MAX(period) AS p FROM period_runs');
  const period = query.period || lastRun?.p || prevPeriod(periodOf(new Date()), 1);

  const accountsCnt = get(`SELECT COUNT(*) c, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active FROM accounts`);
  const deviceCnt = get(
    `SELECT COUNT(*) total,
       SUM(CASE WHEN status='in_service' THEN 1 ELSE 0 END) in_service,
       SUM(CASE WHEN status='fault' THEN 1 ELSE 0 END) fault,
       SUM(CASE WHEN status='in_stock' THEN 1 ELSE 0 END) in_stock
     FROM devices`
  );
  const offline = get(
    `SELECT COUNT(*) c FROM metering_points p
     JOIN accounts a ON a.id = p.account_id
     JOIN segments s ON s.point_id = p.id AND s.status='active'
     JOIN devices d ON d.id = s.device_id
     WHERE a.status='active' AND d.status='in_service'
       AND (SELECT MAX(read_at) FROM readings r WHERE r.point_id=p.id) < date('now','-2 day')`
  );

  const billAgg = get(
    `SELECT COUNT(*) cnt, SUM(usage_kwh) kwh, SUM(total_amount) amount, SUM(paid_amount) paid
     FROM bills WHERE period = ?`, period
  );
  const arrear = get(
    `SELECT SUM(total_amount - paid_amount) amt, COUNT(DISTINCT account_id) cnt
     FROM bills WHERE status NOT IN ('void','paid') AND total_amount > paid_amount`
  );

  const trend = all(
    `SELECT period, ROUND(SUM(usage_kwh),1) kwh, ROUND(SUM(total_amount),2) amount,
            ROUND(SUM(paid_amount),2) paid, COUNT(*) cnt
     FROM bills WHERE period <= ? GROUP BY period ORDER BY period DESC LIMIT 12`, period
  ).reverse();

  const channels = all(
    `SELECT channel, ROUND(SUM(amount),2) amount, COUNT(*) cnt
     FROM payments WHERE status='success' GROUP BY channel ORDER BY amount DESC`
  ).map((c) => ({ ...c, label: CHANNEL_NAMES[c.channel] || c.channel }));

  const property = all(
    `SELECT a.property_type AS type, COUNT(DISTINCT a.id) cnt,
            ROUND(SUM(b.usage_kwh),1) kwh, ROUND(SUM(b.total_amount),2) amount
     FROM bills b JOIN accounts a ON a.id=b.account_id
     WHERE b.period=? GROUP BY a.property_type ORDER BY kwh DESC`, period
  );

  const topUsage = all(
    `SELECT a.id, a.account_no, a.customer_name, a.address, a.property_type,
            b.usage_kwh, b.total_amount, b.status
     FROM bills b JOIN accounts a ON a.id=b.account_id
     WHERE b.period=? ORDER BY b.usage_kwh DESC LIMIT 8`, period
  );

  const arrearsTop = all(
    `SELECT a.id, a.account_no, a.customer_name, a.phone,
            ROUND(SUM(b.total_amount - b.paid_amount),2) outstanding,
            COUNT(*) bills_cnt, MAX(b.period) last_period
     FROM bills b JOIN accounts a ON a.id=b.account_id
     WHERE b.status NOT IN ('void','paid') AND b.total_amount > b.paid_amount
     GROUP BY a.id ORDER BY outstanding DESC LIMIT 8`
  );

  const faultDevices = all(
    `SELECT d.asset_no, d.vendor, d.model, d.offline_since, a.account_no, a.customer_name
     FROM devices d
     LEFT JOIN segments s ON s.id = (SELECT id FROM segments WHERE device_id=d.id ORDER BY seq DESC LIMIT 1)
     LEFT JOIN metering_points p ON p.id=s.point_id
     LEFT JOIN accounts a ON a.id=p.account_id
     WHERE d.status IN ('fault','returned')
     ORDER BY CASE d.status WHEN 'fault' THEN 0 ELSE 1 END, d.id DESC LIMIT 3`
  );

  const replByStatus = all(`SELECT status, COUNT(*) cnt FROM replacements GROUP BY status`);
  const replByReason = all(
    `SELECT reason, COUNT(*) cnt FROM replacements GROUP BY reason ORDER BY cnt DESC`
  );
  const recentRepl = all(
    `SELECT r.*, a.account_no, a.customer_name FROM replacements r
     JOIN accounts a ON a.id=r.account_id ORDER BY r.created_at DESC, r.id DESC LIMIT 5`
  );

  const asOf = get('SELECT MAX(read_at) m FROM readings')?.m || null;
  const alerts = collectAlerts();
  const alertSummary = {
    total: alerts.length,
    high: alerts.filter((a) => a.severity === 'high').length,
    medium: alerts.filter((a) => a.severity === 'medium').length,
    low: alerts.filter((a) => a.severity === 'low').length,
    top: alerts.slice(0, 5),
  };

  return ok({
    period, asOf,
    kpi: {
      accounts: accountsCnt.c, activeAccounts: accountsCnt.active || 0,
      devices: deviceCnt.total || 0, inService: deviceCnt.in_service || 0,
      fault: deviceCnt.fault || 0, inStock: deviceCnt.in_stock || 0,
      offline: offline.c || 0,
      usage: round1(billAgg.kwh || 0),
      billed: round2(billAgg.amount || 0),
      paid: round2(billAgg.paid || 0),
      collectionRate: billAgg.amount ? round2((billAgg.paid / billAgg.amount) * 100) : 0,
      arrearsAmount: round2(arrear.amt || 0),
      arrearsAccounts: arrear.cnt || 0,
      bills: billAgg.cnt || 0,
    },
    trend, channels, property, topUsage, arrearsTop, faultDevices,
    replacements: { byStatus: replByStatus, byReason: replByReason, recent: recentRepl },
    alerts: alertSummary,
  });
});

/* ------------------------------------------------------------------ */
/* 户档案                                                              */
/* ------------------------------------------------------------------ */

const ACCOUNT_BASE = `
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
  LEFT JOIN communities c ON c.id=a.community_id`;

R('GET', '/api/accounts', ({ query }) => {
  const where = ['1=1'];
  const args = [];
  if (query.q) {
    where.push(`(a.account_no LIKE ? OR a.customer_name LIKE ? OR a.owner_name LIKE ? OR a.phone LIKE ? OR a.address LIKE ?)`);
    const like = `%${query.q}%`;
    args.push(like, like, like, like, like);
  }
  if (query.status) { where.push('a.status = ?'); args.push(query.status); }
  if (query.area) { where.push('a.area_id = ?'); args.push(Number(query.area)); }
  if (query.property) { where.push('a.property_type = ?'); args.push(query.property); }
  if (query.arrears === '1') {
    where.push(`EXISTS (SELECT 1 FROM bills b WHERE b.account_id=a.id AND b.status NOT IN ('void','paid') AND b.total_amount>b.paid_amount)`);
  }
  if (query.offline === '1') {
    where.push(`(SELECT MAX(r.read_at) FROM readings r JOIN metering_points p ON p.id=r.point_id WHERE p.account_id=a.id) < date('now','-2 day')`);
  }
  const page = Math.max(1, Number(query.page) || 1);
  const size = Math.min(100, Number(query.size) || 12);
  const whereSql = where.join(' AND ');
  const total = get(`SELECT COUNT(*) c FROM accounts a WHERE ${whereSql}`, ...args).c;
  const items = all(
    `${ACCOUNT_BASE} WHERE ${whereSql} ORDER BY a.account_no LIMIT ? OFFSET ?`,
    ...args, size, (page - 1) * size
  );
  return ok({ items, total, page, size, pages: Math.ceil(total / size) || 1 });
});

R('GET', '/api/accounts/:id', ({ params }) => {
  const id = Number(params.id);
  const account = get(`${ACCOUNT_BASE} WHERE a.id=?`, id);
  if (!account) bad('用户不存在', 404);

  const points = all('SELECT * FROM metering_points WHERE account_id=? ORDER BY id', id);
  const segments = all(
    `SELECT s.*, d.asset_no, d.model, d.vendor, d.imei, d.status AS device_status,
            d.last_seen_at, d.ratio AS device_ratio, d.phase
     FROM segments s JOIN devices d ON d.id=s.device_id
     WHERE s.point_id IN (SELECT id FROM metering_points WHERE account_id=?)
     ORDER BY s.seq DESC`, id
  );
  const bills = all('SELECT * FROM bills WHERE account_id=? ORDER BY period DESC', id);
  const firstPeriod = bills.length ? bills[bills.length - 1].period : prevPeriod(periodOf(new Date()), 13);
  const usage = B.usageSeries(id, firstPeriod);
  const adjustments = all('SELECT * FROM adjustments WHERE account_id=? ORDER BY id DESC', id);
  const replacements = all('SELECT * FROM replacements WHERE account_id=? ORDER BY id DESC', id);
  const readings = all(
    `SELECT r.*, d.asset_no FROM readings r JOIN devices d ON d.id=r.device_id
     WHERE r.point_id IN (SELECT id FROM metering_points WHERE account_id=?)
     ORDER BY r.read_at DESC, r.id DESC LIMIT 30`, id
  );
  const payments = all('SELECT * FROM payments WHERE account_id=? ORDER BY id DESC LIMIT 10', id);

  return ok({ account, points, segments, bills, usage, adjustments, replacements, readings, payments });
});

R('POST', '/api/accounts', (ctx) => {
  const b = ctx.body || {};
  if (!b.customerName) bad('请填写用户姓名');
  if (!b.phone) bad('请填写联系方式');
  if (!b.openDate) bad('请填写开户日期');

  const area = b.areaId ? get('SELECT * FROM areas WHERE id=?', b.areaId) : get('SELECT * FROM areas ORDER BY id LIMIT 1');
  if (!area) bad('请先配置供电所');

  let accountNo = (b.accountNo || '').trim();
  if (accountNo) {
    if (get('SELECT id FROM accounts WHERE account_no=?', accountNo)) bad('户号已存在');
  } else {
    const maxNo = get(
      'SELECT MAX(CAST(SUBSTR(account_no,7) AS INTEGER)) m FROM accounts WHERE area_id=?', area.id
    );
    accountNo = `${area.code}${String((maxNo?.m || 0) + 1).padStart(6, '0')}`;
  }

  const now = nowStr();
  const addr = b.address || [b.communityName, b.building, b.unit, b.room].filter(Boolean).join(' ');
  const tariff = b.tariffId || get('SELECT id FROM tariffs WHERE property_type=? LIMIT 1', b.propertyType || '居民')?.id || null;

  const id = tx(() => {
    const accId = run(
      `INSERT INTO accounts (account_no, customer_name, owner_name, relation, id_type, id_no, phone, phone_alt,
        area_id, community_id, building, unit, room, address, property_type, tariff_id, contract_capacity,
        status, open_date, payment_method, auto_debit, credit_level, tags, remark, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      accountNo, b.customerName, b.ownerName || b.customerName, b.relation || '本人',
      b.idType || '身份证', b.idNo || null, b.phone, b.phoneAlt || null,
      area.id, b.communityId || null, b.building || null, b.unit || null, b.room || null, addr,
      b.propertyType || '居民', tariff, b.contractCapacity || null,
      'active', b.openDate, b.paymentMethod || 'wechat', b.autoDebit ? 1 : 0,
      b.creditLevel || 'B', b.tags || null, b.remark || null, now, now
    ).lastId;

    const pointId = run(
      `INSERT INTO metering_points (account_id, point_no, name, location, status, created_at)
       VALUES (?,?,?,?,?,?)`,
      accId, `${accountNo}-01`, b.propertyType === '商业' ? '商铺总表' : '户内总表', addr, 'active', now
    ).lastId;

    if (b.assetNo) {
      const dev = get('SELECT * FROM devices WHERE asset_no=?', b.assetNo);
      if (!dev) bad('电表资产编号不存在');
      if (dev.status === 'in_service') bad('该电表已在运，不能重复安装');
      run(`INSERT INTO segments (point_id, device_id, seq, start_date, start_reading, ratio, reason, status, created_at)
           VALUES (?,?,1,?,?,?,'新装','active',?)`,
        pointId, dev.id, b.openDate, Number(b.startReading) || 0, dev.ratio, now);
      run(`UPDATE devices SET status='in_service', installed_at=? WHERE id=?`, b.openDate, dev.id);
    }
    return accId;
  });

  audit(ctx, '创建用户档案', 'account', id, { accountNo, name: b.customerName });
  return ok({ id, accountNo });
});

R('PUT', '/api/accounts/:id', (ctx) => {
  const id = Number(ctx.params.id);
  const acc = get('SELECT * FROM accounts WHERE id=?', id);
  if (!acc) bad('用户不存在', 404);
  const b = ctx.body || {};
  const map = {
    customerName: 'customer_name', ownerName: 'owner_name', relation: 'relation', idType: 'id_type',
    idNo: 'id_no', phone: 'phone', phoneAlt: 'phone_alt', areaId: 'area_id', communityId: 'community_id',
    building: 'building', unit: 'unit', room: 'room', address: 'address', propertyType: 'property_type',
    tariffId: 'tariff_id', contractCapacity: 'contract_capacity', status: 'status', openDate: 'open_date',
    paymentMethod: 'payment_method', autoDebit: 'auto_debit', creditLevel: 'credit_level', tags: 'tags',
    remark: 'remark', closeDate: 'close_date',
  };
  const sets = [];
  const args = [];
  for (const [k, col] of Object.entries(map)) {
    if (b[k] !== undefined) {
      sets.push(`${col}=?`);
      args.push(k === 'autoDebit' ? (b[k] ? 1 : 0) : nonEmpty(b[k]));
    }
  }
  if (!sets.length) bad('没有需要更新的字段');
  sets.push('updated_at=?');
  args.push(nowStr(), id);
  run(`UPDATE accounts SET ${sets.join(',')} WHERE id=?`, ...args);
  audit(ctx, '修改用户档案', 'account', id, b);
  return ok({ success: true });
});

R('POST', '/api/accounts/:id/status', (ctx) => {
  const id = Number(ctx.params.id);
  const { status } = ctx.body || {};
  if (!['active', 'suspended', 'closed'].includes(status)) bad('非法状态');
  run('UPDATE accounts SET status=?, close_date=?, updated_at=? WHERE id=?',
    status, status === 'closed' ? todayStr() : null, nowStr(), id);
  audit(ctx, '变更户状态', 'account', id, { status });
  return ok({ success: true });
});

/* -------------------------- 批量导入 -------------------------- */

const IMPORT_COLS = {
  accountNo: ['户号', 'account_no'],
  customerName: ['用户姓名', '姓名', 'customer_name'],
  ownerName: ['户主', '户主姓名', 'owner_name'],
  phone: ['联系方式', '手机号', '电话', 'phone'],
  communityName: ['小区', 'community'],
  building: ['楼栋', 'building'],
  unit: ['单元', 'unit'],
  room: ['房号', 'room'],
  address: ['家庭地址', '地址', 'address'],
  propertyType: ['用电性质', 'property_type'],
  assetNo: ['表号', '电表资产编号', 'asset_no'],
  openDate: ['开户日期', 'open_date'],
  remark: ['备注', 'remark'],
};

function parseCsv(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return { header: [], rows: [] };
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const split = (line) => {
    const out = [];
    let cur = '';
    let quote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quote && line[i + 1] === '"') { cur += '"'; i++; } else quote = !quote;
      } else if (ch === delim && !quote) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = split(lines[0]);
  const rows = lines.slice(1).map((l) => split(l));
  return { header, rows };
}

function mapImportHeader(header) {
  const idx = {};
  for (const [key, aliases] of Object.entries(IMPORT_COLS)) {
    const i = header.findIndex((h) => aliases.some((a) => h.replace(/\s/g, '') === a));
    if (i >= 0) idx[key] = i;
  }
  return idx;
}

R('POST', '/api/accounts/import/preview', (ctx) => {
  const { csv } = ctx.body || {};
  if (!csv) bad('请粘贴或上传 CSV 内容');
  const { header, rows } = parseCsv(csv);
  const idx = mapImportHeader(header);
  if (idx.customerName === undefined) bad('缺少必填列：用户姓名');
  const seen = new Set();
  const communities = all('SELECT * FROM communities');
  const areas = all('SELECT * FROM areas');

  const out = rows.map((row, i) => {
    const getv = (k) => (idx[k] !== undefined ? (row[idx[k]] || '').trim() : '');
    const item = {
      line: i + 2,
      accountNo: getv('accountNo'),
      customerName: getv('customerName'),
      ownerName: getv('ownerName') || getv('customerName'),
      phone: getv('phone'),
      communityName: getv('communityName'),
      building: getv('building'),
      unit: getv('unit'),
      room: getv('room'),
      address: getv('address'),
      propertyType: getv('propertyType') || '居民',
      assetNo: getv('assetNo'),
      openDate: getv('openDate') || todayStr(),
      remark: getv('remark'),
      errors: [],
      warnings: [],
    };
    if (!item.customerName) item.errors.push('缺少用户姓名');
    if (!item.phone) item.errors.push('缺少联系方式');
    else if (!/^1[3-9]\d{9}$/.test(item.phone)) item.errors.push('手机号格式不正确');
    if (item.accountNo && seen.has(item.accountNo)) item.errors.push('文件内户号重复');
    if (item.accountNo && get('SELECT id FROM accounts WHERE account_no=?', item.accountNo)) item.errors.push('户号已存在');
    if (item.accountNo) seen.add(item.accountNo);
    if (!['居民', '商业', '农业'].includes(item.propertyType)) item.errors.push('用电性质只能是 居民/商业/农业');
    if (item.assetNo) {
      const dev = get('SELECT * FROM devices WHERE asset_no=?', item.assetNo);
      if (!dev) item.errors.push('表号不存在于设备库');
      else if (dev.status === 'in_service') item.errors.push('该表已在运');
    }
    const comm = item.communityName ? communities.find((c) => c.name === item.communityName) : null;
    if (item.communityName && !comm) item.warnings.push('小区未匹配，将按地址建档');
    if (!item.address && !comm) item.warnings.push('无地址信息');
    item.communityId = comm?.id || null;
    item.areaId = comm?.area_id || areas[0]?.id;
    item._ok = item.errors.length === 0;
    return item;
  });

  return ok({
    header, matched: idx, total: out.length,
    valid: out.filter((r) => r._ok).length,
    invalid: out.filter((r) => !r._ok).length,
    rows: out,
  });
});

R('POST', '/api/accounts/import/commit', (ctx) => {
  const rows = (ctx.body || {}).rows || [];
  const valid = rows.filter((r) => r._ok || (r.errors || []).length === 0);
  if (!valid.length) bad('没有可导入的数据');
  const now = nowStr();
  let created = 0;
  tx(() => {
    for (const r of valid) {
      const area = r.areaId ? get('SELECT * FROM areas WHERE id=?', r.areaId) : get('SELECT * FROM areas LIMIT 1');
      let accountNo = r.accountNo;
      if (!accountNo) {
        const maxNo = get('SELECT MAX(CAST(SUBSTR(account_no,7) AS INTEGER)) m FROM accounts WHERE area_id=?', area.id);
        accountNo = `${area.code}${String((maxNo?.m || 0) + 1).padStart(6, '0')}`;
      }
      const addr = r.address || [r.communityName, r.building, r.unit, r.room].filter(Boolean).join(' ');
      const tariff = get('SELECT id FROM tariffs WHERE property_type=? LIMIT 1', r.propertyType);
      const accId = run(
        `INSERT INTO accounts (account_no, customer_name, owner_name, relation, phone, area_id, community_id,
          building, unit, room, address, property_type, tariff_id, status, open_date, payment_method,
          credit_level, remark, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,'wechat','B',?,?,?)`,
        accountNo, r.customerName, r.ownerName || r.customerName, r.ownerName && r.ownerName !== r.customerName ? '亲属' : '本人',
        r.phone, area?.id || null, r.communityId || null, r.building || null, r.unit || null, r.room || null,
        addr, r.propertyType, tariff?.id || null, r.openDate, r.remark || null, now, now
      ).lastId;
      const pointId = run(
        `INSERT INTO metering_points (account_id, point_no, name, location, status, created_at)
         VALUES (?,?,?,?, 'active', ?)`,
        accId, `${accountNo}-01`, r.propertyType === '商业' ? '商铺总表' : '户内总表', addr, now
      ).lastId;
      if (r.assetNo) {
        const dev = get('SELECT * FROM devices WHERE asset_no=?', r.assetNo);
        if (dev && dev.status !== 'in_service') {
          run(`INSERT INTO segments (point_id, device_id, seq, start_date, start_reading, ratio, reason, status, created_at)
               VALUES (?,?,1,?,0,?,'批量导入安装','active',?)`,
            pointId, dev.id, r.openDate, dev.ratio, now);
          run(`UPDATE devices SET status='in_service', installed_at=? WHERE id=?`, r.openDate, dev.id);
        }
      }
      created++;
    }
  });
  audit(ctx, '批量导入用户', 'account', '', { count: created });
  return ok({ created, skipped: rows.length - valid.length });
});

R('GET', '/api/accounts/import/template', ({ res }) => {
  const header = '户号,用户姓名,户主,联系方式,小区,楼栋,单元,房号,用电性质,表号,开户日期,备注';
  const sample = [
    '340102000901,张小明,张小明,13800001234,锦绣家园,第 1 栋,1 单元,101,居民,MT3401020901,2026-10-01,示例行可删除',
    ',李小红,李大强,13900005678,阳光新城,第 2 栋,2 单元,202,居民,,2026-10-01,无表号则仅建档',
  ].join('\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="account-import-template.csv"',
  });
  res.end('\uFEFF' + header + '\n' + sample);
  return undefined;
});

/* ------------------------------------------------------------------ */
/* 电表                                                                */
/* ------------------------------------------------------------------ */

R('GET', '/api/devices', ({ query }) => {
  const where = ['1=1'];
  const args = [];
  if (query.q) {
    where.push('(d.asset_no LIKE ? OR d.imei LIKE ? OR d.model LIKE ? OR d.vendor LIKE ?)');
    const like = `%${query.q}%`;
    args.push(like, like, like, like);
  }
  if (query.status) { where.push('d.status=?'); args.push(query.status); }
  const page = Math.max(1, Number(query.page) || 1);
  const size = Math.min(100, Number(query.size) || 12);
  const whereSql = where.join(' AND ');
  const total = get(`SELECT COUNT(*) c FROM devices d WHERE ${whereSql}`, ...args).c;
  const items = all(
    `SELECT d.*, s.status AS seg_status, s.start_date AS installed_seg_at,
       a.id AS account_id, a.account_no, a.customer_name, a.address
     FROM devices d
     LEFT JOIN segments s ON s.device_id=d.id AND s.status='active'
     LEFT JOIN metering_points p ON p.id=s.point_id
     LEFT JOIN accounts a ON a.id=p.account_id
     WHERE ${whereSql}
     ORDER BY d.id DESC LIMIT ? OFFSET ?`,
    ...args, size, (page - 1) * size
  );
  return ok({ items, total, page, size, pages: Math.ceil(total / size) || 1 });
});

R('GET', '/api/devices/:id', ({ params }) => {
  const d = get('SELECT * FROM devices WHERE id=?', Number(params.id));
  if (!d) bad('电表不存在', 404);
  const segs = all(
    `SELECT s.*, p.point_no, a.account_no, a.customer_name, a.address
     FROM segments s JOIN metering_points p ON p.id=s.point_id JOIN accounts a ON a.id=p.account_id
     WHERE s.device_id=? ORDER BY s.seq DESC`, d.id
  );
  const readings = all(
    `SELECT * FROM readings WHERE device_id=? ORDER BY read_at DESC LIMIT 30`, d.id
  );
  const repl = all('SELECT * FROM replacements WHERE old_device_id=? OR new_device_id=? ORDER BY id DESC', d.id, d.id);
  return ok({ device: d, segments: segs, readings, replacements: repl });
});

R('POST', '/api/devices', (ctx) => {
  const b = ctx.body || {};
  if (!b.assetNo) bad('请填写电表资产编号');
  if (get('SELECT id FROM devices WHERE asset_no=?', b.assetNo)) bad('资产编号已存在');
  const now = nowStr();
  const id = run(
    `INSERT INTO devices (asset_no, serial_no, model, vendor, protocol, imei, sim_no, module_no, ratio,
       accuracy, phase, voltage, firmware, status, manufacture_date, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'in_stock',?,?,?)`,
    b.assetNo, b.serialNo || null, b.model || null, b.vendor || null, b.protocol || 'DL/T645-2007',
    b.imei || null, b.simNo || null, b.moduleNo || null, Number(b.ratio) || 1,
    b.accuracy || '1.0 级', b.phase || '单相', b.voltage || '220V', b.firmware || null,
    b.manufactureDate || null, b.note || null, now
  ).lastId;

  if (b.accountNo) {
    const acc = get('SELECT * FROM accounts WHERE account_no=?', b.accountNo);
    if (!acc) bad('户号不存在');
    const point = get('SELECT * FROM metering_points WHERE account_id=? ORDER BY id LIMIT 1', acc.id);
    if (!point) bad('该户没有计量点');
    const active = get('SELECT * FROM segments WHERE point_id=? AND status=\'active\'', point.id);
    if (active) bad('该户已有在运电表，请通过换表工单更换');
    run(`INSERT INTO segments (point_id, device_id, seq, start_date, start_reading, ratio, reason, status, created_at)
         VALUES (?,?,1,?,?,?,'新装','active',?)`,
      point.id, id, b.installDate || todayStr(), Number(b.startReading) || 0, Number(b.ratio) || 1, now);
    run(`UPDATE devices SET status='in_service', installed_at=? WHERE id=?`, b.installDate || todayStr(), id);
  }
  audit(ctx, '新增电表', 'device', id, { assetNo: b.assetNo, bound: b.accountNo || null });
  return ok({ id, assetNo: b.assetNo });
});

/* ------------------------------------------------------------------ */
/* 抄表数据                                                            */
/* ------------------------------------------------------------------ */

R('GET', '/api/readings', ({ query }) => {
  const where = ['1=1'];
  const args = [];
  if (query.accountNo) { where.push('a.account_no = ?'); args.push(query.accountNo); }
  if (query.accountId) { where.push('a.id = ?'); args.push(Number(query.accountId)); }
  if (query.from) { where.push('r.read_at >= ?'); args.push(`${query.from} 00:00:00`); }
  if (query.to) { where.push('r.read_at <= ?'); args.push(`${query.to} 23:59:59`); }
  if (query.quality) { where.push('r.quality = ?'); args.push(query.quality); }
  if (query.source) { where.push('r.source = ?'); args.push(query.source); }
  const page = Math.max(1, Number(query.page) || 1);
  const size = Math.min(200, Number(query.size) || 20);
  const whereSql = where.join(' AND ');
  const base = `FROM readings r
    LEFT JOIN segments s ON s.id=r.segment_id
    JOIN metering_points p ON p.id=r.point_id
    JOIN accounts a ON a.id=p.account_id
    JOIN devices d ON d.id=r.device_id
    WHERE ${whereSql}`;
  const total = get(`SELECT COUNT(*) c ${base}`, ...args).c;
  const items = all(
    `SELECT r.*, a.account_no, a.customer_name, d.asset_no, s.seq AS seg_seq
     ${base}
     ORDER BY r.read_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    ...args, size, (page - 1) * size
  );
  return ok({ items, total, page, size, pages: Math.ceil(total / size) || 1 });
});

R('GET', '/api/readings/gaps', () => {
  const points = all(
    `SELECT p.id, p.point_no, a.id account_id, a.account_no, a.customer_name, a.phone,
       s.id seg_id, s.device_id, d.asset_no, d.status device_status,
       (SELECT MAX(read_at) FROM readings r WHERE r.point_id=p.id) last_at
     FROM metering_points p
     JOIN accounts a ON a.id=p.account_id
     JOIN segments s ON s.point_id=p.id AND s.status='active'
     JOIN devices d ON d.id=s.device_id
     WHERE a.status <> 'closed'`
  );
  const today = new Date();
  const out = [];
  for (const p of points) {
    if (!p.last_at) { out.push({ ...p, days: null, type: 'no_data' }); continue; }
    const days = Math.floor((today - new Date(p.last_at.replace(' ', 'T'))) / 86400000);
    if (days >= 2) out.push({ ...p, days, type: days >= 7 ? 'long_gap' : 'gap' });
  }
  // 历史断档（相邻读数间隔 > 3 天）
  const gaps = all(
    `WITH x AS (
       SELECT point_id, read_at, LAG(read_at) OVER (PARTITION BY point_id ORDER BY read_at) prev_at
       FROM readings WHERE superseded_by IS NULL)
     SELECT x.*, p.point_no, a.account_no, a.customer_name,
            CAST(julianday(x.read_at) - julianday(x.prev_at) AS INTEGER) days
     FROM x
     JOIN metering_points p ON p.id=x.point_id
     JOIN accounts a ON a.id=p.account_id
     WHERE x.prev_at IS NOT NULL
       AND julianday(x.read_at) - julianday(x.prev_at) > 5
     ORDER BY days DESC LIMIT 30`
  );
  return ok({ current: out, history: gaps });
});

R('POST', '/api/readings', (ctx) => {
  const b = ctx.body || {};
  const pointId = Number(b.pointId) || (b.accountNo
    ? get('SELECT id FROM metering_points WHERE account_id=(SELECT id FROM accounts WHERE account_no=?)', b.accountNo)?.id
    : null);
  if (!pointId) bad('未找到计量点');
  const seg = get("SELECT * FROM segments WHERE point_id=? AND status='active'", pointId);
  if (!seg) bad('该计量点没有在运电表，无法抄表');
  const reading = Number(b.reading);
  if (!Number.isFinite(reading) || reading < 0) bad('示数不合法');
  const readAt = b.readAt ? `${b.readAt} ${b.time || '12:00'}:00` : nowStr();

  const prev = get(
    `SELECT * FROM readings WHERE point_id=? AND read_at <= ? AND superseded_by IS NULL
     ORDER BY read_at DESC, id DESC LIMIT 1`, pointId, readAt
  );
  let quality = 'valid';
  const warnings = [];
  if (prev && reading < prev.reading) {
    quality = 'suspect';
    warnings.push(`示数 ${reading} 小于上一条 ${prev.reading}，已标记为异常待核查`);
  }
  const id = run(
    `INSERT INTO readings (point_id, segment_id, device_id, read_at, reading, source, quality, note, created_at)
     VALUES (?,?,?,?,?,'manual',?,?,?)`,
    pointId, seg.id, seg.device_id, readAt, reading, quality, b.note || null, nowStr()
  ).lastId;
  audit(ctx, '人工补录读数', 'reading', id, { pointId, reading, readAt });
  return ok({ id, quality, warnings });
});

/* ------------------------------------------------------------------ */
/* 换表工单                                                            */
/* ------------------------------------------------------------------ */

R('GET', '/api/replacements', ({ query }) => {
  const where = ['1=1'];
  const args = [];
  if (query.status) { where.push('r.status=?'); args.push(query.status); }
  if (query.q) {
    where.push('(a.account_no LIKE ? OR a.customer_name LIKE ? OR r.order_no LIKE ?)');
    const like = `%${query.q}%`;
    args.push(like, like, like);
  }
  return ok({
    items: all(
      `SELECT r.*, a.account_no, a.customer_name, a.phone, a.address, a.property_type,
              od.asset_no AS old_asset_no, nd.asset_no AS new_asset_no
       FROM replacements r
       JOIN accounts a ON a.id=r.account_id
       LEFT JOIN devices od ON od.id=r.old_device_id
       LEFT JOIN devices nd ON nd.id=r.new_device_id
       WHERE ${where.join(' AND ')}
       ORDER BY CASE r.status WHEN 'reported' THEN 0 WHEN 'processing' THEN 1 WHEN 'pending_review' THEN 2 ELSE 3 END,
                r.id DESC`, ...args
    ),
  });
});

R('POST', '/api/replacements', (ctx) => {
  const b = ctx.body || {};
  const acc = get('SELECT * FROM accounts WHERE account_no=?', b.accountNo);
  if (!acc) bad('户号不存在');
  const point = get('SELECT * FROM metering_points WHERE account_id=? ORDER BY id LIMIT 1', acc.id);
  if (!point) bad('该户没有计量点');
  const seg = get("SELECT * FROM segments WHERE point_id=? AND status='active'", point.id);
  const seqNo = get('SELECT COUNT(*) c FROM replacements').c + 1;
  const orderNo = `WO${todayStr().replace(/-/g, '')}${String(seqNo).padStart(3, '0')}`;
  const id = run(
    `INSERT INTO replacements (order_no, account_id, point_id, old_segment_id, old_device_id, solution,
       reason, fault_type, symptom, reported_at, planned_at, status, operator, remark, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'reported',?,?,?)`,
    orderNo, acc.id, point.id, seg?.id || null, seg?.device_id || null,
    b.solution || 'replace_meter', b.reason || 'meter_fault', b.faultType || '表计故障',
    b.symptom || null, nowStr(), b.plannedAt || null, ctx.user.name, b.remark || null, nowStr()
  ).lastId;
  audit(ctx, '创建换表工单', 'replacement', id, { orderNo });
  return ok({ id, orderNo });
});

R('POST', '/api/replacements/:id/review', (ctx) => {
  const id = Number(ctx.params.id);
  const r = get('SELECT * FROM replacements WHERE id=?', id);
  if (!r) bad('工单不存在', 404);
  if (r.status !== 'reported') bad('当前状态不可审核');
  const approve = ctx.body?.decision !== 'reject';
  run(`UPDATE replacements SET status=?, reviewer=?, reviewed_at=?, remark=COALESCE(?,remark) WHERE id=?`,
    approve ? 'processing' : 'cancelled', ctx.user.name, nowStr(), ctx.body?.remark || null, id);
  audit(ctx, approve ? '审核通过换表工单' : '驳回换表工单', 'replacement', id, {});
  return ok({ success: true, status: approve ? 'processing' : 'cancelled' });
});

R('POST', '/api/replacements/:id/complete', (ctx) => {
  const id = Number(ctx.params.id);
  const r = get('SELECT * FROM replacements WHERE id=?', id);
  if (!r) bad('工单不存在', 404);
  if (!['reported', 'processing', 'pending_review'].includes(r.status)) bad('当前状态不可完工');
  const b = ctx.body || {};
  const doneAt = b.doneAt || todayStr();
  const now = nowStr();

  const result = tx(() => {
    const seg = get("SELECT * FROM segments WHERE point_id=? AND status='active'", r.point_id);
    if (!seg) bad('计量点没有在运安装段');

    if (r.solution === 'replace_module') {
      // 表体保留：不产生新安装段，只更换通信模块
      run(`UPDATE devices SET module_no=?, last_seen_at=?, offline_since=NULL, status='in_service' WHERE id=?`,
        b.moduleNo || `MOD${Date.now().toString().slice(-8)}`, doneAt, seg.device_id);
    } else {
      // 整表更换：关闭旧段，装入新表，开启新段
      const oldFinal = Number(b.oldFinalReading);
      if (!Number.isFinite(oldFinal) || oldFinal < 0) bad('请填写拆表止码');
      const newStart = Number(b.newStartReading) || 0;
      const lastRead = get('SELECT reading FROM readings WHERE segment_id=? ORDER BY read_at DESC, id DESC LIMIT 1', seg.id);
      if (lastRead && oldFinal < lastRead.reading - 0.5) {
        bad(`拆表止码 ${oldFinal} 小于最后一次远程读数 ${lastRead.reading}，请核对`);
      }
      run(`UPDATE segments SET end_date=?, end_reading=?, end_reading_source=?, end_reading_quality=?,
             status='closed', work_order_no=? WHERE id=?`,
        doneAt, oldFinal, b.oldFinalSource || 'manual', 'valid', r.order_no, seg.id);

      let newDeviceId;
      if (b.newAssetNo) {
        const dev = get('SELECT * FROM devices WHERE asset_no=?', b.newAssetNo);
        if (!dev) bad('新表资产编号不存在，请先在设备库新增');
        if (dev.status === 'in_service') bad('该新表已在运');
        newDeviceId = dev.id;
        run(`UPDATE devices SET status='in_service', installed_at=? WHERE id=?`, doneAt, dev.id);
      } else {
        const old = get('SELECT * FROM devices WHERE id=?', seg.device_id);
        newDeviceId = run(
          `INSERT INTO devices (asset_no, serial_no, model, vendor, protocol, ratio, accuracy, phase, voltage,
             status, installed_at, note, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,'in_service',?,?,?)`,
          `MTNEW${Date.now().toString().slice(-8)}`, `SN${Date.now().toString().slice(-9)}`,
          old.model, old.vendor, old.protocol, old.ratio, old.accuracy, old.phase, old.voltage,
          doneAt, '换表工单自动建档', now
        ).lastId;
      }
      const newSegId = run(
        `INSERT INTO segments (point_id, device_id, seq, start_date, start_reading, ratio, reason, status,
           work_order_no, created_at)
         VALUES (?,?,?,?,?,?,'更换电表','active',?,?)`,
        r.point_id, newDeviceId, Number(seg.seq) + 1, doneAt, newStart,
        get('SELECT ratio FROM devices WHERE id=?', newDeviceId).ratio, r.order_no, now
      ).lastId;
      // 装表起码作为新段第一条读数
      run(
        `INSERT INTO readings (point_id, segment_id, device_id, read_at, reading, source, quality, note, created_at)
         VALUES (?,?,?,?,?,'manual','valid','换表装表起码',?)`,
        r.point_id, newSegId, newDeviceId, `${doneAt} 00:05:00`, newStart, now
      );
      run(`UPDATE devices SET status='returned', removed_at=?, note='换表拆回' WHERE id=?`, doneAt, seg.device_id);
      run(`UPDATE replacements SET new_segment_id=?, new_device_id=?, old_final_reading=?, old_final_source=?,
             new_start_reading=? WHERE id=?`, newSegId, newDeviceId, oldFinal, b.oldFinalSource || 'manual', newStart, id);
    }

    run(`UPDATE replacements SET status='completed', done_at=?, operator=?, remark=COALESCE(?,remark) WHERE id=?`,
      doneAt, ctx.user.name, b.remark || null, id);
    return { doneAt };
  });

  audit(ctx, '换表完工', 'replacement', id, { orderNo: r.order_no, solution: r.solution, ...b });
  return ok({ success: true, ...result });
});

/* ------------------------------------------------------------------ */
/* 账单                                                                */
/* ------------------------------------------------------------------ */

R('GET', '/api/bills', ({ query }) => {
  const where = ['1=1'];
  const args = [];
  if (query.period) { where.push('b.period=?'); args.push(query.period); }
  if (query.status) {
    if (query.status === 'unpaid') where.push(`b.status IN ('issued','partial','overdue') AND b.paid_amount < b.total_amount`);
    else { where.push('b.status=?'); args.push(query.status); }
  }
  if (query.q) {
    where.push('(a.account_no LIKE ? OR a.customer_name LIKE ? OR a.phone LIKE ?)');
    const like = `%${query.q}%`;
    args.push(like, like, like);
  }
  const page = Math.max(1, Number(query.page) || 1);
  const size = Math.min(100, Number(query.size) || 15);
  const whereSql = where.join(' AND ');
  const total = get(`SELECT COUNT(*) c FROM bills b JOIN accounts a ON a.id=b.account_id WHERE ${whereSql}`, ...args).c;
  const items = all(
    `SELECT b.*, a.account_no, a.customer_name, a.phone, a.address, a.property_type,
            ROUND(b.total_amount - b.paid_amount,2) outstanding
     FROM bills b JOIN accounts a ON a.id=b.account_id
     WHERE ${whereSql} ORDER BY b.period DESC, b.id DESC LIMIT ? OFFSET ?`,
    ...args, size, (page - 1) * size
  );
  const summary = get(
    `SELECT COUNT(*) cnt, ROUND(SUM(usage_kwh),1) kwh, ROUND(SUM(total_amount),2) amount,
            ROUND(SUM(paid_amount),2) paid,
            SUM(CASE WHEN b.status IN ('issued','partial','overdue') AND b.paid_amount<b.total_amount THEN 1 ELSE 0 END) unpaid_cnt,
            ROUND(SUM(CASE WHEN b.status IN ('issued','partial','overdue') THEN b.total_amount-b.paid_amount ELSE 0 END),2) outstanding
     FROM bills b JOIN accounts a ON a.id=b.account_id WHERE ${whereSql}`, ...args
  );
  return ok({ items, total, page, size, pages: Math.ceil(total / size) || 1, summary });
});

R('GET', '/api/bills/:id', ({ params }) => {
  const bill = B.billDetail(Number(params.id));
  if (!bill) bad('账单不存在', 404);
  return ok({ bill });
});

R('POST', '/api/bills/issue', (ctx) => {
  const period = ctx.body?.period;
  if (!/^\d{4}-\d{2}$/.test(period || '')) bad('账期格式应为 YYYY-MM');
  if (period > periodOf(new Date())) bad('不能对未结束的月份出账');
  const result = B.issuePeriod(period, ctx.user.name);
  audit(ctx, '生成账期账单', 'bill', period, result);
  return ok(result);
});

/* ------------------------------------------------------------------ */
/* 调整项                                                              */
/* ------------------------------------------------------------------ */

R('GET', '/api/adjustments', ({ query }) => {
  const where = ['1=1'];
  const args = [];
  if (query.status) { where.push('j.status=?'); args.push(query.status); }
  if (query.accountId) { where.push('j.account_id=?'); args.push(Number(query.accountId)); }
  return ok({
    items: all(
      `SELECT j.*, a.account_no, a.customer_name FROM adjustments j
       JOIN accounts a ON a.id=j.account_id WHERE ${where.join(' AND ')} ORDER BY j.id DESC`, ...args
    ),
  });
});

R('POST', '/api/adjustments', (ctx) => {
  const b = ctx.body || {};
  const acc = get('SELECT * FROM accounts WHERE account_no=?', b.accountNo);
  if (!acc) bad('户号不存在');
  if (b.type === 'backcharge' && !(Number(b.amount) > 0)) bad('追补金额必须大于 0');
  const id = B.addAdjustment({
    accountId: acc.id, period: b.period || periodOf(new Date()), type: b.type || 'backcharge',
    amount: b.type === 'refund' ? -Math.abs(Number(b.amount)) : Number(b.amount),
    usageKwh: Number(b.usageKwh) || 0, reason: b.reason || '', source: b.source || 'manual',
    actor: ctx.user.name,
  });
  audit(ctx, '新增调整项', 'adjustment', id, b);
  return ok({ id });
});

/* ------------------------------------------------------------------ */
/* 缴费                                                                */
/* ------------------------------------------------------------------ */

R('GET', '/api/payments', ({ query }) => {
  const where = ['1=1'];
  const args = [];
  if (query.channel) { where.push('p.channel=?'); args.push(query.channel); }
  if (query.status) { where.push('p.status=?'); args.push(query.status); }
  const page = Math.max(1, Number(query.page) || 1);
  const size = Math.min(100, Number(query.size) || 15);
  const total = get(`SELECT COUNT(*) c FROM payments p WHERE ${where.join(' AND ')}`, ...args).c;
  const items = all(
    `SELECT p.*, a.account_no, a.customer_name,
       (SELECT COUNT(*) FROM allocations al WHERE al.payment_id=p.id) bills_cnt
     FROM payments p JOIN accounts a ON a.id=p.account_id
     WHERE ${where.join(' AND ')} ORDER BY p.paid_at DESC, p.id DESC LIMIT ? OFFSET ?`,
    ...args, size, (page - 1) * size
  ).map((p) => ({ ...p, channel_name: CHANNEL_NAMES[p.channel] || p.channel }));
  const summary = get(
    `SELECT COUNT(*) cnt, ROUND(SUM(amount),2) amount FROM payments p WHERE ${where.join(' AND ')} AND p.status='success'`,
    ...args
  );
  return ok({ items, total, page, size, pages: Math.ceil(total / size) || 1, summary });
});

R('GET', '/api/payments/:id', ({ params }) => {
  const p = get(
    `SELECT p.*, a.account_no, a.customer_name, a.address FROM payments p
     JOIN accounts a ON a.id=p.account_id WHERE p.id=?`, Number(params.id)
  );
  if (!p) bad('支付记录不存在', 404);
  p.allocations = all(
    `SELECT al.*, b.period, b.bill_no, b.total_amount FROM allocations al
     JOIN bills b ON b.id=al.bill_id WHERE al.payment_id=?`, p.id
  );
  p.channel_name = CHANNEL_NAMES[p.channel] || p.channel;
  return ok({ payment: p });
});

/* ------------------------------------------------------------------ */
/* 异常中心                                                            */
/* ------------------------------------------------------------------ */

R('GET', '/api/alerts', () => ok({ items: collectAlerts() }));

/* ------------------------------------------------------------------ */
/* 系统 / 模拟器                                                       */
/* ------------------------------------------------------------------ */

R('GET', '/api/system/info', () => {
  const lastRun = get('SELECT MAX(period) p FROM period_runs');
  return ok({
    lastPeriod: lastRun?.p || null,
    currentPeriod: periodOf(new Date()),
    counts: {
      accounts: get('SELECT COUNT(*) c FROM accounts').c,
      devices: get('SELECT COUNT(*) c FROM devices').c,
      readings: get('SELECT COUNT(*) c FROM readings').c,
      bills: get('SELECT COUNT(*) c FROM bills').c,
      payments: get('SELECT COUNT(*) c FROM payments').c,
      replacements: get('SELECT COUNT(*) c FROM replacements').c,
    },
    runs: all('SELECT * FROM period_runs ORDER BY period DESC LIMIT 8'),
    dbsize: get("SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()")?.size || 0,
  });
});

R('POST', '/api/system/advance-month', (ctx) => {
  const out = simulateMonth();
  audit(ctx, '模拟推进一个月', 'system', '', out);
  return ok(out);
});

R('POST', '/api/system/reset', (ctx) => {
  const out = seed({ force: true });
  audit(ctx, '重置演示数据', 'system', '', out);
  return ok(out);
});

R('POST', '/api/mock/iot/push', (ctx) => {
  const out = mockPush(ctx.body || {});
  audit(ctx, '模拟设备上报', 'device', ctx.body?.assetNo, out);
  return ok(out);
});

R('POST', '/api/mock/fault', (ctx) => {
  const out = forceFault(ctx.body || {});
  audit(ctx, '模拟设备故障', 'device', ctx.body?.accountNo, out);
  return ok(out);
});

/* ------------------------------------------------------------------ */
/* 用户缴费端（公开）                                                   */
/* ------------------------------------------------------------------ */

function publicAccount(accountNo) {
  const acc = get(`${ACCOUNT_BASE} WHERE a.account_no=?`, accountNo);
  if (!acc) bad('户号不存在，请核对后重试', 404);
  return acc;
}

function maskAccount(a) {
  return {
    accountNo: a.account_no,
    customerName: a.customer_name ? a.customer_name[0] + '*'.repeat(Math.max(1, a.customer_name.length - 1)) : '—',
    address: a.address,
    propertyType: a.property_type,
    areaName: a.area_name,
    status: a.status,
    outstanding: a.outstanding || 0,
    lastPeriod: a.last_period,
  };
}

R('GET', '/api/public/lookup', ({ query }) => {
  const acc = publicAccount((query.accountNo || '').trim());
  const bills = all(
    `SELECT id, bill_no, period, usage_kwh, total_amount, paid_amount, status, due_date
     FROM bills WHERE account_id=? AND status NOT IN ('void') ORDER BY period DESC LIMIT 18`, acc.id
  ).map((b) => ({ ...b, outstanding: round2(b.total_amount - b.paid_amount) }));
  return ok({
    account: maskAccount(acc),
    bills,
    payable: bills.filter((b) => b.outstanding > 0.005),
  });
}, { auth: false });

R('POST', '/api/public/pay', (ctx) => {
  const { accountNo, billIds, channel = 'wechat', payerName = '' } = ctx.body || {};
  const acc = publicAccount((accountNo || '').trim());
  if (!Array.isArray(billIds) || !billIds.length) bad('请选择要缴纳的账单');
  if (!['wechat', 'alipay', 'mock'].includes(channel)) bad('不支持的支付方式');
  const paid = B.payBills({
    accountId: acc.id, billIds: billIds.map(Number), channel,
    payerName: payerName || acc.customer_name,
    idempotencyKey: ctx.body?.idempotencyKey || `pub-${acc.id}-${billIds.join('-')}-${Date.now()}`,
  });
  return ok({
    success: true, payNo: paid.payNo, amount: paid.amount,
    channel: CHANNEL_NAMES[channel] || channel,
    paidAt: nowStr(), bills: paid.bills, accountNo: acc.account_no,
  });
}, { auth: false });

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

R('GET', '/api/export/bills', ({ query, res }) => {
  const period = query.period;
  const rows = all(
    `SELECT a.account_no, a.customer_name, a.address, b.period, b.usage_kwh, b.energy_fee,
            b.adjustment, b.total_amount, b.paid_amount, b.status, b.due_date
     FROM bills b JOIN accounts a ON a.id=b.account_id
     WHERE (? IS NULL OR b.period = ?) ORDER BY a.account_no`, period || null, period || null
  );
  const head = '户号,用户姓名,地址,账期,用电量(kWh),电费(元),调整(元),应收(元),实收(元),状态,到期日';
  const statusZh = { issued: '待缴', paid: '已缴', partial: '部分缴', overdue: '逾期', void: '作废' };
  const csv = [head, ...rows.map((r) => [
    r.account_no, r.customer_name, `"${(r.address || '').replace(/"/g, '""')}"`, r.period,
    r.usage_kwh, r.energy_fee, r.adjustment, r.total_amount, r.paid_amount,
    statusZh[r.status] || r.status, r.due_date,
  ].join(','))].join('\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="bills-${period || 'all'}.csv"`,
  });
  res.end('\uFEFF' + csv);
  return undefined;
});

R('GET', '/api/audit', ({ query }) => ok({
  items: all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?', Number(query.limit) || 30),
}));

/* 演示用：返回几个有欠费的户号，方便体验缴费流程 */
R('GET', '/api/public/demo', () => {
  const rows = all(
    `SELECT a.account_no, a.customer_name, ROUND(SUM(b.total_amount-b.paid_amount),2) amount,
            COUNT(*) cnt, MIN(b.period) first_period
     FROM bills b JOIN accounts a ON a.id=b.account_id
     WHERE b.status IN ('issued','partial','overdue') AND b.total_amount>b.paid_amount
     GROUP BY a.id ORDER BY amount DESC LIMIT 3`
  );
  return ok({ accounts: rows });
}, { auth: false });
