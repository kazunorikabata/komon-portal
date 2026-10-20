import { TEMPLATES } from './templates.js';

// 顧問先専用ページのサーバー側。
// 1. Cloudflare Access のログイン（JWT）を確かめて、メールアドレスを得る
// 2. ホスト名で「どの顧問先のページか」「事務所のページか」を決め、そのメールに権限があるか確かめる
// 3. 権限があれば画面（HTML）とAPIを返す。データは D1 に保存し、変更のたびに前の版を残す

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const fail = (status, message) => json({ error: message }, status);
const nowIso = () => new Date().toISOString();

/* ---------- ログインの確認（Cloudflare Access の JWT） ---------- */

let certCache = { at: 0, keys: [] };

function b64urlBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function accessKeys(env) {
  if (Date.now() - certCache.at < 60 * 60 * 1000 && certCache.keys.length) return certCache.keys;
  const res = await fetch(`https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('Access の公開鍵を取得できませんでした');
  certCache = { at: Date.now(), keys: (await res.json()).keys || [] };
  return certCache.keys;
}

async function verifiedEmail(request, env) {
  // 手元での動作確認用（wrangler dev のときだけ .dev.vars に DEV_EMAIL を書く）
  if (env.DEV_EMAIL) return env.DEV_EMAIL.toLowerCase();
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) return null;
  const header = b64urlJson(h);
  const jwk = (await accessKeys(env)).find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;
  const payload = b64urlJson(p);
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  if (payload.iss !== `https://${env.TEAM_DOMAIN}`) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const allowed = String(env.ACCESS_AUD || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!auds.some(a => allowed.includes(a))) return null;
  return String(payload.email || '').toLowerCase() || null;
}

/* ---------- データ ---------- */

async function audit(env, clientId, email, action, detail) {
  await env.DB.prepare('INSERT INTO audit (client_id, at, email, action, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(clientId, nowIso(), email, action, detail ? JSON.stringify(detail) : null).run();
}

async function loadDocs(env, clientId, includeOffice) {
  const { results } = await env.DB.prepare('SELECT key, data, version FROM docs WHERE client_id = ?').bind(clientId).all();
  const docs = {};
  for (const r of results) if (includeOffice || r.key !== 'office') docs[r.key] = { data: JSON.parse(r.data), version: r.version };
  return docs;
}

async function getDoc(env, clientId, key) {
  const r = await env.DB.prepare('SELECT data, version FROM docs WHERE client_id = ? AND key = ?').bind(clientId, key).first();
  return r ? { data: JSON.parse(r.data), version: r.version } : { data: null, version: 0 };
}

// version が一致したときだけ書く（同時に直したときの上書きを防ぐ）
async function putDoc(env, clientId, key, data, version, email) {
  const text = JSON.stringify(data);
  if (text.length > 900_000) return { error: 'データが大きすぎます' };
  const at = nowIso();
  if (version === 0) {
    const r = await env.DB.prepare('INSERT OR IGNORE INTO docs (client_id, key, data, version, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?)')
      .bind(clientId, key, text, at, email).run();
    if (!r.meta.changes) return { conflict: true };
  } else {
    const r = await env.DB.prepare('UPDATE docs SET data = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE client_id = ? AND key = ? AND version = ?')
      .bind(text, at, email, clientId, key, version).run();
    if (!r.meta.changes) return { conflict: true };
  }
  await env.DB.prepare('INSERT INTO doc_history (client_id, key, version, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(clientId, key, version + 1, text, at, email).run();
  return { version: version + 1 };
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// 顧問先が月のデータを書き換えるときの決まり（事務所は対象外）
// 提出は帳簿ごと。提出済みの帳簿の中身は直せない。入金・支払の記録、修正依頼、履歴はいつでも足せる
const BOOK_FIELDS = { cash: ['rows', 'count'], sr: ['sr'], pl: ['inv'], wage: ['wage'], pay: ['pay'] };
const BOOK_NAMES = { cash: '現金出納帳', sr: '売上精算書', pl: '仕入一覧', wage: '給与', pay: '給与' };
// 標準のひな形の出納帳は 'cb:出納帳のID' で提出し、中身は cb[出納帳のID] にある
const bookData = (d, b) => b.startsWith('cb:') ? [d.cb?.[b.slice(3)]] : (BOOK_FIELDS[b] || []).map(f => d[f]);
// 以前の「月まとめて」の提出（文字列）は、3つとも提出済みとみなす
const subMap = v => typeof v === 'string' ? { cash: v, sr: v, pl: v } : (v && typeof v === 'object' ? v : {});

function clientMonthRule(oldData, newData) {
  const o = oldData || {}, n = newData || {};
  const os = subMap(o.submitted), ns = subMap(n.submitted);
  for (const b of Object.keys(os)) {
    if (os[b] && ns[b] !== os[b]) return `提出済みの${BOOK_NAMES[b] || '出納帳'}の提出を取り消すことはできません。事務所に修正を依頼してください。`;
  }
  // 修正依頼：追加だけ。承認は事務所しかできない
  const or = o.requests || [], nr = n.requests || [];
  if (nr.length < or.length || or.some((r, i) => !same(r, nr[i]))) return '修正依頼の記録は変えられません。';
  if (nr.slice(or.length).some(r => r.status !== 'pending')) return '修正依頼は事務所の承認が必要です。';
  // 履歴：追加だけ
  const ol = o.log || [], nl = n.log || [];
  if (nl.length < ol.length || ol.some((r, i) => !same(r, nl[i]))) return '履歴は変えられません。';
  // 提出済みの帳簿の中身
  for (const b of Object.keys(os)) {
    if (os[b] && !same(bookData(o, b), bookData(n, b))) return `${BOOK_NAMES[b] || 'この出納帳'}は提出済みです。直すときは事務所に修正を依頼してください。`;
  }
  return null;
}

const MONTH_KEY = /^m:\d{4}-\d{2}$/;

// 標準のひな形では、メールアドレスごとに入力できる出納帳を決められる（config の access。給与計算は 'pay'）。
// 指定のない人と事務所のスタッフは、すべての出納帳を使える
async function allowedBooks(env, client, email, isStaff) {
  if (isStaff || client.template !== 'std') return null;
  const list = (await getDoc(env, client.id, 'config')).data?.access?.[email];
  return Array.isArray(list) ? list : null;
}
const pickBooks = (cb, keep) => Object.fromEntries(Object.entries(cb || {}).filter(([k]) => keep(k)));

// 顧問先に渡すデータ：だれが何を使えるか（access）は渡さない。使えない出納帳の中身も渡さない
function clientView(docs, allowed) {
  // 給与を使えない人には、従業員の情報と給与の入力を渡さない
  const noPay = allowed && !allowed.includes('pay');
  if (noPay && docs.master?.data?.employees) { const { employees, ...m } = docs.master.data; docs.master = { ...docs.master, data: m }; }
  if (docs.config?.data) {
    const { access, ...cfg } = docs.config.data;
    if (allowed) cfg.cashbooks = (cfg.cashbooks || []).filter(b => allowed.includes(b.id));
    if (noPay && cfg.payroll) cfg.payroll = { ...cfg.payroll, enabled: false };
    docs.config = { ...docs.config, data: cfg };
  }
  if (allowed) for (const [k, d] of Object.entries(docs)) {
    if (!MONTH_KEY.test(k)) continue;
    const { pay, ...rest } = d.data || {};
    const data = noPay ? rest : { ...d.data };
    if (data.cb) data.cb = pickBooks(data.cb, id => allowed.includes(id));
    docs[k] = { ...d, data };
  }
  return docs;
}

// 使える出納帳が限られた人の書き込み：使えない出納帳の中身は今のまま残し、提出・修正依頼も使える出納帳だけにする
function mergeAllowed(cur, next, allowed) {
  const o = cur || {}, n = next || {};
  const cb = { ...pickBooks(o.cb, id => !allowed.includes(id)), ...pickBooks(n.cb, id => allowed.includes(id)) };
  const merged = { ...n, cb };
  if (!Object.keys(cb).length) delete merged.cb;
  if (!allowed.includes('pay')) { if (o.pay !== undefined) merged.pay = o.pay; else delete merged.pay; }
  const os = subMap(o.submitted), ns = subMap(n.submitted);
  const ok = k => k.startsWith('cb:') ? allowed.includes(k.slice(3)) : k === 'pay' && allowed.includes('pay');
  for (const k of new Set([...Object.keys(os), ...Object.keys(ns)])) if (!ok(k) && os[k] !== ns[k]) return { error: 'この出納帳は入力できません。' };
  if ((n.requests || []).slice((o.requests || []).length).some(r => !ok(r.book || ''))) return { error: 'この出納帳は入力できません。' };
  return { data: merged };
}

/* ---------- 顧問先のAPI ---------- */

async function clientApi(request, env, url, email, client, isStaff) {
  const path = url.pathname;
  if (path === '/api/me' && request.method === 'GET') return json({ email, client: { id: client.id, name: client.name, template: client.template } });
  if (path === '/api/state' && request.method === 'GET') {
    const allowed = await allowedBooks(env, client, email, isStaff);
    return json({ docs: clientView(await loadDocs(env, client.id, false), allowed) });
  }
  const m = path.match(/^\/api\/doc\/(master|m:\d{4}-\d{2})$/);
  if (m && request.method === 'PUT') {
    const key = m[1];
    const body = await request.json().catch(() => null);
    if (!body || typeof body.data !== 'object' || !Number.isInteger(body.version)) return fail(400, '送られた内容が正しくありません。');
    if (MONTH_KEY.test(key)) {
      const cur = await getDoc(env, client.id, key);
      if (cur.version !== body.version) return fail(409, 'ほかの人が先に更新しました。画面を読み込み直してください。');
      const allowed = await allowedBooks(env, client, email, isStaff);
      if (allowed) {
        const r = mergeAllowed(cur.data, body.data, allowed);
        if (r.error) return fail(403, r.error);
        body.data = r.data;
      }
      const why = clientMonthRule(cur.data, body.data);
      if (why) return fail(423, why);
    }
    // 給与を使えない人が master を書くときは、従業員の情報と給与の設定を今のまま残す
    if (key === 'master') {
      const allowed = await allowedBooks(env, client, email, isStaff);
      if (allowed && !allowed.includes('pay')) {
        const cur = await getDoc(env, client.id, key);
        if (cur.version !== body.version) return fail(409, 'ほかの人が先に更新しました。画面を読み込み直してください。');
        const { employees, paySettings, ...rest } = body.data;
        body.data = { ...rest, ...(cur.data?.employees && { employees: cur.data.employees }), ...(cur.data?.paySettings && { paySettings: cur.data.paySettings }) };
      }
    }
    const r = await putDoc(env, client.id, key, body.data, body.version, email);
    if (r.error) return fail(413, r.error);
    if (r.conflict) return fail(409, 'ほかの人が先に更新しました。画面を読み込み直してください。');
    await audit(env, client.id, email, 'save', { key, version: r.version });
    return json({ version: r.version });
  }
  return fail(404, '見つかりません。');
}

/* ---------- 事務所のAPI ---------- */

const randomSub = () => 'c-' + Array.from(crypto.getRandomValues(new Uint8Array(4)), b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

async function officeApi(request, env, url, email) {
  const path = url.pathname, method = request.method;
  if (path === '/api/me' && method === 'GET') return json({ email, office: true });

  if (path === '/api/office/templates' && method === 'GET') return json({ templates: TEMPLATES });
  if (path === '/api/office/clients' && method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT c.id, c.name, c.subdomain, c.template, c.created_at,
      (SELECT group_concat(email, ',') FROM members m WHERE m.client_id = c.id) AS emails FROM clients c ORDER BY c.created_at`).all();
    return json({ clients: results.map(r => ({ ...r, emails: r.emails ? r.emails.split(',') : [] })) });
  }
  if (path === '/api/office/clients' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    if (!name) return fail(400, '顧問先の名前を入力してください。');
    const id = crypto.randomUUID();
    let sub = String(body.subdomain || '').trim().toLowerCase() || randomSub();
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(sub) || sub === env.OFFICE_HOST || sub === 'www') return fail(400, 'サブドメインは英小文字・数字・ハイフンで入力してください。');
    const template = String(body.template || 'peters');
    if (!TEMPLATES[template]) return fail(400, '画面の種類が正しくありません。');
    const r = await env.DB.prepare('INSERT OR IGNORE INTO clients (id, name, subdomain, template, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, name, sub, template, nowIso()).run();
    if (!r.meta.changes) return fail(409, 'そのサブドメインはすでに使われています。');
    await audit(env, id, email, 'client.create', { name, sub });
    return json({ id, name, subdomain: sub, template });
  }

  // すべての顧問先の提出の状況（指定した月の提出・修正依頼と、標準のひな形の帳簿の名前）
  if (path === '/api/office/overview' && method === 'GET') {
    const months = String(url.searchParams.get('months') || '').split(',').filter(m => /^\d{4}-\d{2}$/.test(m)).slice(0, 12);
    const keys = months.map(m => 'm:' + m);
    const rows = keys.length ? (await env.DB.prepare(`SELECT client_id, key, json_extract(data, '$.submitted') AS submitted, json_extract(data, '$.requests') AS requests, updated_at
      FROM docs WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys).all()).results : [];
    const cfgs = (await env.DB.prepare(`SELECT client_id, json_extract(data, '$.cashbooks') AS cashbooks, json_extract(data, '$.payroll') AS payroll FROM docs WHERE key = 'config'`).all()).results;
    const parse = v => { try { return v ? JSON.parse(v) : null; } catch (e) { return null; } };
    return json({
      months: rows.map(r => ({ client: r.client_id, month: r.key.slice(2), submitted: parse(r.submitted), requests: (parse(r.requests) || []).map(q => ({ book: q.book, status: q.status })), updatedAt: r.updated_at })),
      configs: Object.fromEntries(cfgs.map(r => {
        const pr = parse(r.payroll);
        return [r.client_id, { cashbooks: (parse(r.cashbooks) || []).map(b => ({ id: b.id, name: b.name })), payroll: pr?.enabled ? { name: pr.name || '給与' } : null }];
      })),
    });
  }

  const cm = path.match(/^\/api\/office\/clients\/([0-9a-f-]{36})(\/.*)?$/);
  if (!cm) return fail(404, '見つかりません。');
  const clientId = cm[1], rest = cm[2] || '';
  const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
  if (!client) return fail(404, '顧問先が見つかりません。');

  if (rest === '/members' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const addr = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return fail(400, 'メールアドレスの形が正しくありません。');
    await env.DB.prepare('INSERT OR IGNORE INTO members (client_id, email) VALUES (?, ?)').bind(clientId, addr).run();
    await audit(env, clientId, email, 'member.add', { email: addr });
    return json({ ok: true });
  }
  if (rest === '/members' && method === 'DELETE') {
    const addr = String(url.searchParams.get('email') || '').toLowerCase();
    await env.DB.prepare('DELETE FROM members WHERE client_id = ? AND email = ?').bind(clientId, addr).run();
    await audit(env, clientId, email, 'member.remove', { email: addr });
    return json({ ok: true });
  }
  if (rest === '/state' && method === 'GET') return json({ client, docs: await loadDocs(env, clientId, true) });
  if (rest === '/audit' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT at, email, action, detail FROM audit WHERE client_id = ? ORDER BY id DESC LIMIT 200').bind(clientId).all();
    return json({ audit: results });
  }
  // config は顧問先ページの設定（出納帳の種類など）。顧問先は読めるが、書けるのは事務所だけ
  const dm = rest.match(/^\/doc\/(master|office|config|m:\d{4}-\d{2})$/);
  if (dm && method === 'PUT') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.data !== 'object' || !Number.isInteger(body.version)) return fail(400, '送られた内容が正しくありません。');
    const r = await putDoc(env, clientId, dm[1], body.data, body.version, email);
    if (r.error) return fail(413, r.error);
    if (r.conflict) return fail(409, 'ほかの人が先に更新しました。画面を読み込み直してください。');
    await audit(env, clientId, email, 'office.save', { key: dm[1], version: r.version });
    return json({ version: r.version });
  }
  return fail(404, '見つかりません。');
}

/* ---------- 入口 ---------- */

const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'",
};
function withHeaders(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  return r;
}

