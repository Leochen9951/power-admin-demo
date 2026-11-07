/* ============================================================
   静态演示版数据层（GitHub Pages 用，无需后端）
   页面里的 fetch 会被 core.js 转到这里，用 snapshot.json 模拟接口。
   只读：除缴费外所有写操作都会抛出提示。
   ============================================================ */
(function () {
  window.__STATIC_DEMO__ = true;

  const ready = fetch('./data/snapshot.json')
    .then((r) => {
      if (!r.ok) throw new Error(`快照加载失败 (${r.status})`);
      return r.json();
    })
    .then((d) => {
      window.__SNAPSHOT__ = d;
      return d;
    });
  window.__staticReady = ready;

  const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const sum = (arr, f = (x) => x) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
  const CHANNEL_ZH = { wechat: '微信支付', alipay: '支付宝', bank: '银行代扣', cash: '营业厅现金', mock: '模拟网关' };

  function pageOf(sp) {
    const page = Math.max(1, Number(sp.get('page')) || 1);
    const size = Number(sp.get('size')) || 12;
    return { page, size };
  }
  function paginate(rows, page, size) {
    return {
      items: rows.slice((page - 1) * size, page * size),
      total: rows.length, page, size,
      pages: Math.ceil(rows.length / size) || 1,
    };
  }
  function keyword(sp) {
    return (sp.get('q') || '').trim().toLowerCase();
  }
  function matchQ(row, q, fields) {
    if (!q) return true;
    return fields.some((f) => String(row[f] || '').toLowerCase().includes(q));
  }

  /** 计算看板（与 api.js 的 /api/dashboard 同口径） */
  function buildDashboard(S, period) {
    const P = period || S.lastPeriod;
    const billsP = S.bills.filter((b) => b.period === P);
    const unpaid = S.bills.filter((b) => b.status !== 'void' && b.total_amount > b.paid_amount);
    const billed = r2(sum(billsP, (b) => b.total_amount));
    const paid = r2(sum(billsP, (b) => b.paid_amount));

    const periods = S.periodRuns.map((x) => x.period).filter((x) => x <= P).slice(0, 12).reverse();
    const trend = periods.map((per) => {
      const bs = S.bills.filter((b) => b.period === per);
      return {
        period: per, kwh: r1(sum(bs, (b) => b.usage_kwh)),
        amount: r2(sum(bs, (b) => b.total_amount)), paid: r2(sum(bs, (b) => b.paid_amount)), cnt: bs.length,
      };
    });

    const chMap = {};
    S.payments.filter((p) => p.status === 'success').forEach((p) => {
      chMap[p.channel] = chMap[p.channel] || { channel: p.channel, amount: 0, cnt: 0 };
      chMap[p.channel].amount += Number(p.amount) || 0;
      chMap[p.channel].cnt++;
    });
    const channels = Object.values(chMap)
      .map((c) => ({ ...c, amount: r2(c.amount), label: CHANNEL_ZH[c.channel] || c.channel }))
      .sort((a, b) => b.amount - a.amount);

    const propMap = {};
    billsP.forEach((b) => {
      const t = b.property_type || '居民';
      propMap[t] = propMap[t] || { type: t, cnt: 0, kwh: 0, amount: 0, ids: new Set() };
      propMap[t].ids.add(b.account_id);
      propMap[t].kwh += b.usage_kwh;
      propMap[t].amount += b.total_amount;
    });
    const property = Object.values(propMap).map((x) => ({
      type: x.type, cnt: x.ids.size, kwh: r1(x.kwh), amount: r2(x.amount),
    })).sort((a, b) => b.kwh - a.kwh);

    const topUsage = billsP.slice().sort((a, b) => b.usage_kwh - a.usage_kwh).slice(0, 8)
      .map((b) => ({
        id: b.account_id, account_no: b.account_no, customer_name: b.customer_name,
        address: b.address, property_type: b.property_type,
        usage_kwh: b.usage_kwh, total_amount: b.total_amount, status: b.status,
      }));

    const arMap = {};
    unpaid.forEach((b) => {
      const k = b.account_id;
      arMap[k] = arMap[k] || {
        id: k, account_no: b.account_no, customer_name: b.customer_name, phone: b.phone,
        outstanding: 0, bills_cnt: 0, last_period: b.period,
      };
      arMap[k].outstanding += b.total_amount - b.paid_amount;
      arMap[k].bills_cnt++;
    });
    const arrearsTop = Object.values(arMap)
      .map((a) => ({ ...a, outstanding: r2(a.outstanding) }))
      .sort((a, b) => b.outstanding - a.outstanding).slice(0, 8);

    const alerts = S.alerts;
    const replByStatus = {};
    S.replacements.forEach((x) => { replByStatus[x.status] = (replByStatus[x.status] || 0) + 1; });
    const replByReason = {};
    S.replacements.forEach((x) => { replByReason[x.reason] = (replByReason[x.reason] || 0) + 1; });

    return {
      period: P,
      asOf: S.asOf,
      kpi: {
        accounts: S.stats.accounts, activeAccounts: S.stats.activeAccounts,
        devices: S.stats.devices, inService: S.stats.inService, fault: S.stats.fault,
        inStock: S.stats.inStock, offline: S.stats.offline,
        usage: r1(sum(billsP, (b) => b.usage_kwh)),
        billed, paid,
        collectionRate: billed ? r2((paid / billed) * 100) : 0,
        arrearsAmount: r2(sum(unpaid, (b) => b.total_amount - b.paid_amount)),
        arrearsAccounts: Object.keys(arMap).length,
        bills: billsP.length,
      },
      trend, channels, property, topUsage, arrearsTop,
      faultDevices: S.faultDevices,
      replacements: {
        byStatus: Object.entries(replByStatus).map(([status, cnt]) => ({ status, cnt })),
        byReason: Object.entries(replByReason).map(([reason, cnt]) => ({ reason, cnt })),
        recent: S.replacements.slice(0, 5),
      },
      alerts: {
        total: alerts.length,
        high: alerts.filter((a) => a.severity === 'high').length,
        medium: alerts.filter((a) => a.severity === 'medium').length,
        low: alerts.filter((a) => a.severity === 'low').length,
        top: alerts.slice(0, 5),
      },
    };
  }

  /* ---------------------------- 路由 ---------------------------- */

  async function handle(path, opts) {
    const S = await ready;
    const method = (opts && opts.method) || 'GET';
    const qi = path.indexOf('?');
    const rawPath = qi >= 0 ? path.slice(0, qi) : path;
    const sp = new URLSearchParams(qi >= 0 ? path.slice(qi + 1) : '');
    const api = rawPath.slice(rawPath.indexOf('/api/'));
    const body = (opts && opts.body) || {};

    if (method !== 'GET') {
      if (api === '/api/public/pay') return payStatic(S, body);
      if (api === '/api/auth/login') return { user: demoUser() };
      if (api === '/api/auth/logout') return { success: true };
      throw new Error('静态演示版为只读快照，该操作需要在完整版中体验');
    }

    if (api === '/api/auth/me') return { user: demoUser() };
    if (api === '/api/meta') return { ...S.meta, periods: S.periodRuns };
    if (api === '/api/dashboard') return buildDashboard(S, sp.get('period'));
    if (api === '/api/alerts') return { items: S.alerts };
    if (api === '/api/readings/gaps') return S.gaps;
    if (api === '/api/system/info') {
      return {
        lastPeriod: S.lastPeriod, currentPeriod: S.meta.today.slice(0, 7),
        counts: {
          accounts: S.stats.accounts, devices: S.stats.devices, readings: S.stats.readings,
          bills: S.stats.bills, payments: S.stats.payments, replacements: S.stats.replacements,
        },
        runs: S.periodRuns.slice(0, 8), dbsize: 0,
      };
    }
    if (api === '/api/audit') return { items: [] };
    if (api === '/api/public/demo') return { accounts: demoAccounts(S) };

    if (api === '/api/public/lookup') {
      const acc = S.accounts.find((a) => a.account_no === sp.get('accountNo'));
      if (!acc) throw Object.assign(new Error('户号不存在，请核对后重试'), { status: 404 });
      return publicLookup(S, acc);
    }

    let m;
    if ((m = api.match(/^\/api\/accounts\/(\d+)$/))) return accountDetail(S, Number(m[1]));
    if (api === '/api/accounts') return accountList(S, sp);
    if ((m = api.match(/^\/api\/devices\/(\d+)$/))) return deviceDetail(S, Number(m[1]));
    if (api === '/api/devices') return deviceList(S, sp);
    if (api === '/api/readings') return readingList(S, sp);
    if (api === '/api/replacements') return { items: replacementList(S, sp) };
    if ((m = api.match(/^\/api\/bills\/(\d+)$/))) return billDetail(S, Number(m[1]));
    if (api === '/api/bills') return billList(S, sp);
    if ((m = api.match(/^\/api\/payments\/(\d+)$/))) return paymentDetail(S, Number(m[1]));
    if (api === '/api/payments') return paymentList(S, sp);
    if (api === '/api/adjustments') return { items: adjustmentList(S, sp) };

    throw new Error(`静态演示版未提供该接口：${api}`);
  }

  const demoUser = () => ({ id: 0, name: '演示账号', role: 'admin', username: 'demo' });

  /* ---------------------------- 具体实现 ---------------------------- */

  function accountList(S, sp) {
    const q = keyword(sp);
    let rows = S.accounts.filter((a) =>
      matchQ(a, q, ['account_no', 'customer_name', 'owner_name', 'phone', 'address']));
    if (sp.get('status')) rows = rows.filter((a) => a.status === sp.get('status'));
    if (sp.get('area')) rows = rows.filter((a) => String(a.area_id) === String(sp.get('area')));
    if (sp.get('property')) rows = rows.filter((a) => a.property_type === sp.get('property'));
    if (sp.get('arrears') === '1') rows = rows.filter((a) => Number(a.outstanding) > 0);
    if (sp.get('offline') === '1') rows = rows.filter((a) => isOffline(a.last_reading_at));
    const { page, size } = pageOf(sp);
    return paginate(rows, page, size);
  }

  function isOffline(lastAt) {
    if (!lastAt) return true;
    const limit = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    return String(lastAt).slice(0, 10) < limit;
  }

  function accountDetail(S, id) {
    const account = S.accounts.find((a) => a.id === id);
    if (!account) throw new Error('用户不存在');
    const points = S.points.filter((p) => p.account_id === id);
    const pids = points.map((p) => p.id);
    const segments = S.segments.filter((s) => pids.includes(s.point_id)).sort((a, b) => b.seq - a.seq);
    const bills = S.bills.filter((b) => b.account_id === id);
    const readings = S.readings.filter((r) => pids.includes(r.point_id)).slice(0, 30);
    return {
      account, points, segments, bills,
      usage: S.usage[id] || {},
      adjustments: S.adjustments.filter((a) => a.account_id === id),
      replacements: S.replacements.filter((r) => r.account_id === id),
      readings,
      payments: S.payments.filter((p) => p.account_id === id).slice(0, 10),
    };
  }

  function deviceList(S, sp) {
    const q = keyword(sp);
    let rows = S.devices.filter((d) => matchQ(d, q, ['asset_no', 'imei', 'model', 'vendor']));
    if (sp.get('status')) rows = rows.filter((d) => d.status === sp.get('status'));
    const { page, size } = pageOf(sp);
    return paginate(rows, page, size);
  }

  function deviceDetail(S, id) {
    const device = S.devices.find((d) => d.id === id);
    if (!device) throw new Error('电表不存在');
    const segs = S.segments.filter((s) => s.device_id === id).map((s) => {
      const acc = S.accounts.find((a) => a.id === s.account_id) || {};
      return { ...s, account_no: acc.account_no, customer_name: acc.customer_name, address: acc.address };
    });
    return {
      device,
      segments: segs,
      readings: S.readings.filter((r) => r.device_id === id).slice(0, 30),
      replacements: S.replacements.filter((r) => r.old_device_id === id || r.new_device_id === id),
    };
  }

  function readingList(S, sp) {
    let rows = S.readings;
    if (sp.get('accountNo')) rows = rows.filter((r) => r.account_no === sp.get('accountNo'));
    if (sp.get('accountId')) {
      const pts = S.points.filter((p) => String(p.account_id) === String(sp.get('accountId'))).map((p) => p.id);
      rows = rows.filter((r) => pts.includes(r.point_id));
    }
    if (sp.get('from')) rows = rows.filter((r) => r.read_at >= `${sp.get('from')} 00:00:00`);
    if (sp.get('to')) rows = rows.filter((r) => r.read_at <= `${sp.get('to')} 23:59:59`);
    if (sp.get('quality')) rows = rows.filter((r) => r.quality === sp.get('quality'));
    if (sp.get('source')) rows = rows.filter((r) => r.source === sp.get('source'));
    rows = rows.slice().sort((a, b) => (a.read_at < b.read_at ? 1 : a.read_at > b.read_at ? -1 : b.id - a.id));
    const { page, size } = pageOf(sp);
    return paginate(rows, page, size);
  }

  function replacementList(S, sp) {
    const q = keyword(sp);
    let rows = S.replacements.filter((r) =>
      matchQ(r, q, ['account_no', 'customer_name', 'order_no']));
    if (sp.get('status')) rows = rows.filter((r) => r.status === sp.get('status'));
    const order = { reported: 0, processing: 1, pending_review: 2 };
    return rows.slice().sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || b.id - a.id);
  }

  function billList(S, sp) {
    let rows = S.bills;
    if (sp.get('period')) rows = rows.filter((b) => b.period === sp.get('period'));
    if (sp.get('status')) {
      if (sp.get('status') === 'unpaid') {
        rows = rows.filter((b) => ['issued', 'partial', 'overdue'].includes(b.status) && b.paid_amount < b.total_amount);
      } else {
        rows = rows.filter((b) => b.status === sp.get('status'));
      }
    }
    const q = keyword(sp);
    if (q) rows = rows.filter((b) => [b.account_no, b.customer_name, b.phone].some((v) => String(v || '').toLowerCase().includes(q)));
    const summary = {
      cnt: rows.length,
      kwh: r1(sum(rows, (b) => b.usage_kwh)),
      amount: r2(sum(rows, (b) => b.total_amount)),
      paid: r2(sum(rows, (b) => b.paid_amount)),
      unpaid_cnt: rows.filter((b) => ['issued', 'partial', 'overdue'].includes(b.status) && b.paid_amount < b.total_amount).length,
      outstanding: r2(sum(rows.filter((b) => ['issued', 'partial', 'overdue'].includes(b.status)), (b) => b.total_amount - b.paid_amount)),
    };
    const { page, size } = pageOf(sp);
    return { ...paginate(rows, page, size), summary };
  }

  function billDetail(S, id) {
    const bill = S.bills.find((b) => b.id === id);
    if (!bill) throw new Error('账单不存在');
    const allocations = S.allocations.filter((a) => a.bill_id === id).map((a) => {
      const p = S.payments.find((x) => x.id === a.payment_id) || {};
      return { ...a, pay_no: p.pay_no, channel: p.channel, paid_at: p.paid_at };
    });
    return {
      bill: {
        ...bill,
        allocations,
        adjustments: S.adjustments.filter((a) => a.applied_bill_id === id),
        outstanding: r2(bill.total_amount - bill.paid_amount),
      },
    };
  }

  function paymentList(S, sp) {
    let rows = S.payments;
    if (sp.get('channel')) rows = rows.filter((p) => p.channel === sp.get('channel'));
    if (sp.get('status')) rows = rows.filter((p) => p.status === sp.get('status'));
    const summary = { cnt: rows.filter((p) => p.status === 'success').length, amount: r2(sum(rows.filter((p) => p.status === 'success'), (p) => p.amount)) };
    const { page, size } = pageOf(sp);
    return { ...paginate(rows, page, size), summary };
  }

  function paymentDetail(S, id) {
    const payment = S.payments.find((p) => p.id === id);
    if (!payment) throw new Error('支付记录不存在');
    const acc = S.accounts.find((a) => a.id === payment.account_id) || {};
    return {
      payment: {
        ...payment, address: acc.address,
        allocations: S.allocations.filter((a) => a.payment_id === id).map((a) => {
          const b = S.bills.find((x) => x.id === a.bill_id) || {};
          return { ...a, period: b.period, bill_no: b.bill_no, total_amount: b.total_amount };
        }),
      },
    };
  }

  function adjustmentList(S, sp) {
    let rows = S.adjustments;
    if (sp.get('status')) rows = rows.filter((a) => a.status === sp.get('status'));
    if (sp.get('accountId')) rows = rows.filter((a) => String(a.account_id) === String(sp.get('accountId')));
    return rows;
  }

  /* ---------------------------- 缴费端 ---------------------------- */

  function demoAccounts(S) {
    const map = {};
    S.bills.filter((b) => ['issued', 'partial', 'overdue'].includes(b.status) && b.total_amount > b.paid_amount)
      .forEach((b) => {
        map[b.account_id] = map[b.account_id] || { account_no: b.account_no, customer_name: b.customer_name, amount: 0, cnt: 0, first_period: b.period };
        map[b.account_id].amount += b.total_amount - b.paid_amount;
        map[b.account_id].cnt++;
      });
    return Object.values(map)
      .map((x) => ({ ...x, amount: r2(x.amount) }))
      .sort((a, b) => b.amount - a.amount).slice(0, 3);
  }

  function publicLookup(S, acc) {
    const bills = S.bills.filter((b) => b.account_id === acc.id && b.status !== 'void')
      .sort((a, b) => (a.period < b.period ? 1 : -1)).slice(0, 18)
      .map((b) => ({
        id: b.id, bill_no: b.bill_no, period: b.period, usage_kwh: b.usage_kwh,
        total_amount: b.total_amount, paid_amount: b.paid_amount, status: b.status,
        due_date: b.due_date, outstanding: r2(b.total_amount - b.paid_amount),
      }));
    return {
      account: {
        accountNo: acc.account_no,
        customerName: acc.customer_name ? acc.customer_name[0] + '*'.repeat(Math.max(1, acc.customer_name.length - 1)) : '—',
        address: acc.address, propertyType: acc.property_type, areaName: acc.area_name,
        status: acc.status, outstanding: acc.outstanding || 0, lastPeriod: acc.last_period,
      },
      bills,
      payable: bills.filter((b) => b.outstanding > 0.005),
    };
  }

  let paySeq = 0;
  function payStatic(S, body) {
    const acc = S.accounts.find((a) => a.account_no === body.accountNo);
    if (!acc) throw new Error('户号不存在');
    const ids = (body.billIds || []).map(Number);
    const payable = S.bills.filter((b) => b.account_id === acc.id && ids.includes(b.id) && b.paid_amount < b.total_amount - 0.005);
    if (!payable.length) throw new Error('没有待缴金额');
    const amount = r2(sum(payable, (b) => b.total_amount - b.paid_amount));
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const paidAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const payNo = `P${paidAt.slice(0, 10).replace(/-/g, '')}${String(Date.now()).slice(-6)}${paySeq++}`;
    const payId = 900000 + S.payments.length + paySeq;

    payable.forEach((b) => {
      const left = r2(b.total_amount - b.paid_amount);
      S.allocations.push({ id: payId * 10 + b.id, payment_id: payId, bill_id: b.id, amount: left, period: b.period, bill_no: b.bill_no, total_amount: b.total_amount });
      b.paid_amount = b.total_amount;
      b.status = 'paid';
      b.paid_at = paidAt;
      b.outstanding = 0;
    });
    S.payments.unshift({
      id: payId, pay_no: payNo, account_id: acc.id, amount, channel: body.channel || 'wechat',
      status: 'success', paid_at: paidAt, bills_cnt: payable.length,
      channel_name: CHANNEL_ZH[body.channel] || '微信支付',
      payer_name: body.payerName || acc.customer_name, account_no: acc.account_no, customer_name: acc.customer_name,
      gateway_txn: `STATIC${Date.now()}`, idempotency_key: body.idempotencyKey || '',
    });
    acc.outstanding = r2((acc.outstanding || 0) - amount);

    return {
      success: true, payNo, amount, channel: CHANNEL_ZH[body.channel] || '微信支付',
      paidAt, bills: payable.map((b) => ({ id: b.id, billNo: b.bill_no })), accountNo: acc.account_no,
    };
  }

  window.__staticApi = handle;
})();
