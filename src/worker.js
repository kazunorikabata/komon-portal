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
function clientMonthRule(oldData, newData) {
  const o = oldData || {}, n = newData || {};
  if (o.submitted && !n.submitted) return '提出済みの月の提出を取り消すことはできません。事務所に修正を依頼してください。';
  // 修正依頼：追加だけ。承認は事務所しかできない
  const or = o.requests || [], nr = n.requests || [];
  if (nr.length < or.length || or.some((r, i) => !same(r, nr[i]))) return '修正依頼の記録は変えられません。';
  if (nr.slice(or.length).some(r => r.status !== 'pending')) return '修正依頼は事務所の承認が必要です。';
  // 履歴：追加だけ
  const ol = o.log || [], nl = n.log || [];
  if (nl.length < ol.length || ol.some((r, i) => !same(r, nl[i]))) return '履歴は変えられません。';
  if (o.submitted) {
    // 提出済みの月で直せるのは、入金・支払の記録と、修正依頼・履歴だけ
    const free = new Set(['srPaid', 'plPaid', 'requests', 'log']);
    for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
      if (!free.has(k) && !same(o[k], n[k])) return 'この月は提出済みです。直すときは事務所に修正を依頼してください。';
    }
  }
  return null;
}

const MONTH_KEY = /^m:\d{4}-\d{2}$/;

/* ---------- 顧問先のAPI ---------- */

async function clientApi(request, env, url, email, client) {
  const path = url.pathname;
  if (path === '/api/me' && request.method === 'GET') return json({ email, client: { id: client.id, name: client.name, template: client.template } });
  if (path === '/api/state' && request.method === 'GET') return json({ docs: await loadDocs(env, client.id, false) });
  const m = path.match(/^\/api\/doc\/(master|m:\d{4}-\d{2})$/);
  if (m && request.method === 'PUT') {
    const key = m[1];
    const body = await request.json().catch(() => null);
    if (!body || typeof body.data !== 'object' || !Number.isInteger(body.version)) return fail(400, '送られた内容が正しくありません。');
    if (MONTH_KEY.test(key)) {
      const cur = await getDoc(env, client.id, key);
      if (cur.version !== body.version) return fail(409, 'ほかの人が先に更新しました。画面を読み込み直してください。');
      const why = clientMonthRule(cur.data, body.data);
      if (why) return fail(423, why);
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
  const dm = rest.match(/^\/doc\/(master|office|m:\d{4}-\d{2})$/);
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

      // 事務所のページ
      if (sub === env.OFFICE_HOST) {
        const staff = String(env.STAFF_EMAILS || '').toLowerCase().split(',').map(s => s.trim());
        if (!staff.includes(email)) return withHeaders(new Response('このページを見る権限がありません。', { status: 403 }));
        if (url.pathname.startsWith('/api/')) return withHeaders(await officeApi(request, env, url, email));
        return withHeaders(await page(env, request, '/office/'));
      }

      // 顧問先のページ：サブドメインの顧問先に、このメールが登録されているか
      const client = await env.DB.prepare(`SELECT c.* FROM clients c JOIN members m ON m.client_id = c.id
        WHERE c.subdomain = ? AND m.email = ?`).bind(sub, email).first();
      if (!client) return withHeaders(new Response('このページを見る権限がありません。', { status: 403 }));
      if (url.pathname.startsWith('/api/')) return withHeaders(await clientApi(request, env, url, email, client));
      // 顧問先ごとのひな形の画面を返す
      const tpl = TEMPLATES[client.template] ? client.template : 'peters';
      return withHeaders(await page(env, request, `/t/${tpl}/`));
    } catch (err) {
      return withHeaders(fail(500, 'サーバーでエラーが起きました。'));
    }
  },
};
