import { all, get, run, tx, setting, setSetting } from '../db.js';
import { issuePeriod } from './billing.js';
import { nowStr, todayStr, periodOf, prevPeriod, nextPeriod, ymd, addDays, parseDate, round1, round2 } from './util.js';

/** 取某计量点最近 N 条有效读数 */
function recentReadings(pointId, limit = 40) {
  return all(
    `SELECT read_at, reading FROM readings
     WHERE point_id=? AND superseded_by IS NULL AND quality <> 'suspect'
     ORDER BY read_at DESC, id DESC LIMIT ?`, pointId, limit
  ).reverse();
}

function avgDaily(pointId, ratio = 1) {
  const rows = recentReadings(pointId, 35);
  if (rows.length < 2) return 0;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const days = Math.max(1, (new Date(last.read_at.replace(' ', 'T')) - new Date(first.read_at.replace(' ', 'T'))) / 86400000);
  const kwh = (last.reading - first.reading) * ratio;
  return Math.max(0, kwh / days);
}

/**
 * 模拟推进一个月：为所有在运表补齐下一个账期的日读数，并自动出账。
 */
export function simulateMonth() {
  const last = get('SELECT MAX(period) p FROM period_runs')?.p;
  const start = last ? nextPeriod(last) : prevPeriod(periodOf(new Date()), 1);
  const current = periodOf(new Date());
  if (start > current) throw new Error(`已经追平当前月份（${start}），无需再推进`);
  if (start === current && new Date().getDate() < 2) throw new Error('本月数据过少，暂无法出账');

  const points = all(
    `SELECT p.id AS point_id, a.*, s.id AS seg_id, s.device_id, s.start_reading, s.ratio AS seg_ratio,
            d.asset_no, d.status AS device_status
     FROM metering_points p
     JOIN accounts a ON a.id=p.account_id
     JOIN segments s ON s.point_id=p.id AND s.status='active'
     JOIN devices d ON d.id=s.device_id
     WHERE a.status='active' AND d.status='in_service'`
  );

  const now = nowStr();
  let inserted = 0;
  const isCurrent = start === current;
  const daysInMonth = new Date(Number(start.slice(0, 4)), Number(start.slice(5, 7)), 0).getDate();
  const endDay = isCurrent ? new Date().getDate() - 1 : daysInMonth;

  tx(() => {
    for (const p of points) {
      const lastRead = get(
        `SELECT * FROM readings WHERE segment_id=? ORDER BY read_at DESC, id DESC LIMIT 1`, p.seg_id
      );
      let value = lastRead ? lastRead.reading : p.start_reading;
      const daily = avgDaily(p.point_id, p.seg_ratio) || 8;
      let lastAt = lastRead?.read_at || null;
      // 已经由保鲜任务补齐的日期不再重复写入
      const lastDay = lastRead && lastRead.read_at.slice(0, 7) === start
        ? Number(lastRead.read_at.slice(8, 10)) : 0;
      for (let day = lastDay + 1; day <= endDay; day++) {
        const d = new Date(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, day, 0, 5);
        lastAt = ymd(d) + ' 00:05:00';
        value = round2(value + (daily * (0.75 + Math.random() * 0.5)) / p.seg_ratio);
        run(
          `INSERT INTO readings (point_id, segment_id, device_id, read_at, reading, source, quality, created_at)
           VALUES (?,?,?,?,?,'iot_push','valid',?)`,
          p.point_id, p.seg_id, p.device_id, ymd(d) + ' 00:05:00', value, now
        );
        inserted++;
      }
      if (lastAt) run('UPDATE devices SET last_seen_at=? WHERE id=?', lastAt, p.device_id);
    }
  });

  const billResult = issuePeriod(start, 'system');
  return {
    period: start,
    readings: inserted,
    accounts: billResult.accounts,
    kwh: billResult.kwh,
    amount: billResult.amount,
  };
}

/**
 * 演示数据保鲜：把每块在运表的日读数补齐到昨天。
 * 线上演示放几天不维护时，避免所有设备都变成「离线」。
 * 只补数据，不出账；跳过高故障/返厂设备，保留故障场景。
 */
