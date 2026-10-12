// ============================================================
//  奖学金公示页 - 访问码后端（腾讯云 CloudBase 云函数）
//  运行时：Node.js 16.13 或以上
//  依赖：@cloudbase/node-sdk（云函数环境已内置，无需安装）
//
//  接口：
//    POST /api/verify   校验访问码   { code }
//    POST /api/code    管理员发码   Header: X-Admin-Password   { note, hours }
//    GET  /api/list    码列表       Header: X-Admin-Password
//    POST /api/revoke  作废         Header: X-Admin-Password   { code }
//
//  所有接口共用同一个云函数，通过 event.path 区分
// ============================================================

// ---------- 配置 ----------
const ADMIN_PASSWORD = 'JQP@2026';
const DB = 'scholarship';          // 数据表名
const COLL = 'codes';              // 访问码集合
const DATA_COLL = 'appdata';       // 业务数据集合（多端同步）
const DEV_COLL = 'devices';        // 可信设备集合（管理员免验证）
const DOC_ID = 'main';             // 业务数据单文档 id
const MAX_CODES = 500;             // 最多保留多少条历史码

// ---------- CloudBase 初始化 ----------
// Node 20 环境实测：没有全局 cloudbase 对象，必须 require SDK。
// 依赖 @cloudbase/node-sdk 需要 package.json 声明后由平台自动安装。
let db;
function getDb() {
  if (db) return db;
  const g = globalThis;

  // 路线 1：运行时内置全局对象（部分环境有）
  try {
    const api = g.cloudbase || (g.tcb && g.tcb.cloudbase);
    if (api && typeof api.init === 'function') {
      const app = api.init({ env: api.SYMBOL_CURRENT_ENV });
      if (app && typeof app.database === 'function') {
        db = app.database();
        return db;
      }
    }
  } catch (e) {}

  // 路线 2：SDK（Node20 走这条）
  let app = null;
  try {
    const SDK = require('@cloudbase/node-sdk');
    app = SDK.init({ env: SDK.SYMBOL_CURRENT_ENV });
  } catch (e) {
    try {
      const g2 = g.cloudbase;
      app = g2.init({ env: g2.SYMBOL_CURRENT_ENV });
    } catch (e2) {
      throw new Error('CloudBase 初始化失败：' + (e && e.message ? e.message : e));
    }
  }
  if (!app || typeof app.database !== 'function') {
    throw new Error('CloudBase 初始化失败：SDK 无 database 方法');
  }
  db = app.database();
  return db;
}

// ---------- 工具 ----------
function now() { return Date.now(); }

function ok(data, status) {
  return {
    statusCode: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Content-Type, X-Admin-Password, X-Device-Token',
      'access-control-allow-methods': 'GET, POST, OPTIONS'
    },
    body: JSON.stringify(data)
  };
}

function fail(msg, status) {
  return ok({ ok: false, error: msg || '失败' }, status || 200);
}

