/**
 * 静的サイト版のアセットを組み立てる。
 *
 *   npm run build:static
 *
 * shared/ と style.css と exceljs を static/ 配下へコピーする。
 * shared/ は Node 版と静的サイト版の共通ロジックなので、
 * 手でコピーせず必ずこのスクリプトを通すこと（二重管理を防ぐため）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...xs) => path.join(root, ...xs);

const jobs = [
  { from: p('shared'), to: p('static', 'js', 'shared'), kind: 'dir', filter: (f) => f.endsWith('.js') },
  { from: p('public', 'style.css'), to: p('static', 'style.css'), kind: 'file' },
  { from: p('node_modules', 'exceljs', 'dist', 'exceljs.min.js'), to: p('static', 'vendor', 'exceljs.min.js'), kind: 'file' },
  {
    from: p('assets', 'nta-templates'),
    to: p('static', 'assets', 'nta-templates'),
    kind: 'dir',
    filter: (f) => f.endsWith('.xlsx'),
  },
];

let copied = 0;

for (const job of jobs) {
  if (!fs.existsSync(job.from)) {
    console.error(`  見つかりません: ${path.relative(root, job.from)}`);
    process.exitCode = 1;
    continue;
  }
  if (job.kind === 'dir') {
    fs.mkdirSync(job.to, { recursive: true });
    for (const f of fs.readdirSync(job.from)) {
      if (job.filter && !job.filter(f)) continue;
      fs.copyFileSync(path.join(job.from, f), path.join(job.to, f));
      console.log(`  ${path.relative(root, path.join(job.to, f))}`);
      copied++;
    }
  } else {
    fs.mkdirSync(path.dirname(job.to), { recursive: true });
    fs.copyFileSync(job.from, job.to);
    console.log(`  ${path.relative(root, job.to)}`);
    copied++;
  }
}

// 価格データが無いと静的サイトは円換算できないので警告する
const prices = p('static', 'data', 'prices.json');
if (!fs.existsSync(prices)) {
  console.error('\n  警告: static/data/prices.json がありません。`npm run build:prices` を実行してください。');
  process.exitCode = 1;
} else {
  const age = Math.floor((Date.now() - JSON.parse(fs.readFileSync(prices)).generated_ms || 0) / 86400000);
  const gen = JSON.parse(fs.readFileSync(prices)).generated?.slice(0, 10);
  console.log(`\n  価格データ: ${gen} 生成`);
}

console.log(`\n  ${copied} ファイルを static/ に配置しました。`);
