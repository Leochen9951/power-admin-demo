import { all, get, run, tx } from '../db.js';
import {
  round1, round2, periodEnd, todayStr, nowStr, prevPeriod, nextPeriod, periodOf,
  addDays, ymd, randomId, nonEmpty,
} from './util.js';

/* ------------------------------------------------------------------ *
 * 计量核心
 *
 * 读数挂在「计量点」上，设备只是某段时间被安装在该计量点上的工具。
 * 电量 = 同一安装段内相邻两条读数之差 × 倍率。
 * 跨段（换表）不做差分：旧表止码与新表起码之间不是电量。
 * ------------------------------------------------------------------ */

const READING_CTE = `
WITH r AS (
  SELECT id, point_id, segment_id, device_id, read_at, reading, source, quality,
         LAG(reading)  OVER (PARTITION BY point_id ORDER BY read_at, id) AS prev_reading,
         LAG(segment_id) OVER (PARTITION BY point_id ORDER BY read_at, id) AS prev_segment,
         LAG(read_at)  OVER (PARTITION BY point_id ORDER BY read_at, id) AS prev_at
  FROM readings
  WHERE superseded_by IS NULL AND quality <> 'suspect'
)`;

/** 某计量点的逐段电量明细（按时间顺序） */
export function pointDeltas(pointId) {
  const rows = all(
    `${READING_CTE}
     SELECT r.*, s.ratio AS seg_ratio
     FROM r JOIN segments s ON s.id = r.segment_id
     WHERE r.point_id = ? AND r.prev_segment = r.segment_id
     ORDER BY r.read_at`,
    pointId
  );
  return rows.map((r) => {
    const raw = round1((r.reading - r.prev_reading) * (r.seg_ratio || 1));
    return {
      segmentId: r.segment_id,
      deviceId: r.device_id,
      from: r.prev_at,
      to: r.read_at,
      kwh: raw,
      estimated: r.quality === 'estimated',
      reverse: raw < 0,
      source: r.source,
    };
  });
}

/** 户级月度用电序列 { '2026-09': {kwh, estimated} } */
export function usageSeries(accountId, fromPeriod) {
  const rows = all(
    `${READING_CTE}
     SELECT substr(r.read_at,1,7) AS period,
            SUM((r.reading - r.prev_reading) * s.ratio) AS kwh,
            SUM(CASE WHEN r.quality='estimated' THEN 1 ELSE 0 END) AS est_cnt
     FROM r
     JOIN segments s ON s.id = r.segment_id
     JOIN metering_points p ON p.id = r.point_id
     WHERE p.account_id = ? AND r.prev_segment = r.segment_id
       AND substr(r.read_at,1,7) >= ?
     GROUP BY period
     ORDER BY period`,
    accountId, fromPeriod
  );
  const map = {};
  for (const r of rows) map[r.period] = { kwh: round1(r.kwh), estimatedDays: r.est_cnt };
  return map;
}

/** 某账期全部户的用电量，一次查询完成（出账时用） */
export function usageMapForPeriod(period) {
  const rows = all(
    `${READING_CTE}
     SELECT p.account_id AS accountId,
            SUM((r.reading - r.prev_reading) * s.ratio) AS kwh,
            SUM(CASE WHEN r.quality='estimated' THEN 1 ELSE 0 END) AS est_cnt
     FROM r
     JOIN segments s ON s.id = r.segment_id
     JOIN metering_points p ON p.id = r.point_id
     WHERE r.prev_segment = r.segment_id AND substr(r.read_at,1,7) = ?
     GROUP BY p.account_id`,
    period
  );
  const map = new Map();
  for (const r of rows) map.set(r.accountId, { kwh: round1(r.kwh), estimatedDays: r.est_cnt });
  return map;
}

/** 某户某账期的用电量 */
export function usageOf(accountId, period) {
  const row = get(
    `${READING_CTE}
     SELECT SUM((r.reading - r.prev_reading) * s.ratio) AS kwh,
            SUM(CASE WHEN r.quality='estimated' THEN 1 ELSE 0 END) AS est_cnt
     FROM r
     JOIN segments s ON s.id = r.segment_id
     JOIN metering_points p ON p.id = r.point_id
     WHERE p.account_id = ? AND r.prev_segment = r.segment_id
       AND substr(r.read_at,1,7) = ?`,
    accountId, period
  );
  return { kwh: round1(row?.kwh || 0), estimatedDays: row?.est_cnt || 0 };
}