// 兼容：CloudBase HTTP 事件的 body 可能是 string 或 base64
function parseBody(event) {
  let raw = event.body;
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  if (event.isBase64Encoded === 'True' || event.isBase64Encoded === true) {
    try { raw = Buffer.from(String(raw), 'base64').toString('utf8'); }
    catch (e) { return {}; }
  }
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function pathOf(event) {
  let p = event.path;
  if (!p && event.requestContext) {
    const rc = event.requestContext;
    p = rc.path || (rc.http && rc.http.path) || '';
  }
  // HTTP 网关开启「路由透传」后，真实路径在 headers 或原始路径里
  if (!p || p === '/') {
    const h = event.headers || event.header || {};
    for (const k in h) {
      const lk = String(k).toLowerCase();
      if ((lk === 'x-original-path' || lk === 'x-original-uri' || lk === 'x-path' || lk === 'original-path') && h[k]) {
        p = String(h[k]).split('?')[0];
        break;
      }
    }
  }
  if (typeof event.queryStringParameters === 'object' && event.queryStringParameters) {
    const qp = event.queryStringParameters;
    if (!p || p === '/') { if (qp.path) p = String(qp.path); }
  }
  p = String(p || '/').split('?')[0];
  // 兼容把 /api/xxx 挂在自定义路径下（如 /code-api/api/verify）
  const i = p.indexOf('/api/');
  if (i > 0) p = p.slice(i);
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

function header(event, name) {
  const h = event.headers || event.header || {};
  const lower = String(name).toLowerCase();
  for (const k in h) {
    if (String(k).toLowerCase() === lower) return h[k];
  }
  return '';
}

function genCode(taken) {
  for (let t = 0; t < 60; t++) {
    const c = String(Math.floor(100000 + Math.random() * 900000));
    if (!taken[c]) return c;
  }
  return '';
}

// ---------- 读所有码（保留最新 500 条）----------
async function readAll() {
  const d = getDb();
  const res = await d.collection(COLL).limit(MAX_CODES).orderBy('createdAt', 'desc').get();
  const list = (res && res.data) || [];
  return Array.isArray(list) ? list : [];
}

// ---------- 接口 1：校验访问码 ----------
async function handleVerify(event) {
  const body = parseBody(event);
  const code = String(body.code || '').trim();
  if (!/^\d{6}$/.test(code)) return fail('请输入 6 位数字访问码');

  const list = await readAll();
  const t = now();
  const hit = list.find(x => String(x.code) === code);

  if (!hit) return fail('访问码不存在，请向分享者索取');
  if (hit.used) return fail('该访问码已被使用过，请索取新的');
  if (hit.expires && hit.expires < t) return fail('该访问码已过期，请索取新的');

  // 立即标记已用：保证一个码只能成功一次（跨设备也不可复用）
  const upd = await getDb().collection(COLL).doc(hit._id).update({
    used: true,
    usedAt: t
  });

  if (upd && upd.updated === 0) {
    // 并发下已被别人抢先用掉
    return fail('该访问码刚刚已被使用，请索取新的');
  }

  return ok({ ok: true, code: code, note: hit.note || '' });
}

// ---------- 管理员校验 ----------
function adminOk(event) {
  return header(event, 'X-Admin-Password') === ADMIN_PASSWORD;
}

// ---------- 接口 2：管理员发码 ----------
async function handleCreate(event) {
  if (!adminOk(event)) return fail('管理员密码错误');
  const body = parseBody(event);
  const note = String(body.note || '').trim().slice(0, 30) || '未备注';
  const hours = Math.max(1, Math.min(8760, Number(body.hours) || 168));
  const t = now();

  const list = await readAll();
  const taken = {};
  list.forEach(x => { taken[String(x.code)] = true; });

  // 先顺手清理：未用且已过期
  for (const x of list) {
    if (!x.used && x.expires && x.expires < t) {
      try { await getDb().collection(COLL).doc(x._id).remove(); } catch (e) {}
    }
  }

  const code = genCode(taken);
  if (!code) return fail('无法生成新码，请稍后重试');

  const row = {
    code: code,
    note: note,
    expires: t + hours * 3600 * 1000,
    used: false,
    createdAt: t
  };
  await getDb().collection(COLL).add(row);

  return ok({
    ok: true,
    code: code,
    note: note,
    hours: hours,
    expires: row.expires,
    createdAt: t
  });
}

// ---------- 接口 3：码列表 ----------
async function handleList(event) {
  if (!adminOk(event)) return fail('管理员密码错误');
  const list = await readAll();
  const t = now();
  return ok({
    ok: true,
    codes: list.map(x => ({
      code: String(x.code),
      note: x.note || '',
      expires: x.expires || 0,
      used: !!x.used,
      usedAt: x.usedAt || 0,
      createdAt: x.createdAt || 0,
      state: x.used ? 'used' : (x.expires && x.expires < t ? 'expired' : 'live')
    }))
  });
}

// ---------- 接口 4：作废 ----------
async function handleRevoke(event) {
  if (!adminOk(event)) return fail('管理员密码错误');
  const body = parseBody(event);
  const code = String(body.code || '').trim();
  if (!code) return fail('缺少 code');

  const list = await readAll();
  const hit = list.find(x => String(x.code) === code);
  if (!hit) return fail('访问码不存在');

  await getDb().collection(COLL).doc(hit._id).update({ used: true, usedAt: now() });
  return ok({ ok: true, code: code });
}

// ============================================================
//  可信设备：输入一次管理员密码后，该设备长期免验证
// ============================================================

function randHex(n) {
  let s = '';
  const chars = 'abcdef0123456789';
  for (let i = 0; i < (n || 32); i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

function hash(s) {
  // 简易哈希：只用于避免明文存 token，不用于密码强度
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = ((h1 ^ c) * 16777619) >>> 0;
    h2 = ((h2 + c) * 2654435761) >>> 0;
  }
  return (h1.toString(16) + h2.toString(16));
}

// 设备首次注册：用管理员密码换长期 token（支持多台设备并存）
async function handleDeviceLogin(event) {
  if (!adminOk(event)) return fail('管理员密码错误');
  const body = parseBody(event);
  const name = String(body.name || '').trim().slice(0, 30) || '我的设备';

  const token = randHex(48);
  const t = now();

  await getDb().collection(DEV_COLL).add({
    name: name,
    tokenHash: hash(token),
    ua: String(header(event, 'User-Agent') || '').slice(0, 140),
    createdAt: t,
    lastSeenAt: t
  });

  return ok({ ok: true, token: token, name: name, createdAt: t });
}

// 校验设备 token
async function checkDevice(event) {
  const tok = header(event, 'X-Device-Token');
  if (!tok) return null;
  const res = await getDb().collection(DEV_COLL).limit(50).get();
  const list = (res && res.data) || [];
  const h = hash(tok);
  const hit = list.find(d => d.tokenHash === h);
  if (!hit) return null;
  try {
    await getDb().collection(DEV_COLL).doc(hit._id).update({ lastSeenAt: now() });
  } catch (e) {}
  return hit;
}

// 身份校验：管理员密码 或 可信设备 token
async function auth(event) {
  if (adminOk(event)) return { role: 'admin', via: 'password' };
  const d = await checkDevice(event);
  if (d) return { role: 'admin', via: 'device', device: d };
  return null;
}

// 设备列表 + 移除
async function handleDeviceList(event) {
  const a = await auth(event);
  if (!a) return fail('未授权：请输入管理员密码', 401);
  const res = await getDb().collection(DEV_COLL).limit(50).get();
  const list = (res && res.data) || [];
  // 标记哪一台是「本机」：比对请求带的 token
  const myHash = (a.device && a.device.tokenHash) || '';
  return ok({
    ok: true,
    devices: list.map(d => ({
      id: d._id,
      name: d.name,
      createdAt: d.createdAt || 0,
      lastSeenAt: d.lastSeenAt || 0,
      ua: d.ua || '',
      isMe: !!(myHash && d.tokenHash === myHash)
    })).sort((b2, a2) => (a2.lastSeenAt || 0) - (b2.lastSeenAt || 0))
  });
}

// 移除某个设备（需管理员密码，防止 token 泄露后无法反制）
async function handleDeviceRevoke(event) {
  const a0 = await auth(event);
  if (!a0) return fail('未授权：请输入管理员密码', 401);
  const body = parseBody(event);
  const id = String(body.id || '').trim();
  if (!id) return fail('缺少设备 id');

  const res = await getDb().collection(DEV_COLL).doc(id).get();
  const rows = (res && res.data) || [];
  if (!rows.length) return fail('设备不存在或已被移除');

  await getDb().collection(DEV_COLL).doc(id).remove();
  return ok({ ok: true, id: id });
}

// ============================================================
//  业务数据：多端同步（单文档，后写覆盖）
// ============================================================

// 拉取
async function handleDataGet(event) {
  const a = await auth(event);
  if (!a) return fail('未授权：请输入管理员密码', 401);
  const res = await getDb().collection(DATA_COLL).doc(DOC_ID).get();
  const d = (res && res.data && res.data[0]) || null;
  return ok({
    ok: true,
    payload: d && d.payload ? d.payload : null,
    updatedAt: d ? (d.updatedAt || 0) : 0,
    via: a.via
  });
}

// 保存（后写覆盖）
async function handleDataPut(event) {
  const a = await auth(event);
  if (!a) return fail('未授权：请输入管理员密码', 401);
  const body = parseBody(event);
  const payload = body.payload;
  if (!payload || typeof payload !== 'object') return fail('数据格式错误');
  if (JSON.stringify(payload).length > 3 * 1024 * 1024) return fail('数据过大');

  const t = now();
  const res = await getDb().collection(DATA_COLL).doc(DOC_ID).get();
  const old = (res && res.data && res.data[0]) || null;

  if (old) {
    await getDb().collection(DATA_COLL).doc(old._id).update({ payload: payload, updatedAt: t });
  } else {
    await getDb().collection(DATA_COLL).add({ _id: DOC_ID, payload: payload, updatedAt: t });
  }
  return ok({ ok: true, updatedAt: t });
}

// ---------- 入口 ----------
exports.main = async (event) => {
  const path = pathOf(event);
  try {
    if (path === '/api/verify') return await handleVerify(event);
    if (path === '/api/code') return await handleCreate(event);
    if (path === '/api/list') return await handleList(event);
    if (path === '/api/revoke') return await handleRevoke(event);
    // 设备免验证
    if (path === '/api/device/login') return await handleDeviceLogin(event);
    if (path === '/api/device/list') return await handleDeviceList(event);
    if (path === '/api/device/revoke') return await handleDeviceRevoke(event);
    if (path === '/api/device/check') {
      const d = await checkDevice(event);
      return d ? ok({ ok: true, name: d.name }) : fail('设备未授权', 401);
    }
    // 业务数据同步
    if (path === '/api/data/get') return await handleDataGet(event);
    if (path === '/api/data/put') return await handleDataPut(event);
    return fail('接口不存在：' + path, 404);
  } catch (e) {
    console.error('ERR', path, e && e.message ? e.message : e);
    return fail('服务器内部错误：' + (e && e.message ? e.message : e), 500);
  }
};
