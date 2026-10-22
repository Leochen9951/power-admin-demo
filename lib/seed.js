import { db, all, get, run, tx, setSetting } from '../db.js';
import { issuePeriod, addAdjustment } from './billing.js';
import { ymd, periodOf, prevPeriod, addDays, monthStart, parseDate, round1, round2, nowStr } from './util.js';
import crypto from 'node:crypto';

/* ----------------------------- 工具 ----------------------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const rnd = (rng, min, max) => min + rng() * (max - min);
const rndInt = (rng, min, max) => Math.floor(rnd(rng, min, max + 1));

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${h}`;
}

/* ----------------------------- 基础字典 ----------------------------- */
const AREAS = [
  { code: '340102', name: '城东供电所', region: '华东 · 合肥' },
  { code: '340103', name: '城西供电所', region: '华东 · 合肥' },
  { code: '340104', name: '城南供电所', region: '华东 · 合肥' },
];

const COMMUNITIES = [
  { areaIdx: 0, name: '锦绣家园', address: '望江东路 128 号' },
  { areaIdx: 1, name: '阳光新城', address: '长江西路 66 号' },
  { areaIdx: 2, name: '翠竹苑', address: '南二环 388 号' },
];

const TARIFFS = [
  {
    code: 'RES_TIER', name: '居民生活阶梯电价', property_type: '居民',
    tiers: [
      { limit: 180, price: 0.5283 },
      { limit: 400, price: 0.5783 },
      { limit: null, price: 0.8283 },
    ],
    base_fee: 0,
  },
  {
    code: 'COM_FLAT', name: '一般工商业电价', property_type: '商业',
    tiers: [{ limit: null, price: 0.7456 }],
    base_fee: 0,
  },
  {
    code: 'AGRI_FLAT', name: '农业生产电价', property_type: '农业',
    tiers: [{ limit: null, price: 0.4520 }],
    base_fee: 0,
  },
];

const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '马', '朱', '胡',
  '郭', '何', '林', '罗', '高', '郑', '梁', '谢', '宋', '唐', '许', '韩', '冯', '邓', '曹'];
const GIVEN = ['建国', '秀英', '伟', '芳', '娜', '敏', '静', '丽', '强', '磊', '军', '洋', '勇', '艳',
  '杰', '娟', '涛', '明', '超', '霞', '平', '刚', '桂英', '玉兰', '志强', '海燕', '俊', '雪梅', '鹏', '立新'];
const VENDORS = [
  { vendor: '威胜集团', model: 'DDZY102-Z', protocol: 'DL/T645-2007', phase: '单相', voltage: '220V' },
  { vendor: '林洋能源', model: 'DTZY71-G', protocol: 'DL/T645-2007', phase: '单相', voltage: '220V' },
  { vendor: '华立科技', model: 'DTS541', protocol: 'DL/T698.45', phase: '三相', voltage: '3×220/380V' },
];
const CHANNELS = ['wechat', 'wechat', 'wechat', 'alipay', 'alipay', 'bank', 'cash'];