export function keepFresh() {
  const yesterday = ymd(addDays(new Date(), -1));
  const points = all(
    `SELECT p.id AS point_id, s.id AS seg_id, s.device_id, s.ratio, s.start_reading, s.start_date
     FROM metering_points p
     JOIN accounts a ON a.id = p.account_id
     JOIN segments s ON s.point_id = p.id AND s.status = 'active'
     JOIN devices d ON d.id = s.device_id
     WHERE a.status <> 'closed' AND d.status = 'in_service'`
  );
  const now = nowStr();
  let inserted = 0;
  const end = parseDate(yesterday);

  tx(() => {
    for (const p of points) {
      const last = get(
        'SELECT * FROM readings WHERE segment_id=? ORDER BY read_at DESC, id DESC LIMIT 1', p.seg_id
      );
      let value = last ? last.reading : p.start_reading;
      const daily = avgDaily(p.point_id, p.ratio);
      let d = last ? addDays(parseDate(last.read_at.slice(0, 10)), 1) : parseDate(p.start_date);
      if (d > end) continue;
      let lastAt = last?.read_at || null;
      while (d <= end) {
        value = round2(value + daily / p.ratio);
        lastAt = ymd(d) + ' 00:05:00';
        run(
          `INSERT INTO readings (point_id, segment_id, device_id, read_at, reading, source, quality, created_at)
           VALUES (?,?,?,?,?,'iot_push','valid',?)`,
          p.point_id, p.seg_id, p.device_id, lastAt, value, now
        );
        inserted++;
        d = addDays(d, 1);
      }
      if (lastAt) run('UPDATE devices SET last_seen_at=?, offline_since=NULL WHERE id=?', lastAt, p.device_id);
    }
    if (inserted) setSetting('last_fresh_at', yesterday);
  });

  return { inserted, until: yesterday };
}

/** 模拟单台设备主动上报 */
export function mockPush({ assetNo, reading, at }) {
  const dev = assetNo
    ? get('SELECT * FROM devices WHERE asset_no=?', assetNo)
    : get(`SELECT d.* FROM devices d JOIN segments s ON s.device_id=d.id AND s.status='active' LIMIT 1`);
  if (!dev) throw new Error('设备不存在');
  const seg = get("SELECT * FROM segments WHERE device_id=? AND status='active'", dev.id);
  if (!seg) throw new Error('该设备未安装，无法上报');
  const value = Number(reading);
  if (!Number.isFinite(value) || value < 0) throw new Error('示数不合法');
  const readAt = at ? `${at} ${new Date().toTimeString().slice(0, 5)}:00` : nowStr();

  const prev = get(
    `SELECT * FROM readings WHERE segment_id=? ORDER BY read_at DESC, id DESC LIMIT 1`, seg.id
  );
  const quality = prev && value < prev.reading ? 'suspect' : 'valid';
  const id = run(
    `INSERT INTO readings (point_id, segment_id, device_id, read_at, reading, source, quality, note, created_at)
     VALUES (?,?,?,?,?,'iot_push',?,?,?)`,
    seg.point_id, seg.id, dev.id, readAt, value, quality,
    quality === 'suspect' ? '表码倒走，已挂起等待核查' : null, nowStr()
  ).lastId;
  run('UPDATE devices SET last_seen_at=?, offline_since=NULL WHERE id=?', readAt, dev.id);
  return { id, assetNo: dev.asset_no, reading: value, quality, at: readAt };
}

/** 模拟设备故障：停止上报并把设备置为故障，自动生成报修工单 */
export function forceFault({ accountNo }) {
  const acc = get('SELECT * FROM accounts WHERE account_no=?', accountNo);
  if (!acc) throw new Error('户号不存在');
  const seg = get(
    `SELECT s.* FROM segments s JOIN metering_points p ON p.id=s.point_id
     WHERE p.account_id=? AND s.status='active'`, acc.id
  );
  if (!seg) throw new Error('该户没有在运电表');
  run(`UPDATE devices SET status='fault', offline_since=? WHERE id=?`, todayStr(), seg.device_id);
  const open = get(
    `SELECT * FROM replacements WHERE account_id=? AND status IN ('reported','processing','pending_review')`, acc.id
  );
  let orderNo = open?.order_no;
  if (!open) {
    const seqNo = get('SELECT COUNT(*) c FROM replacements').c + 1;
    orderNo = `WO${todayStr().replace(/-/g, '')}${String(seqNo).padStart(3, '0')}`;
    run(
      `INSERT INTO replacements (order_no, account_id, point_id, old_segment_id, old_device_id, solution,
         reason, fault_type, symptom, reported_at, status, operator, remark, created_at)
       VALUES (?,?,?,?,?,'replace_meter','meter_fault','表计故障',?,?,'reported','系统模拟',?,?)`,
      orderNo, acc.id, seg.point_id, seg.id, seg.device_id,
      '物联网上报计量异常，连续无有效脉冲', nowStr(), '由模拟器触发', nowStr()
    );
  }
  return { accountNo, orderNo, deviceId: seg.device_id };
}