const page = (env, request, file) => env.ASSETS.fetch(new Request(new URL(file, request.url), request));

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const sub = url.hostname.split('.')[0].toLowerCase();
      const email = await verifiedEmail(request, env);
      if (!email) return withHeaders(fail(401, 'ログインしてください。'));

      const isStaff = String(env.STAFF_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean).includes(email);

      // 事務所のページ
      if (sub === env.OFFICE_HOST) {
        if (!isStaff) return withHeaders(new Response('このページを見る権限がありません。', { status: 403 }));
        if (url.pathname.startsWith('/api/')) return withHeaders(await officeApi(request, env, url, email));
        if (url.pathname.startsWith('/lib/')) return withHeaders(await env.ASSETS.fetch(request));
        return withHeaders(await page(env, request, '/office/'));
      }

      // 顧問先のページ：事務所のスタッフはすべての顧問先に入れる。ほかは、その顧問先に登録されたメールだけ
      const client = isStaff
        ? await env.DB.prepare('SELECT * FROM clients WHERE subdomain = ?').bind(sub).first()
        : await env.DB.prepare(`SELECT c.* FROM clients c JOIN members m ON m.client_id = c.id
          WHERE c.subdomain = ? AND m.email = ?`).bind(sub, email).first();
      if (!client) return withHeaders(new Response('このページを見る権限がありません。', { status: 403 }));
      if (url.pathname.startsWith('/api/')) return withHeaders(await clientApi(request, env, url, email, client, isStaff));
      if (url.pathname.startsWith('/lib/')) return withHeaders(await env.ASSETS.fetch(request));
      // 顧問先ごとのひな形の画面を返す
      const tpl = TEMPLATES[client.template] ? client.template : 'peters';
      return withHeaders(await page(env, request, `/t/${tpl}/`));
    } catch (err) {
      return withHeaders(fail(500, 'サーバーでエラーが起きました。'));
    }
  },
};
