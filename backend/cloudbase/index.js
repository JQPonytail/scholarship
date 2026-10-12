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

const cloudbase = require('@cloudbase/node-sdk');

// ---------- 配置 ----------
const ADMIN_PASSWORD = 'JQP@2026';
const DB = 'scholarship';          // 数据表名
const COLL = 'codes';              // 集合名
const MAX_CODES = 500;             // 最多保留多少条历史码

// ---------- CloudBase 初始化 ----------
let app, db;
function init() {
  if (db) return db;
  app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
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
      'access-control-allow-headers': 'Content-Type, X-Admin-Password',
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
  const d = init();
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
  const upd = await init().collection(COLL).doc(hit._id).update({
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
      try { await init().collection(COLL).doc(x._id).remove(); } catch (e) {}
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
  await init().collection(COLL).add(row);

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

  await init().collection(COLL).doc(hit._id).update({ used: true, usedAt: now() });
  return ok({ ok: true, code: code });
}

// ---------- 入口 ----------
exports.main = async (event) => {
  const path = pathOf(event);
  try {
    if (path === '/api/verify') return await handleVerify(event);
    if (path === '/api/code') return await handleCreate(event);
    if (path === '/api/list') return await handleList(event);
    if (path === '/api/revoke') return await handleRevoke(event);
    return fail('接口不存在：' + path, 404);
  } catch (e) {
    console.error('ERR', path, e && e.message ? e.message : e);
    return fail('服务器内部错误：' + (e && e.message ? e.message : e), 500);
  }
};
