/**
 * Lighthouse をまとめて実行し、中央値を出す
 *   node tools/lighthouse-run.mjs [回数] [URL] [mobile|desktop]
 * 事前に node tools/serve.mjs を起動しておくこと。
 */
import { execSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

const runs = Number(process.argv[2] || 5);
const url = process.argv[3] || 'http://127.0.0.1:8123';
const preset = process.argv[4] || 'mobile';
const tmp = './.lh-tmp.json';
const cats = ['performance', 'accessibility', 'best-practices', 'seo'];
const rows = [];

for (let i = 1; i <= runs; i++) {
  const cmd = `npx --yes lighthouse@12 ${url} --output=json --output-path=${tmp} --quiet` +
    ` --chrome-flags="--headless=new --no-sandbox"` +
    (preset === 'desktop' ? ' --preset=desktop' : '');
  // Chrome 終了時の一時ディレクトリ削除に失敗して非ゼロ終了することがあるが、レポートは書き出されている
  try { execSync(cmd, { stdio: 'ignore' }); } catch { /* noop */ }
  const r = JSON.parse(readFileSync(tmp, 'utf8'));
  const row = { run: i, bench: Math.round(r.environment.benchmarkIndex) };
  for (const c of cats) row[c] = Math.round(r.categories[c].score * 100);
  for (const [k, id] of [['FCP', 'first-contentful-paint'], ['LCP', 'largest-contentful-paint'],
    ['TBT', 'total-blocking-time'], ['CLS', 'cumulative-layout-shift'], ['SI', 'speed-index']]) {
    row[k] = r.audits[id].numericValue;
  }
  rows.push(row);
  console.log(`run ${i}: ` + cats.map(c => row[c]).join('/') +
    ` | TBT ${Math.round(row.TBT)}ms FCP ${Math.round(row.FCP)}ms LCP ${Math.round(row.LCP)}ms bench ${row.bench}`);
}

const median = (list) => {
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
console.log('\n--- median of ' + runs + ' runs (' + preset + ') ---');
for (const c of cats) console.log(c.padEnd(16), median(rows.map(r => r[c])));
for (const k of ['FCP', 'LCP', 'TBT', 'CLS', 'SI']) {
  const v = rows.map(r => r[k]);
  console.log(k.padEnd(16), Math.round(median(v)), ` (min ${Math.round(Math.min(...v))} / max ${Math.round(Math.max(...v))})`);
}
try { rmSync(tmp); } catch { /* noop */ }
