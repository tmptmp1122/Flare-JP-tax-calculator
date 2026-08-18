/**
 * static/ を確認用に配信する小さなサーバー。
 *
 *   npm run serve:static
 *
 * ES モジュールは file:// では読み込めないため、動作確認にはHTTP配信が要る。
 * 公開時はこのサーバーは不要で、static/ の中身をそのまま置くだけでよい。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static');
const PORT = process.env.PORT || 4000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);

    // ルート外への参照を防ぐ
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('見つかりません: ' + urlPath);
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, () => {
    console.log(`\n  静的サイト版のプレビュー →  http://localhost:${PORT}\n`);
  });
