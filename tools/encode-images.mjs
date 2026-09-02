/**
 * 生成画像（JPEG/PNG）を WebP に変換・リサイズする
 * ---------------------------------------------------------------------------
 *   node tools/serve.mjs 8123        # 別ターミナルで起動しておく
 *   node tools/encode-images.mjs
 *
 * ヘッドレス Chrome の canvas.toBlob('image/webp') を使うため、
 * cwebp や sharp などの追加インストールは不要です。
 * 変換元は assets/originals/ に置き、出力を assets/images/ に書き出します。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.SC_BASE || 'http://127.0.0.1:8123';
const PORT = 9340;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/** [出力名, 変換元, 目標の横幅, WebP品質] */
const JOBS = [
  ['hero.webp', 'hero', 1600, 0.78],
  ['hero-1200.webp', 'hero', 1200, 0.78],
  ['hero-800.webp', 'hero', 800, 0.78],
  ['reason-1.webp', 'reason-1', 1200, 0.80],
  ['reason-2.webp', 'reason-2', 1200, 0.80],
  ['reason-3.webp', 'reason-3', 1200, 0.80],
  ['trainer-1.webp', 'trainer-1', 600, 0.82],
  ['trainer-2.webp', 'trainer-2', 600, 0.82],
  ['trainer-3.webp', 'trainer-3', 600, 0.82]
];

const ORIGINALS = join(ROOT, 'assets', 'originals');
const files = readdirSync(ORIGINALS);

/** 拡張子の揺れ（hero.webp.jpg など）を吸収して変換元を探す */
function findSource(stem) {
  const hit = files.find((f) => f.toLowerCase().startsWith(stem + '.'));
  if (!hit) throw new Error('変換元が見つかりません: ' + stem);
  return hit;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'sc-enc-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', 'about:blank'
], { stdio: 'ignore' });

try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* 起動待ち */ }
    await sleep(250);
  }

  const target = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE + '/')}`, { method: 'PUT' }
  )).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const entry = pending.get(msg.id);
    if (entry) { pending.delete(msg.id); entry(msg); }
  });
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  await send('Runtime.enable');
  await sleep(600);

  for (const [outName, stem, targetWidth, quality] of JOBS) {
    const source = findSource(stem);
    const url = `${BASE}/assets/originals/${encodeURIComponent(source)}`;
    const expression = `(async () => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = ${JSON.stringify(url)};
      await img.decode();
      const scale = Math.min(1, ${targetWidth} / img.naturalWidth);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/webp', ${quality}));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 8192) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
      }
      return JSON.stringify({
        src: [img.naturalWidth, img.naturalHeight], out: [w, h], data: btoa(bin)
      });
    })()`;

    const res = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    });
    if (res.result.exceptionDetails) {
      throw new Error(outName + ': ' + JSON.stringify(res.result.exceptionDetails));
    }
    const out = JSON.parse(res.result.result.value);
    const buffer = Buffer.from(out.data, 'base64');
    writeFileSync(join(ROOT, 'assets', 'images', outName), buffer);
    const before = statSync(join(ORIGINALS, source)).size;
    console.log(
      `${outName.padEnd(16)} ${out.src.join('x').padEnd(11)} -> ${out.out.join('x').padEnd(10)} ` +
      `${(before / 1024 / 1024).toFixed(2)}MB -> ${(buffer.length / 1024).toFixed(0)}KB`
    );
  }

  ws.close();
} finally {
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 後始末の失敗は無視 */ }
}