/* ----------------------------- 主流程 ----------------------------- */
export function seed({ force = false } = {}) {
  const today = new Date();
  const END = addDays(today, -1);              // 读数截止到昨天
  const currentPeriod = periodOf(today);        // 2026-10
  const firstBilled = prevPeriod(currentPeriod, 13);    // 13 个完整账期
  const lastBilled = prevPeriod(currentPeriod, 1);
  const windowStart = addDays(monthStart(parseDate(`${prevPeriod(currentPeriod, 13)}-01`)), -7);
  const rng = mulberry32(20261021);

  tx(() => {
    for (const t of ['allocations', 'payments', 'adjustments', 'bills', 'readings', 'replacements',
      'segments', 'devices', 'metering_points', 'accounts', 'communities', 'tariffs', 'areas',
      'period_runs', 'audit_logs', 'settings']) {
      db.exec(`DELETE FROM ${t}`);
    }
    try { db.exec(`DELETE FROM sqlite_sequence`); } catch {}
    db.exec(`DELETE FROM users`);

    /* --- 用户 --- */
    const now = nowStr();
    run(`INSERT INTO users (username,password,name,role,created_at) VALUES (?,?,?,?,?)`,
      'admin', hashPassword(process.env.ADMIN_PASSWORD || 'admin123'), '系统管理员', 'admin', now);
    run(`INSERT INTO users (username,password,name,role,created_at) VALUES (?,?,?,?,?)`,
      'collector', hashPassword('123456'), '抄表员 · 周明', 'collector', now);
    run(`INSERT INTO users (username,password,name,role,created_at) VALUES (?,?,?,?,?)`,
      'cashier', hashPassword('123456'), '收费员 · 李静', 'cashier', now);

    /* --- 区域 / 小区 / 电价 --- */
    const areaIds = AREAS.map((a) => run('INSERT INTO areas (code,name,region) VALUES (?,?,?)',
      a.code, a.name, a.region).lastId);
    const commIds = COMMUNITIES.map((c) => run('INSERT INTO communities (area_id,name,address) VALUES (?,?,?)',
      areaIds[c.areaIdx], c.name, c.address).lastId);
    const tariffIds = {};
    TARIFFS.forEach((t) => {
      tariffIds[t.property_type] = run(
        'INSERT INTO tariffs (code,name,property_type,tiers,base_fee,tax_rate,effective_from) VALUES (?,?,?,?,?,0,?)',
        t.code, t.name, t.property_type, JSON.stringify(t.tiers), t.base_fee, '2024-01-01'
      ).lastId;
    });

    const total = 60;
    const accounts = [];

    /* --- 户 / 计量点 / 设备 / 安装段 --- */
    for (let i = 0; i < total; i++) {
      const isBiz = i >= 51;
      const commIdx = isBiz ? 2 : i % 2;
      const comm = COMMUNITIES[commIdx];
      const areaId = areaIds[comm.areaIdx];
      const propertyType = isBiz ? '商业' : '居民';
      const openDate = ymd(addDays(monthStart(new Date(2024, 2, 1)), rndInt(rng, 0, 470)));
      const surname = pick(rng, SURNAMES);
      const given = pick(rng, GIVEN);
      const customerName = surname + given;
      const ownerName = rng() > 0.72 ? pick(rng, SURNAMES) + pick(rng, GIVEN) : customerName;
      const building = isBiz ? `临街 ${1 + (i % 12)} 号商铺` : `第 ${1 + Math.floor((i % 51) / 6)} 栋`;
      const unit = isBiz ? '' : `${1 + (i % 3)} 单元`;
      const room = isBiz ? '' : `${1 + (i % 18)}0${1 + (i % 4)}`;
      const address = isBiz
        ? `${comm.name} ${building}`
        : `${comm.name} ${building} ${unit} ${room} 室`;
      const accountNo = `${AREAS[comm.areaIdx].code}${String(i + 1).padStart(6, '0')}`;
      const phone = `${pick(rng, ['138', '139', '150', '152', '158', '186', '188'])}${String(rndInt(rng, 10000000, 99999999))}`;

      const accId = run(
        `INSERT INTO accounts (account_no, customer_name, owner_name, relation, id_type, id_no, phone,
          phone_alt, area_id, community_id, building, unit, room, address, property_type, tariff_id,
          contract_capacity, status, open_date, payment_method, auto_debit, credit_level, tags, remark,
          created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        accountNo, customerName, ownerName, ownerName === customerName ? '本人' : '亲属',
        '身份证', `34010${rndInt(rng, 1, 9)}${'19'}${rndInt(rng, 60, 99)}${String(rndInt(rng, 1, 12)).padStart(2, '0')}${String(rndInt(rng, 1, 28)).padStart(2, '0')}${rndInt(rng, 1000, 9999)}`,
        phone, null, areaId, commIds[commIdx], building, unit || null, room || null, address,
        propertyType, tariffIds[propertyType],
        isBiz ? rndInt(rng, 20, 60) : rndInt(rng, 4, 12),
        'active', openDate, pick(rng, ['wechat', 'alipay', 'bank']), rng() > 0.8 ? 1 : 0,
        pick(rng, ['A', 'A', 'B', 'B', 'C']), isBiz ? '重点客户' : null, null, now, now
      ).lastId;

      const pointId = run(
        'INSERT INTO metering_points (account_id,point_no,name,location,status,created_at) VALUES (?,?,?,?,?,?)',
        accId, `${accountNo}-01`, isBiz ? '商铺总表' : '户内总表', address, 'active', now
      ).lastId;

      const meterCount = 1;
      const ratio = isBiz ? pick(rng, [1, 1, 5, 10]) : 1;
      const v = pick(rng, VENDORS);
      const deviceId = run(
        `INSERT INTO devices (asset_no, serial_no, model, vendor, protocol, imei, sim_no, module_no,
          ratio, accuracy, phase, voltage, firmware, status, manufacture_date, installed_at, last_seen_at,
          created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'in_service',?,?,?,?)`,
        `MT${AREAS[comm.areaIdx].code}${String(i + 1).padStart(4, '0')}`,
        `SN${20230000 + i * 7}`, v.model, v.vendor, v.protocol,
        `86${String(1000000000000 + i * 1337).slice(0, 13)}`,
        `89860${String(10000000000 + i * 97).slice(0, 11)}`,
        `MOD${String(900000 + i * 13)}`,
        ratio, '1.0 级', v.phase, v.voltage, `V${1 + (i % 3)}.${i % 9}.2`,
        openDate, openDate, ymd(END), now
      ).lastId;

      const startReading = isBiz ? rndInt(rng, 20000, 60000) / 10 : rndInt(rng, 1200, 5800);
      const segId = run(
        `INSERT INTO segments (point_id,device_id,seq,start_date,start_reading,ratio,reason,status,created_at)
         VALUES (?,?,1,?,?,?,'新装','active',?)`,
        pointId, deviceId, openDate, startReading, ratio, now
      ).lastId;

      accounts.push({
        i, accId, accountNo, pointId, segId, deviceId, commIdx, areaId, propertyType,
        openDate, startReading, ratio, isBiz, customerName, ownerName, phone, address,
      });
    }

    /* --- 换表 / 故障案例规划 --- */
    // A: 表坏整表更换（已装新表，形成两个安装段）
    // B: 物联网模块损坏（表体保留，读数断档后补录）
    // C: 当前故障待处理（读数已中断）
    // D: 历史换表
    const plans = [
      { idx: 5, type: 'replace_meter', date: '2026-06-12', reason: 'meter_fault' },
      { idx: 13, type: 'replace_module', from: '2026-07-20', to: '2026-08-03', reason: 'module_fault' },
      { idx: 30, type: 'fault_open', date: '2026-10-18', reason: 'meter_fault' },
      { idx: 40, type: 'replace_meter', date: '2025-12-08', reason: 'meter_fault' },
      { idx: 47, type: 'vacant', from: '2026-08-01', reason: 'vacant' },
      { idx: 12, type: 'spike', from: '2026-09-03', reason: 'spike' },
      { idx: 20, type: 'reverse', date: '2026-09-15', reason: 'reverse' },
    ];
    const planByAcc = new Map(plans.map((p) => [p.idx, p]));

    /* --- 读数生成 --- */
    const insertReading = db.prepare(
      `INSERT INTO readings (point_id,segment_id,device_id,read_at,reading,source,quality,superseded_by,note,created_at)
       VALUES (?,?,?,?,?,?,?,NULL,?,?)`
    );

    for (const acc of accounts) {
      const arng = mulberry32(1000 + acc.i * 977);
      const base = acc.isBiz ? rnd(arng, 28, 72) : rnd(arng, 5.5, 13.5);
      const plan = planByAcc.get(acc.i);

      const startD = new Date(Math.max(parseDate(acc.openDate).getTime(), windowStart.getTime()));
      const endD = plan && plan.type === 'fault_open' ? parseDate(plan.date) : END;

      // 逐日用电量
      const usage = new Map();
      for (let d = new Date(startD); d <= endD; d = addDays(d, 1)) {
        const m = d.getMonth() + 1;
        let f = 1;
        if (m >= 6 && m <= 9) f = 1.46;
        else if (m === 12 || m <= 2) f = 1.26;
        const wk = [0, 6].includes(d.getDay()) ? (acc.isBiz ? 1.08 : 1.18) : 1;
        let u = base * f * wk * rnd(arng, 0.72, 1.28);
        if (plan && plan.type === 'vacant' && d >= parseDate(plan.from)) u = 0;
        if (plan && plan.type === 'spike' && d >= parseDate(plan.from)) u *= 2.6;
        usage.set(ymd(d), round1(u));
      }

      const replaceDate = plan && plan.type === 'replace_meter' ? parseDate(plan.date) : null;
      let segId = acc.segId;
      let deviceId = acc.deviceId;
      let value = acc.startReading;
      let newSegCreated = false;

      for (let d = new Date(startD); d <= endD; d = addDays(d, 1)) {
        const todayKey = ymd(d);
        if (replaceDate && d.getTime() === replaceDate.getTime()) {
          // 关旧段：止码取最后一条读数（已在上一天写入）
          const last = get('SELECT reading FROM readings WHERE segment_id=? ORDER BY read_at DESC, id DESC LIMIT 1', segId);
          const endReading = last ? last.reading : value;
          run(`UPDATE segments SET end_date=?, end_reading=?, end_reading_source='manual',
                end_reading_quality='valid', status='closed' WHERE id=?`,
            ymd(addDays(d, -1)), endReading, segId);
          // 新建备表
          const old = get('SELECT * FROM devices WHERE id=?', deviceId);
          const nd = run(
            `INSERT INTO devices (asset_no, serial_no, model, vendor, protocol, imei, sim_no, module_no,
              ratio, accuracy, phase, voltage, firmware, status, manufacture_date, installed_at, last_seen_at,
              note, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'in_service',?,?,?,?,?)`,
            `MT${AREAS[acc.commIdx === 2 ? 2 : acc.commIdx].code}${String(900 + acc.i).padStart(4, '0')}`,
            `SN${20239000 + acc.i}`, old.model, old.vendor, old.protocol,
            `86${String(2000000000000 + acc.i * 7331).slice(0, 13)}`,
            `89860${String(20000000000 + acc.i * 53).slice(0, 11)}`,
            `MOD${String(990000 + acc.i * 7)}`,
            old.ratio, '1.0 级', old.phase, old.voltage, 'V2.0.1',
            plan.date, plan.date, ymd(END), '换表后新装表', now
          ).lastId;
          run(`UPDATE devices SET status='returned', removed_at=?, note='故障拆回，待返厂检测' WHERE id=?`, plan.date, deviceId);
          segId = run(
            `INSERT INTO segments (point_id,device_id,seq,start_date,start_reading,ratio,reason,status,created_at)
             VALUES (?,?,2,?,0,?,'更换电表','active',?)`,
            acc.pointId, nd, plan.date, old.ratio, now
          ).lastId;
          deviceId = nd;
          value = 0;
          newSegCreated = true;
          insertReading.run(acc.pointId, segId, deviceId, `${plan.date} 00:05:00`, 0, 'manual', 'valid', '装表起码 0', now);
          continue;
        }

        if (d.getTime() !== startD.getTime()) {
          const prevKey = ymd(addDays(d, -1));
          // 倍率：表码增量 = 实际电量 / 倍率
          value = round2(value + (usage.get(prevKey) || 0) / acc.ratio);
        }

        if (plan && plan.type === 'reverse' && d.getTime() === parseDate(plan.date).getTime()) {
          insertReading.run(acc.pointId, segId, deviceId, `${ymd(d)} 00:05:00`, round1(value * 0.35),
            'iot_push', 'suspect', '表码倒走，疑似表计故障，待现场核查', now);
          continue;
        }

        // 模块故障区间：设备离线，不产生远程读数
        if (plan && plan.type === 'replace_module' && d >= parseDate(plan.from) && d < parseDate(plan.to)) {
          if (d.getTime() === parseDate(plan.from).getTime()) {
            run(`UPDATE devices SET last_seen_at=?, offline_since=? WHERE id=?`, `${ymd(d)} 00:05:00`, ymd(d), deviceId);
          }
          continue;
        }
        const isResume = plan && plan.type === 'replace_module' && d.getTime() === parseDate(plan.to).getTime();
        insertReading.run(
          acc.pointId, segId, deviceId, `${ymd(d)} 00:05:00`, value,
          isResume ? 'manual' : 'iot_push',
          isResume ? 'valid' : 'valid',
          isResume ? '模块更换后现场补录，覆盖断档区间' : null, now
        );
        if (d.getTime() === startD.getTime()) {
          run(`UPDATE devices SET installed_at=?, last_seen_at=? WHERE id=?`, ymd(d), `${ymd(d)} 00:05:00`, deviceId);
        }
      }

      // 断网后再上线时间
      if (plan && plan.type === 'replace_module') {
        run(`UPDATE devices SET last_seen_at=?, offline_since=NULL, module_no=? WHERE id=?`,
          `${plan.to} 00:05:00`, `MOD${String(990000 + acc.i * 7)}`, deviceId);
      }
      if (plan && plan.type === 'fault_open') {
        run(`UPDATE devices SET status='fault', offline_since=? WHERE id=?`, plan.date, deviceId);
      }
      acc.lastValue = value;
    }

    /* --- 工单记录 --- */
    const orderSeq = (n) => `WO${String(n).padStart(4, '0')}`;
    let wo = 1;
    for (const plan of plans) {
      const acc = accounts[plan.idx];
      if (plan.type === 'replace_meter') {
        const segs = all('SELECT * FROM segments WHERE point_id=? ORDER BY seq', acc.pointId);
        const oldSeg = segs[0];
        const newSeg = segs[1];
        const oldDevice = get('SELECT * FROM devices WHERE id=?', oldSeg.device_id);
        run(
          `INSERT INTO replacements (order_no, account_id, point_id, old_segment_id, new_segment_id,
             old_device_id, new_device_id, solution, reason, fault_type, symptom, reported_at, planned_at,
             done_at, old_final_reading, old_final_source, new_start_reading, status, operator, reviewer,
             reviewed_at, photos, remark, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'completed',?,?,?,?,?,?)`,
          orderSeq(wo++), acc.accId, acc.pointId, oldSeg.id, newSeg.id, oldSeg.device_id, newSeg.device_id,
          'replace_meter', plan.reason, '表计故障', '液晶不显示、计量停走，远程召测无响应',
          plan.date, plan.date, plan.date, oldSeg.end_reading, 'manual', 0,
          '张工', '刘主管', plan.date, JSON.stringify(['拆表照片.jpg', '装表照片.jpg', '止码照片.jpg']),
          '拆回旧表送检，新表资产已入册', now
        );
      } else if (plan.type === 'replace_module') {
        run(
          `INSERT INTO replacements (order_no, account_id, point_id, old_segment_id, old_device_id, new_device_id,
             solution, reason, fault_type, symptom, reported_at, planned_at, done_at, status, operator, reviewer,
             reviewed_at, photos, remark, created_at)
           VALUES (?,?,?,?,?,?,'replace_module',?,?,?,?,?,?,'completed',?,?,?,?,?,?)`,
          orderSeq(wo++), acc.accId, acc.pointId, acc.segId, acc.deviceId, null,
          plan.reason, '通信模块故障', '连续 14 天无心跳，现场表计走字正常',
          plan.from, ymd(addDays(parseDate(plan.from), 1)),
          plan.to, '周明', '刘主管', plan.to,
          JSON.stringify(['模块照片.jpg']), '仅更换 NB-IoT 通信模块，表体保留，断档数据已现场补录', now
        );
      } else if (plan.type === 'fault_open') {
        run(
          `INSERT INTO replacements (order_no, account_id, point_id, old_segment_id, old_device_id,
             solution, reason, fault_type, symptom, reported_at, planned_at, status, operator, remark, created_at)
           VALUES (?,?,?,?,?,'replace_meter',?,?,?,?,?,'reported',?,?,?)`,
          orderSeq(wo++), acc.accId, acc.pointId, acc.segId, acc.deviceId,
          plan.reason, '表计故障', '物联网模块上报计量异常，电流为 0 但用户反映正常用电',
          plan.date, ymd(addDays(parseDate(plan.date), 2)), '待派单', '系统自动告警', now
        );
      }
    }

    /* --- 换表缺数追补（待处理调整项） --- */
    addAdjustment({
      accountId: accounts[5].accId, period: currentPeriod, type: 'backcharge',
      amount: 7.29, usageKwh: 12.6, source: 'replacement_gap',
      reason: '2026-06-12 换表，6/9-6/11 计量停走，按日均用电追补 12.6 kWh', actor: '张工',
    });
  });

  /* --- 出账 --- */
  const periods = [];
  let p = firstBilled;
  while (p <= lastBilled) { periods.push(p); p = prevPeriod(p, -1); }
  for (const period of periods) issuePeriod(period, 'system');

  /* --- 缴费流水 --- */
  seedPayments(rng);
  setSetting('seed_at', nowStr());
  setSetting('demo_version', '1.0.0');
  return { periods: periods.length, accounts: 60 };
}

function seedPayments(rng) {
  const accounts = all('SELECT * FROM accounts ORDER BY id');
  const leaveTail = new Map([[3, 3], [9, 2], [17, 1], [22, 2], [28, 3], [36, 1], [44, 2], [52, 1]]);
  const partial = new Set([7, 21, 39, 55]);
  let paySeq = 1;

  tx(() => {
    for (const acc of accounts) {
      const idx = acc.id - 1;
      const bills = all('SELECT * FROM bills WHERE account_id=? ORDER BY period', acc.id);
      const tail = leaveTail.get(idx) || 0;
      const payable = bills.slice(0, Math.max(0, bills.length - tail));
      if (!payable.length) continue;

      let k = 0;
      while (k < payable.length) {
        const group = payable.slice(k, k + (rng() > 0.72 ? 2 : 1));
        const isLastOfAll = k + group.length >= payable.length;
        const doPartial = isLastOfAll && partial.has(idx);
        const totalAmt = round2(group.reduce((s, b) => s + b.total_amount, 0));
        const amount = doPartial ? round2(totalAmt * 0.5) : totalAmt;
        if (amount > 0) {
          const pEnd = new Date(Number(group[0].period.slice(0, 4)), Number(group[0].period.slice(5, 7)), 0);
          let paidAt = addDays(pEnd, rndInt(rng, 2, 18));
          const nowD = new Date();
          if (paidAt > nowD) paidAt = addDays(nowD, -rndInt(rng, 0, 3));
          const payNo = `P${ymd(paidAt).replace(/-/g, '')}${String(paySeq++).padStart(5, '0')}`;
          const channel = CHANNELS[Math.floor(rng() * CHANNELS.length)];
          const { lastId: pid } = run(
            `INSERT INTO payments (pay_no, account_id, amount, channel, status, gateway_txn, idempotency_key,
               payer_name, paid_at, remark, raw, created_at)
             VALUES (?,?,?,?,'success',?,?,?,?,?,?,?)`,
            payNo, acc.id, amount, channel, `GW${Date.now()}${paySeq}`, `idem-${payNo}`,
            acc.customer_name, `${ymd(paidAt)} 10:${String(rndInt(rng, 0, 59)).padStart(2, '0')}:00`,
            null, JSON.stringify({ channel, seed: true }), `${ymd(paidAt)} 10:00:00`
          );

          let left = amount;
          for (const b of group) {
            const alloc = round2(Math.min(left, b.total_amount));
            if (alloc <= 0) continue;
            run('INSERT INTO allocations (payment_id,bill_id,amount,created_at) VALUES (?,?,?,?)',
              pid, b.id, alloc, nowStr());
            const newPaid = round2(Math.min(b.total_amount, (b.paid_amount || 0) + alloc));
            run(`UPDATE bills SET paid_amount=?, status=?, paid_at=? WHERE id=?`,
              newPaid, newPaid >= b.total_amount - 0.005 ? 'paid' : 'partial',
              `${ymd(paidAt)} 10:00:00`, b.id);
            left = round2(left - alloc);
          }
        }
        k += group.length;
      }
    }
    // 历史逾期标记
    run(`UPDATE bills SET status='overdue'
         WHERE status IN ('issued','partial') AND due_date < date('now') AND paid_amount < total_amount - 0.005`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = Date.now();
  const out = seed({ force: true });
  console.log(`seed done in ${Date.now() - t0}ms`, out);
  console.log('accounts:', get('SELECT COUNT(*) c FROM accounts').c,
    'readings:', get('SELECT COUNT(*) c FROM readings').c,
    'bills:', get('SELECT COUNT(*) c FROM bills').c,
    'payments:', get('SELECT COUNT(*) c FROM payments').c);
}
