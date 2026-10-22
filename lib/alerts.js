import { all, get } from '../db.js';
import { round1, round2, prevPeriod, periodOf, daysBetween, todayStr } from './util.js';

/**
 * 异常中心：全部基于数据推导，不依赖人工标记。
 * 严重级别 high / medium / low
 */
export function collectAlerts() {
  const alerts = [];
  const today = new Date();

  /* 1. 离线 / 断档 / 无数据 --------------------------------------- */
  const points = all(
    `SELECT p.id AS point_id, p.point_no, a.id AS account_id, a.account_no, a.customer_name, a.phone,
            s.id AS seg_id, d.id AS device_id, d.asset_no, d.status AS device_status,
            (SELECT MAX(read_at) FROM readings r WHERE r.point_id=p.id AND r.superseded_by IS NULL) AS last_at
     FROM metering_points p
     JOIN accounts a ON a.id=p.account_id
     JOIN segments s ON s.point_id=p.id AND s.status='active'
     JOIN devices d ON d.id=s.device_id
     WHERE a.status <> 'closed'`
  );
  for (const p of points) {
    if (!p.last_at) {
      alerts.push({
        id: `no_data-${p.account_id}`, type: 'no_data', severity: 'high',
        title: '从未收到抄表数据', accountId: p.account_id, accountNo: p.account_no,
        customerName: p.customer_name, phone: p.phone,
        detail: `表 ${p.asset_no} 安装后无任何上报记录`,
      });
      continue;
    }
    const days = Math.floor((today - new Date(p.last_at.replace(' ', 'T'))) / 86400000);
    if (days >= 2) {
      alerts.push({
        id: `offline-${p.account_id}`, type: 'offline',
        severity: days >= 7 ? 'high' : 'medium',
        title: `设备离线 ${days} 天`, accountId: p.account_id, accountNo: p.account_no,
        customerName: p.customer_name, phone: p.phone, at: p.last_at, days,
        detail: `表 ${p.asset_no} 最后上报 ${p.last_at}，期间无抄表数据`,
        deviceStatus: p.device_status,
      });
    }
  }

  /* 2. 表码异常 / 倒走 -------------------------------------------- */
  const suspects = all(
    `SELECT r.*, a.id AS account_id, a.account_no, a.customer_name, d.asset_no
     FROM readings r
     JOIN metering_points p ON p.id=r.point_id
     JOIN accounts a ON a.id=p.account_id
     JOIN devices d ON d.id=r.device_id
     WHERE r.quality='suspect' AND r.superseded_by IS NULL
     ORDER BY r.read_at DESC LIMIT 30`
  );
  for (const s of suspects) {
    alerts.push({
      id: `suspect-${s.id}`, type: 'suspect', severity: 'high',
      title: '表码异常', accountId: s.account_id, accountNo: s.account_no,
      customerName: s.customer_name, at: s.read_at,
      detail: `表 ${s.asset_no} 于 ${s.read_at} 上报示数 ${s.reading}，${s.note || '疑似倒走或跳变'}`,
    });
  }

  /* 3. 零电量（近 30 天） ----------------------------------------- */
  const zeros = all(
    `WITH r AS (
       SELECT point_id, read_at, reading,
              LAG(reading) OVER (PARTITION BY point_id ORDER BY read_at) prev
       FROM readings WHERE superseded_by IS NULL AND quality <> 'suspect')
     SELECT p.account_id, a.account_no, a.customer_name, a.phone,
            ROUND(SUM((r.reading-r.prev)*s.ratio),1) kwh
     FROM r
     JOIN segments s ON s.id = (SELECT id FROM segments WHERE point_id=r.point_id ORDER BY seq DESC LIMIT 1)
     JOIN metering_points p ON p.id=r.point_id
     JOIN accounts a ON a.id=p.account_id
     WHERE r.prev IS NOT NULL AND r.read_at >= date('now','-30 day')
     GROUP BY p.account_id HAVING kwh < 0.5`
  );
  for (const z of zeros) {
    alerts.push({
      id: `zero-${z.account_id}`, type: 'zero', severity: 'low',
      title: '近 30 天零电量', accountId: z.account_id, accountNo: z.account_no,
      customerName: z.customer_name, phone: z.phone,
      detail: '连续 30 天用电量接近 0，可能是空置房、表计停走或窃电',
    });
  }

  /* 4. 电量突变 --------------------------------------------------- */
  const cur = periodOf(today);
  const p1 = prevPeriod(cur, 1);
  const p2 = prevPeriod(cur, 2);
  const p3 = prevPeriod(cur, 3);
  const monthly = all(
    `WITH r AS (
       SELECT point_id, read_at, reading,
              LAG(reading) OVER (PARTITION BY point_id ORDER BY read_at) prev
       FROM readings WHERE superseded_by IS NULL AND quality <> 'suspect')
     SELECT p.account_id, a.account_no, a.customer_name, a.phone, substr(r.read_at,1,7) period,
            SUM((r.reading-r.prev)*s.ratio) kwh
     FROM r
     JOIN segments s ON s.id = (SELECT id FROM segments WHERE point_id=r.point_id ORDER BY seq DESC LIMIT 1)
     JOIN metering_points p ON p.id=r.point_id
     JOIN accounts a ON a.id=p.account_id
     WHERE r.prev IS NOT NULL AND substr(r.read_at,1,7) >= ?
     GROUP BY p.account_id, period`,
    p3
  );
  const byAcc = new Map();
  for (const m of monthly) {
    if (!byAcc.has(m.account_id)) byAcc.set(m.account_id, { info: m, months: {} });
    byAcc.get(m.account_id).months[m.period] = m.kwh;
  }
  for (const [accId, v] of byAcc) {
    const curKwh = v.months[cur] || 0;
    const prevs = [v.months[p1], v.months[p2], v.months[p3]].filter((x) => x > 0);
    if (!prevs.length || curKwh <= 0) continue;
    const avg = prevs.reduce((a, b) => a + b, 0) / prevs.length;
    const ratio = curKwh / avg;
    if (ratio >= 1.8) {
      alerts.push({
        id: `spike-${accId}`, type: 'spike', severity: 'medium',
        title: '用电量突增', accountId: accId, accountNo: v.info.account_no,
        customerName: v.info.customer_name, phone: v.info.phone,
        detail: `本月 ${round1(curKwh)} kWh，为近 3 月均值 ${round1(avg)} kWh 的 ${ratio.toFixed(1)} 倍`,
        metric: round2(ratio),
      });
    } else if (ratio <= 0.35) {
      alerts.push({
        id: `drop-${accId}`, type: 'drop', severity: 'low',
        title: '用电量骤降', accountId: accId, accountNo: v.info.account_no,
        customerName: v.info.customer_name, phone: v.info.phone,
        detail: `本月 ${round1(curKwh)} kWh，仅为近 3 月均值的 ${(ratio * 100).toFixed(0)}%`,
        metric: round2(ratio),
      });
    }
  }

  /* 5. 逾期欠费 --------------------------------------------------- */
  const overdue = all(
    `SELECT b.*, a.account_no, a.customer_name, a.phone,
            CAST(julianday('now') - julianday(b.due_date) AS INTEGER) overdue_days
     FROM bills b JOIN accounts a ON a.id=b.account_id
     WHERE b.status IN ('overdue','partial','issued') AND b.paid_amount < b.total_amount - 0.005
       AND b.due_date < date('now')
     ORDER BY overdue_days DESC LIMIT 60`
  );
  for (const o of overdue) {
    if (o.overdue_days < 3) continue;
    alerts.push({
      id: `arrears-${o.id}`, type: 'arrears',
      severity: o.overdue_days > 30 ? 'high' : 'medium',
      title: `逾期 ${o.overdue_days} 天未缴`,
      accountId: o.account_id, accountNo: o.account_no, customerName: o.customer_name, phone: o.phone,
      detail: `${o.period} 账期应收 ¥${round2(o.total_amount - o.paid_amount).toFixed(2)}，到期日 ${o.due_date}`,
      amount: round2(o.total_amount - o.paid_amount), overdueDays: o.overdue_days,
    });
  }

  /* 6. 换表工单待办 ----------------------------------------------- */
  const repl = all(
    `SELECT r.*, a.account_no, a.customer_name, a.phone FROM replacements r
     JOIN accounts a ON a.id=r.account_id
     WHERE r.status IN ('reported','processing','pending_review') ORDER BY r.id DESC`
  );
  for (const r of repl) {
    alerts.push({
      id: `repl-${r.id}`, type: 'replacement',
      severity: r.status === 'reported' ? 'medium' : 'low',
      title: r.status === 'reported' ? '换表工单待派单' : '换表工单进行中',
      accountId: r.account_id, accountNo: r.account_no, customerName: r.customer_name, phone: r.phone,
      detail: `${r.order_no} · ${r.fault_type || ''} ${r.symptom || ''}`.trim(),
      at: r.reported_at, orderNo: r.order_no,
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  return alerts.sort((a, b) => (order[a.severity] - order[b.severity]) || String(b.at || '').localeCompare(String(a.at || '')));
}
