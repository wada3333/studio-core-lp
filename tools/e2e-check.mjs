/**
 * E2E 動作確認スクリプト（ヘッドレス Chrome + CDP。外部依存なし）
 * ---------------------------------------------------------------------------
 *   1) 別ターミナルで  python -m http.server 8123
 *   2) node tools/e2e-check.mjs [http://127.0.0.1:8123]
 *
 * 予約フォームの3STEP・エラー分岐・二重送信防止・追従CTA・スクロール計測を
 * 実ブラウザ上で通しで検証し、結果を JSON で出力します。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8123';
const PORT = 9222;
const CHROME = process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

const profile = mkdtempSync(join(tmpdir(), 'sc-e2e-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--window-size=1280,900',
  '--no-first-run',
  '--disable-gpu',
  'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return;
    } catch { /* まだ起動していない */ }
    await sleep(250);
  }
  throw new Error('DevTools エンドポイントに接続できませんでした');
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** ページ内で式を評価して値を取り出す（top-level await 可） */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'evaluate に失敗');
    }
    return result.result.value;
  }
}

async function openPage(url, prepare) {
  // prepare を渡した場合は about:blank で開いてエミュレーションを設定してから遷移する
  const first = prepare ? 'about:blank' : url;
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(first)}`, { method: 'PUT' });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const session = new Session(ws);
  await session.send('Runtime.enable');
  if (prepare) {
    await session.send('Page.enable');
    await prepare(session);
    await session.send('Page.navigate', { url });
  }
  await sleep(900); // スクリプトの初期化を待つ
  return { session, targetId: target.id, ws };
}

async function closePage(page) {
  page.ws.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${page.targetId}`);
}


/** CDP のキーイベント（実際のキーボード操作を再現する） */
async function key(session, { key, code, vk, text }) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await session.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text, ...base });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
const TAB = { key: 'Tab', code: 'Tab', vk: 9 };
const ENTER = { key: 'Enter', code: 'Enter', vk: 13, text: '\r' };
const SPACE = { key: ' ', code: 'Space', vk: 32, text: ' ' };

async function typeDigits(session, digits) {
  for (const ch of digits) {
    await key(session, { key: ch, code: 'Digit' + ch, vk: 48 + Number(ch), text: ch });
  }
}

const results = {};

