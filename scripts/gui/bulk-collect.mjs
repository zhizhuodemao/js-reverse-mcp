#!/usr/bin/env node
/**
 * 批量数据采集工具 - GUI 模式
 *
 * 从分页 API 批量采集数据，支持自动翻页和断点续采。
 *
 * 用法:
 *   node scripts/gui/bulk-collect.mjs --url "https://api.example.com/list?page=" --port 9222 --pages 10
 *   node scripts/gui/bulk-collect.mjs --url "https://api.example.com/list" --port 9222 --pages all
 */

import { CDPClient, findPageWs } from './cdp-client.mjs';
import fs from 'fs';

const args = process.argv.slice(2);
const targetUrl = args.includes('--url') ? args[args.indexOf('--url') + 1] : '';
const cdpPort = args.includes('--port') ? args[args.indexOf('--port') + 1] : '9222';
const pageParam = args.includes('--pages') ? args[args.indexOf('--pages') + 1] : '5';
const outputFile = args.includes('--output') ? args[args.indexOf('--output') + 1] : 'collected_data.json';
const delay = parseInt(args.includes('--delay') ? args[args.indexOf('--delay') + 1] : '500');

async function main() {
  if (!targetUrl) { console.error('Usage: --url <url>'); process.exit(1); }

  const wsUrl = await findPageWs(`http://127.0.0.1:${cdpPort}`, targetUrl);
  if (!wsUrl) { console.error('No page found'); process.exit(1); }
  const cdp = new CDPClient(wsUrl);
  await cdp.send('Network.enable');

  // 收集响应
  const responses = [];
  const pendingResponses = new Map();

  cdp._ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Network.responseReceived') {
        const url = msg.params?.response?.url || '';
        if (url.includes(targetUrl.split('?')[0])) {
          const reqId = msg.params.requestId;
          setTimeout(async () => {
            try {
              const body = await cdp.send('Network.getResponseBody', { requestId: reqId });
              if (body?.result?.body) {
                try {
                  responses.push(JSON.parse(body.result.body));
                } catch(e) {
                  responses.push({ raw: body.result.body.substring(0, 500) });
                }
              }
            } catch(e) {}
          }, delay);
        }
      }
    } catch(e) {}
  });

  // 计算页数
  const pages = pageParam === 'all' ? 100 : parseInt(pageParam);
  const hasPagePlaceholder = targetUrl.includes('page=');

  for (let p = 1; p <= pages; p++) {
    const url = hasPagePlaceholder ? targetUrl.replace(/page=\d+/, `page=${p}`) : `${targetUrl}${p}`;
    console.log(`Page ${p}/${pages}...`);
    await cdp.send('Page.navigate', { url });
    await CDPClient.sleep(delay * 2);
  }

  // 保存结果
  fs.writeFileSync(outputFile, JSON.stringify(responses, null, 2));
  console.log(`\nDone! ${responses.length} responses saved to ${outputFile}`);
  process.exit(0);
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
