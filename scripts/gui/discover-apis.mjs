#!/usr/bin/env node
/**
 * API 发现工具 - GUI 模式
 *
 * 连接到浏览器，导航到目标页面，自动捕获所有网络请求中的 API 端点。
 *
 * 用法:
 *   node scripts/gui/discover-apis.mjs --url https://example.com --port 9222
 *   node scripts/gui/discover-apis.mjs --url https://example.com --filter api/
 */

import { CDPClient, findPageWs } from './cdp-client.mjs';

const args = process.argv.slice(2);
const targetUrl = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'https://example.com';
const cdpPort = args.includes('--port') ? args[args.indexOf('--port') + 1] : '9222';
const urlFilter = args.includes('--filter') ? args[args.indexOf('--filter') + 1] : 'api/';

async function main() {
  // 1. 连接浏览器
  const wsUrl = await findPageWs(`http://127.0.0.1:${cdpPort}`, targetUrl);
  if (!wsUrl) {
    console.error(`No page found on port ${cdpPort}`);
    process.exit(1);
  }
  const cdp = new CDPClient(wsUrl);

  // 2. 启用网络捕获
  await cdp.send('Network.enable');

  // 3. 收集 API 请求
  const apis = new Map();
  cdp._ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Network.requestWillBeSent') {
        const url = msg.params?.request?.url || '';
        if (url.includes(urlFilter)) {
          const key = url.split('?')[0];
          if (!apis.has(key)) {
            apis.set(key, {
              method: msg.params.request.method,
              url: key,
              headers: msg.params.request.headers,
              postData: msg.params.request.postData,
            });
          }
        }
      }
    } catch(e) {}
  });

  // 4. 导航到目标页面
  console.log(`Navigating to ${targetUrl}...`);
  await cdp.send('Page.navigate', { url: targetUrl });
  await CDPClient.sleep(5000);

  // 5. 输出结果
  console.log(`\nFound ${apis.size} API endpoints:`);
  for (const [url, info] of apis) {
    console.log(`  ${info.method} ${url}`);
    if (info.postData) {
      console.log(`    POST body: ${info.postData.substring(0, 200)}`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
