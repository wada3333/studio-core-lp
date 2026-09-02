/**
 * 検証用の静的サーバー（依存ゼロ）
 * ---------------------------------------------------------------------------
 *   node tools/serve.mjs [port]
 *
 * 本番相当の配信条件を再現します。
 *   - gzip 圧縮（HTML / CSS / JS / JSON / SVG）
 *   - 静的アセットに長期キャッシュ、HTML は no-cache
 *   - keep-alive
 * Lighthouse はこのサーバーに対して計測してください。
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8123);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt']);

createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const filePath = join(ROOT, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html'
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'keep-alive'
  };

  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (COMPRESSIBLE.has(ext) && acceptsGzip) {
    const body = gzipSync(readFileSync(filePath));
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = body.length;
    headers.Vary = 'Accept-Encoding';
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  // 動画は Range リクエストで部分取得されるため 206 に対応する
  headers['Accept-Ranges'] = 'bytes';
  const range = req.headers.range;
  const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
      return;
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(206, headers);
    if (req.method === 'HEAD') return res.end();
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(filePath).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`STUDIO CORE LP -> http://127.0.0.1:${PORT}/`);
});