/** 阶梯电价计算，返回总额与分档明细 */
export function tierPrice(kwh, tiersJson) {
  let tiers;
  try {
    tiers = JSON.parse(tiersJson || '[]');
  } catch {
    tiers = [];
  }
  if (!tiers.length) return { total: 0, breakdown: [] };
  let remaining = round1(kwh);
  let prevLimit = 0;
  let total = 0;
  const breakdown = [];
  for (const t of tiers) {
    const limit = t.limit == null ? Infinity : Number(t.limit);
    const span = Math.max(0, Math.min(remaining, limit - prevLimit));
    if (span > 0) {
      const amount = round2(span * Number(t.price));
      total += amount;
      breakdown.push({
        from: prevLimit, to: limit === Infinity ? '∞' : limit,
        kwh: round1(span), price: Number(t.price), amount,
      });
      remaining = round1(remaining - span);
    }
    prevLimit = limit;
    if (remaining <= 0) break;
  }
  return { total: round2(total), breakdown };
}

function tariffOf(account) {
  if (account.tariff_id) {
    const t = get('SELECT * FROM tariffs WHERE id = ?', account.tariff_id);
    if (t) return t;
  }
  const t = get('SELECT * FROM tariffs WHERE property_type = ? LIMIT 1', account.property_type);
  return t || { tiers: '[]', base_fee: 0, tax_rate: 0, name: '默认电价' };
}

/* ------------------------------------------------------------------ *
 * 出账
 * ------------------------------------------------------------------ */

export function activeAccountsForPeriod(period) {
  const end = ymd(periodEnd(period));
  return all(
    `SELECT * FROM accounts
     WHERE open_date <= ?
       AND (close_date IS NULL OR close_date >= ?)
       AND status <> 'closed'
     ORDER BY account_no`,
    end, `${period}-01`
  );
}

/**
 * 生成某账期账单。
 * 已存在的账单跳过（幂等）；账单生成时把该户所有 pending 调整项并入。
 */
export function issuePeriod(period, actor = 'system') {
  const start = `${period}-01`;
  const end = ymd(periodEnd(period));
  const dueDate = ymd(addDays(periodEnd(period), 25));
  const accounts = activeAccountsForPeriod(period);
  const result = { period, accounts: 0, kwh: 0, amount: 0, skipped: 0, bills: [] };
  const usageMap = usageMapForPeriod(period);

  tx(() => {
    for (const acc of accounts) {
      const exist = get('SELECT id FROM bills WHERE account_id = ? AND period = ?', acc.id, period);
      if (exist) { result.skipped++; continue; }

      const u = usageMap.get(acc.id) || { kwh: 0, estimatedDays: 0 };
      const kwh = u.kwh;
      const estimatedDays = u.estimatedDays;
      const tariff = tariffOf(acc);
      const { total: energyFee, breakdown } = tierPrice(kwh, tariff.tiers);
      const baseFee = round2(tariff.base_fee || 0);

      const pending = all(
        `SELECT * FROM adjustments WHERE account_id = ? AND status = 'pending' AND period <= ? ORDER BY id`,
        acc.id, period
      );
      const adj = round2(pending.reduce((s, a) => s + Number(a.amount || 0), 0));

      const total = round2(energyFee + baseFee + adj);
      if (kwh <= 0 && total <= 0) { continue; }

      const billNo = `B${period.replace('-', '')}${String(acc.account_no).slice(-6)}`;
      const calcDetail = JSON.stringify({
        tariff: tariff.name, tiers: breakdown, kwh, baseFee, adjustment: adj,
        estimatedDays, generatedAt: nowStr(),
      });
      const { lastId } = run(
        `INSERT INTO bills (bill_no, account_id, period, usage_kwh, energy_fee, base_fee, adjustment,
                            total_amount, paid_amount, status, due_date, issued_at, calc_detail, created_at)
         VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?)`,
        billNo, acc.id, period, kwh, energyFee, baseFee, adj, total,
        total <= 0 ? 'paid' : 'issued', dueDate, `${ymd(addDays(periodEnd(period), 1))} 02:00:00`, calcDetail, nowStr()
      );
      for (const a of pending) {
        run(`UPDATE adjustments SET status='applied', applied_bill_id=? WHERE id=?`, lastId, a.id);
      }
      result.accounts++;
      result.kwh = round1(result.kwh + kwh);
      result.amount = round2(result.amount + total);
      result.bills.push({ id: lastId, billNo, accountNo: acc.account_no, kwh, total });
    }

    run(
      `INSERT INTO period_runs (period, ran_at, accounts_cnt, kwh, amount) VALUES (?,?,?,?,?)
       ON CONFLICT(period) DO UPDATE SET ran_at=excluded.ran_at, accounts_cnt=excluded.accounts_cnt,
         kwh=excluded.kwh, amount=excluded.amount`,
      period, nowStr(), result.accounts, result.kwh, result.amount
    );
  });

  refreshOverdue();
  return result;
}