try {
  await waitForDevtools();

  /* ---------- 1. 予約フォームの正常系 ---------- */
  {
    const page = await openPage(`${BASE}/?debug=1`);
    results.happyPath = await page.session.evaluate(`
      const s = ms => new Promise(r => setTimeout(r, ms));
      const d = document.getElementById('booking-date');
      d.value = '2026-09-10';
      d.dispatchEvent(new Event('change', { bubbles: true }));
      await s(120);
      const loading = document.getElementById('slots-status').className;
      await s(1000);
      const slots = [...document.querySelectorAll('#slots input')].map(i => i.value);
      const focusAfterStep2 = document.activeElement.id;
      const radio = document.querySelector('#slots input');
      radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('to-step-3').click();
      await s(120);
      const focusAfterStep3 = document.activeElement.id;
      document.getElementById('booking-name').value = 'テスト 太郎';
      document.getElementById('booking-email').value = 'taro@example.com';
      document.getElementById('booking-tel').value = '090-1234-5678';
      const form = document.getElementById('booking-form');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await s(60);
      const submitting = {
        disabled: document.getElementById('booking-submit').disabled,
        label: document.getElementById('booking-submit').textContent
      };
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); // 二重送信
      await s(1200);
      return {
        loading, slots, focusAfterStep2, focusAfterStep3, submitting,
        done: !document.getElementById('booking-done').hidden,
        reservationId: document.getElementById('booking-done-id').textContent.trim(),
        focusAfterDone: document.activeElement.id,
        storedBookings: JSON.parse(sessionStorage.getItem('sc_mock_bookings') || '[]'),
        submitEvents: window.dataLayer.filter(e => e.event === 'form_submit').length,
        steps: window.dataLayer.filter(e => e.event === 'form_step').map(e => e.step)
      };
    `);
    await closePage(page);
  }

  /* ---------- 2. スクロール計測と追従CTA ---------- */
  {
    const page = await openPage(`${BASE}/?debug=1`);
    results.scrollAndSticky = await page.session.evaluate(`
      const s = ms => new Promise(r => setTimeout(r, ms));
      const cta = document.getElementById('sticky-cta');
      const read = () => ({ visible: cta.classList.contains('is-visible'), inert: cta.hasAttribute('inert') });
      const atTopBefore = read();
      const H = document.body.scrollHeight;
      for (let y = 0; y <= 1.0001; y += 0.05) { window.scrollTo({ top: H * y, behavior: 'instant' }); await s(80); }
      window.scrollTo({ top: H, behavior: 'instant' });
      await s(500);
      const bottomMarker = (() => {
        const m = document.querySelector('div[data-depth="100"]');
        return m ? { top: Math.round(m.getBoundingClientRect().top), innerH: window.innerHeight, scrollY: Math.round(window.scrollY) } : null;
      })();
      const depths = window.dataLayer.filter(e => e.event === 'scroll_depth').map(e => e.depth);
      window.scrollTo(0, document.getElementById('reasons').offsetTop + 200); await s(500);
      const midPage = read();
      window.scrollTo(0, document.getElementById('booking').offsetTop + 200); await s(500);
      const atForm = read();
      window.scrollTo(0, 0); await s(1400);
      const atTop = read();
      document.querySelector('.hero__actions .btn').click(); await s(100);
      return {
        docHeight: H, depths, bottomMarker, atTopBefore, midPage, atForm, atTop,
        ctaClicks: window.dataLayer.filter(e => e.event === 'cta_click').map(e => e.location)
      };
    `);
    await closePage(page);
  }

  /* ---------- 3. エラー分岐 ---------- */
  for (const mode of ['error', 'empty', 'conflict']) {
    const page = await openPage(`${BASE}/?mock=${mode}&debug=1`);
    results[mode] = await page.session.evaluate(`
      const s = ms => new Promise(r => setTimeout(r, ms));
      const d = document.getElementById('booking-date');
      d.value = '2026-09-11';
      d.dispatchEvent(new Event('change', { bubbles: true }));
      await s(1100);
      if ('${mode}' === 'conflict') {
        const radio = document.querySelector('#slots input');
        radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('to-step-3').click();
        await s(80);
        document.getElementById('booking-name').value = 'テスト 花子';
        document.getElementById('booking-email').value = 'hanako@example.com';
        document.getElementById('booking-tel').value = '08012345678';
        document.getElementById('booking-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await s(1300);
        return {
          status: document.getElementById('submit-status').textContent.trim(),
          className: document.getElementById('submit-status').className,
          errorTypes: window.dataLayer.filter(e => e.event === 'form_error').map(e => e.type)
        };
      }
      return {
        status: document.getElementById('slots-status').textContent.trim(),
        className: document.getElementById('slots-status').className,
        errorTypes: window.dataLayer.filter(e => e.event === 'form_error').map(e => e.type)
      };
    `);
    await closePage(page);
  }


  /* ---------- 4. キーボードだけで予約を完了できるか ---------- */
  {
    const page = await openPage(`${BASE}/?debug=1`);
    const { session } = page;
    const focusOf = () => session.evaluate(`return document.activeElement.id || document.activeElement.tagName`);
    const trail = [];

    // 日付入力までタブ移動
    let reached = false;
    for (let i = 0; i < 15 && !reached; i++) {
      await key(session, TAB);
      const id = await focusOf();
      trail.push(id);
      reached = id === 'booking-date';
    }
    // ヘッドレス Chrome の日付入力は yyyy-mm-dd の順にセグメントが並ぶ
    await typeDigits(session, '20260910');
    await sleep(1500);
    const afterDate = await focusOf();

    // 時間を選ぶ → 進む
    await key(session, TAB);
    const onRadio = await focusOf();
    await key(session, SPACE);
    await key(session, TAB);
    const onNext = await focusOf();
    await key(session, ENTER);
    await sleep(200);
    const afterNext = await focusOf();

    // 氏名・メール・電話を入力して送信
    await key(session, TAB);
    await session.send('Input.insertText', { text: 'キーボード 太郎' });
    await key(session, TAB);
    await session.send('Input.insertText', { text: 'kb@example.com' });
    await key(session, TAB);
    await session.send('Input.insertText', { text: '09011112222' });
    const beforeSubmit = await focusOf();
    await key(session, TAB); // textarea
    await key(session, TAB); // 送信ボタン
    const onSubmit = await focusOf();
    await key(session, ENTER);
    await sleep(1600);

    results.keyboardOnly = await session.evaluate(`
      return {
        completed: !document.getElementById('booking-done').hidden,
        reservationId: document.getElementById('booking-done-id').textContent.trim(),
        focusAfterDone: document.activeElement.id,
        focusRing: (() => {
          const cs = getComputedStyle(document.activeElement);
          return cs.outlineStyle + ' ' + cs.outlineWidth;
        })()
      };
    `);
    results.keyboardOnly.trail = trail;
    results.keyboardOnly.checkpoints = { afterDate, onRadio, onNext, afterNext, beforeSubmit, onSubmit };
    await closePage(page);
  }


  /* ---------- 5. ヒーロー背景動画の条件分岐 ---------- */
  {
    const probe = `
      const s = ms => new Promise(r => setTimeout(r, ms));
      await s(2600);
      const media = document.querySelector('.hero__media');
      const video = document.querySelector('.hero__video');
      const mp4 = performance.getEntriesByType('resource')
        .filter(r => r.name.indexOf('.mp4') !== -1);
      return {
        videoMounted: !!video,
        isPlaying: media.classList.contains('is-playing'),
        currentTime: video ? Number(video.currentTime.toFixed(2)) : null,
        attrs: video ? {
          muted: video.muted,
          loop: video.loop,
          autoplay: video.autoplay,
          playsinline: video.hasAttribute('playsinline'),
          poster: video.getAttribute('poster')
        } : null,
        mp4Requests: mp4.length,
        mp4Bytes: mp4.reduce((n, r) => n + (r.transferSize || 0), 0),
        stillShown: !!document.querySelector('.hero__media img')
      };
    `;

    // (a) デスクトップ幅・通常設定 → 再生される
    const desktop = await openPage(`${BASE}/`);
    results.heroVideoDesktop = await desktop.session.evaluate(probe);
    await closePage(desktop);

    // (b) モバイル幅 → 動画を読み込まない
    const mobile = await openPage(`${BASE}/`, async (session) => {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: 412, height: 823, deviceScaleFactor: 2, mobile: true
      });
    });
    results.heroVideoMobile = await mobile.session.evaluate(probe);
    await closePage(mobile);

    // (c) prefers-reduced-motion: reduce → 動画を読み込まない
    const reduced = await openPage(`${BASE}/`, async (session) => {
      await session.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
      });
    });
    results.heroVideoReducedMotion = await reduced.session.evaluate(probe);
    await closePage(reduced);
  }

  console.log(JSON.stringify(results, null, 2));
} finally {
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 後始末の失敗は無視 */ }
}
