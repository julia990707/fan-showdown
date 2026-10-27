import { getStore } from '@netlify/blobs';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
const err = (error, message, s = 400) => json({ error, message }, s);
const pad = n => String(n).padStart(6, '0');
const PW = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,15}$/;
const isId = v => typeof v === 'string' && /^\d{6}$/.test(v);
const isPid = v => typeof v === 'string' && /^[\w-]{8,64}$/.test(v);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const hashPw = (pw, salt) => scryptSync(pw, salt, 32);
const strip = ({ pwh, salt, ...rest }) => rest;
const getJ = (s, k) => s.get(k, { type: 'json' });

function pwOk(bank, pw) {
  if (typeof pw !== 'string') return false;
  const a = hashPw(pw, bank.salt), b = Buffer.from(bank.pwh, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
async function authed(s, d) {
  if (!isId(d.id)) return { e: err('NOT_FOUND', '該題庫不存在', 404) };
  const bank = await getJ(s, 'bank/' + d.id);
  if (!bank) return { e: err('NOT_FOUND', '該題庫不存在', 404) };
  if (!pwOk(bank, d.password)) return { e: err('BAD_PW', '密碼錯誤', 403) };
  return { bank };
}
async function scoresOf(s, bankId) {
  const { blobs } = await s.list({ prefix: `score/${bankId}/` });
  const rows = await Promise.all(blobs.map(b => getJ(s, b.key)));
  return rows.filter(Boolean).sort((a, b) => b.total - a.total);
}
async function myKeys(s, pid) {
  const { blobs } = await s.list({ prefix: 'score/' });
  return blobs.map(b => b.key).filter(k => k.endsWith('/' + pid));
}

const H = {
  async peek(d, s) {
    const c = (await getJ(s, 'meta/counter')) || { n: 0 };
    return json({ id: pad(c.n + 1) });
  },
  async create(d, s) {
    const name = str(d.name, 10), intro = str(d.intro, 25), creator = str(d.creator, 10);
    if (!name || !intro || !creator) return err('INVALID', '請完整填寫題庫名稱、介紹與建立者');
    if (!PW.test(d.password || '')) return err('INVALID', '密碼須為 8–15 字的英數字混合');
    let n = ((await getJ(s, 'meta/counter')) || { n: 0 }).n;
    const salt = randomBytes(16).toString('hex'), pwh = hashPw(d.password, salt).toString('hex');
    for (let t = 0; t < 30; t++) {
      n++;
      const id = pad(n);
      if (await s.get('bank/' + id)) continue;
      const bank = { id, name, intro, creator, pub: !!d.pub, salt, pwh, songs: [], createdAt: Date.now() };
      const r = await s.setJSON('bank/' + id, bank, { onlyIfNew: true });
      if (r && r.modified === false) continue;
      await s.setJSON('meta/counter', { n });
      return json({ id });
    }
    return err('BUSY', '系統忙碌，請稍後再試', 503);
  },
  async get(d, s) {
    if (!isId(d.id)) return err('NOT_FOUND', '該題庫不存在', 404);
    const bank = await getJ(s, 'bank/' + d.id);
    return bank ? json({ bank: strip(bank) }) : err('NOT_FOUND', '該題庫不存在', 404);
  },
  async auth(d, s) {
    const r = await authed(s, d);
    return r.e || json({ ok: true });
  },
  async saveSongs(d, s) {
    const r = await authed(s, d);
    if (r.e) return r.e;
    const songs = d.songs;
    if (!Array.isArray(songs) || songs.length > 200) return err('INVALID', '歌曲資料不正確');
    const clean = [];
    for (const x of songs) {
      const title = str(x && x.title, 50), lines = String((x && x.lyrics) || '').split('\n');
      if (!title) return err('INVALID', '請輸入歌名');
      if (lines.length > 300 || lines.some(l => !l.trim() || l.length > 200)) return err('INVALID', '請刪除歌詞中的空白行（每行至多 200 字）');
      clean.push({ title, lyrics: lines.join('\n') });
    }
    await s.setJSON('bank/' + r.bank.id, { ...r.bank, songs: clean });
    return json({ ok: true });
  },
  async list(d, s) {
    const { blobs } = await s.list({ prefix: 'bank/' });
    const all = (await Promise.all(blobs.map(b => getJ(s, b.key)))).filter(b => b && b.pub);
    all.sort((a, b) => (a.id < b.id ? -1 : 1));
    const banks = await Promise.all(all.map(async b => ({
      id: b.id, name: b.name, intro: b.intro,
      top: (await scoresOf(s, b.id)).slice(0, 3).map(x => ({ name: x.name, total: x.total })),
    })));
    return json({ banks });
  },
  async submit(d, s) {
    const pts = d.pts;
    if (!isId(d.bankId) || !isPid(d.playerId) || !Number.isInteger(pts) || pts < 0 || pts > 500 || pts % 10) return err('INVALID', '資料不正確');
    const bank = await getJ(s, 'bank/' + d.bankId);
    if (!bank) return err('NOT_FOUND', '該題庫不存在', 404);
    const key = `score/${d.bankId}/${d.playerId}`, old = (await getJ(s, key)) || { total: 0 };
    await s.setJSON(key, { bankId: d.bankId, bankName: bank.name, playerId: d.playerId, name: str(d.name, 10) || '玩家', total: old.total + pts });
    return json({ ok: true });
  },
  async me(d, s) {
    if (!isPid(d.playerId)) return err('INVALID', '資料不正確');
    const rows = [];
    for (const k of await myKeys(s, d.playerId)) {
      const mine = await getJ(s, k);
      if (!mine) continue;
      const rank = (await scoresOf(s, mine.bankId)).findIndex(x => x.playerId === d.playerId) + 1;
      rows.push({ bankId: mine.bankId, bankName: mine.bankName, total: mine.total, rank });
    }
    return json({ rows });
  },
  async rename(d, s) {
    if (!isPid(d.playerId)) return err('INVALID', '資料不正確');
    const name = str(d.name, 10) || '玩家';
    for (const k of await myKeys(s, d.playerId)) {
      const x = await getJ(s, k);
      if (x && x.name !== name) await s.setJSON(k, { ...x, name });
    }
    return json({ ok: true });
  },
  async clear(d, s) {
    if (!isPid(d.playerId)) return err('INVALID', '資料不正確');
    for (const k of await myKeys(s, d.playerId)) await s.delete(k);
    return json({ ok: true });
  },
};

export default async (req) => {
  if (req.method !== 'POST') return err('METHOD', '只接受 POST', 405);
  let d;
  try { d = await req.json(); } catch { return err('BAD_JSON', '格式錯誤'); }
  const h = Object.prototype.hasOwnProperty.call(H, d.a) ? H[d.a] : null;
  if (!h) return err('BAD_ACTION', '未知的操作');
  try {
    return await h(d, getStore({ name: 'fof', consistency: 'strong' }));
  } catch (e) {
    console.error(e);
    return err('SERVER', '伺服器錯誤，請稍後再試', 500);
  }
};

export const config = { path: '/api' };