/** 逾期刷新：未结清且已过到期日 → overdue */
export function refreshOverdue() {
  run(
    `UPDATE bills SET status='overdue'
     WHERE status IN ('issued','partial') AND due_date IS NOT NULL
       AND due_date < ? AND paid_amount < total_amount - 0.005`,
    todayStr()
  );
}

/* ------------------------------------------------------------------ *
 * 调整项（追补 / 退补）
 * ------------------------------------------------------------------ */

export function addAdjustment({
  accountId, period, type, amount, usageKwh = 0, reason, source = 'manual',
  billId = null, actor = 'admin',
}) {
  return run(
    `INSERT INTO adjustments (account_id, bill_id, period, type, amount, usage_kwh, reason, source,
                              status, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`,
    accountId, billId, period, type, round2(amount), round1(usageKwh), reason, source, actor, nowStr()
  ).lastId;
}

/* ------------------------------------------------------------------ *
 * 支付与核销
 * ------------------------------------------------------------------ */

const CHANNELS = {
  wechat: '微信支付', alipay: '支付宝', bank: '银行代扣', cash: '营业厅现金', mock: '模拟网关',
};

export function payBills({ accountId, billIds, channel = 'wechat', payerName = '', idempotencyKey = null }) {
  const bills = all(
    `SELECT * FROM bills WHERE account_id = ? AND id IN (${billIds.map(() => '?').join(',') || 'NULL'})`,
    accountId, ...billIds
  );
  const payable = bills.filter((b) => b.status !== 'void' && b.paid_amount < b.total_amount - 0.005);
  const amount = round2(payable.reduce((s, b) => s + (b.total_amount - b.paid_amount), 0));
  if (!payable.length) throw new Error('没有待缴金额');

  return tx(() => {
    const payNo = `P${ymd(new Date()).replace(/-/g, '')}${randomId('', 8)}`;
    const { lastId: payId } = run(
      `INSERT INTO payments (pay_no, account_id, amount, channel, status, gateway_txn, idempotency_key,
                             payer_name, paid_at, remark, raw, created_at)
       VALUES (?,?,?,?,'success',?,?,?,?,?,?,?)`,
      payNo, accountId, amount, channel, `MOCK${Date.now()}`, idempotencyKey,
      payerName || null, nowStr(), '模拟网关即时成功',
      JSON.stringify({ channel, simulate: true }), nowStr()
    );

    for (const b of payable) {
      const left = round2(b.total_amount - b.paid_amount);
      run('INSERT INTO allocations (payment_id, bill_id, amount, created_at) VALUES (?,?,?,?)',
        payId, b.id, left, nowStr());
      const paid = round2(b.paid_amount + left);
      run(`UPDATE bills SET paid_amount=?, status=?, paid_at=COALESCE(paid_at, ?) WHERE id=?`,
        paid, paid >= b.total_amount - 0.005 ? 'paid' : 'partial', nowStr(), b.id);
    }
    return { payId, payNo, amount, bills: payable.map((b) => ({ id: b.id, billNo: b.bill_no })) };
  });
}

export function billDetail(billId) {
  const bill = get(
    `SELECT b.*, a.account_no, a.customer_name, a.owner_name, a.phone, a.address
     FROM bills b JOIN accounts a ON a.id = b.account_id WHERE b.id = ?`,
    billId
  );
  if (!bill) return null;
  bill.calc = bill.calc_detail ? JSON.parse(bill.calc_detail) : null;
  bill.allocations = all(
    `SELECT al.*, p.pay_no, p.channel, p.paid_at FROM allocations al
     JOIN payments p ON p.id = al.payment_id WHERE al.bill_id = ? ORDER BY al.id`, billId
  );
  bill.adjustments = all('SELECT * FROM adjustments WHERE applied_bill_id = ? ORDER BY id', billId);
  bill.outstanding = round2(bill.total_amount - bill.paid_amount);
  return bill;
}

export { CHANNELS };
