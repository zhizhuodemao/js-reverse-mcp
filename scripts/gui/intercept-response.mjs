#!/usr/bin/env node
/**
 * 网络响应拦截工具 - GUI 模式
 *
 * 拦截页面 API 请求的响应，实时修改后返回给页面。
 * 可用于绕过服务端地域/身份检测，或模拟不同响应场景。
 *
 * 用法:
 *   node scripts/gui/intercept-response.mjs --url https://example.com --port 9222 --pattern *target-api* --transform 'data.userProvince="湖北"'
 */

import { CDPClient, findPageWs } from './cdp-client.mjs';

const args = process.argv.slice(2);
const targetUrl = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'https://example.com';
const cdpPort = args.includes('--port') ? args[args.indexOf('--port') + 1] : '9222';
const urlPattern = args.includes('--pattern') ? args[args.indexOf('--pattern') + 1] : '*';
const transformExpr = args.includes('--transform') ? args[args.indexOf('--transform') + 1] : '';

async function main() {
  const wsUrl = await findPageWs(`http://127.0.0.1:${cdpPort}`, targetUrl);
  if (!wsUrl) { console.error(`No page found`); process.exit(1); }
  const cdp = new CDPClient(wsUrl);

  // 启用请求拦截
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern, requestStage: 'Response' }]
  });

  let interceptedCount = 0;

  cdp._ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Fetch.requestPaused') {
        const reqId = msg.params.requestId;
        const url = msg.params.request?.url || '';

        if (transformExpr) {
          // 获取原始响应体
          const bodyResp = await cdp.send('Fetch.getResponseBody', { requestId: reqId });
          let responseBody = bodyResp?.result?.body || '{}';

          try {
            const parsed = JSON.parse(responseBody);
            // 应用变换（简化版：通过 Function 执行用户定义的变换表达式）
            const transform = new Function('data', `try { ${transformExpr}; return data; } catch(e) { return data; }`);
            const modified = transform(parsed);
            responseBody = JSON.stringify(modified);
            interceptedCount++;
            console.log(`  Intercepted: ${url.substring(0, 80)}`);
          } catch(e) {}

          await cdp.send('Fetch.fulfillRequest', {
            requestId: reqId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
            body: Buffer.from(responseBody).toString('base64')
          });
        } else {
          await cdp.send('Fetch.continueRequest', { requestId: reqId });
        }
      }
    } catch(e) {}
  });

  // 导航到页面
  console.log(`Navigating to ${targetUrl}...`);
  await cdp.send('Page.navigate', { url: targetUrl });
  await CDPClient.sleep(10000);

  console.log(`\nIntercepted ${interceptedCount} requests`);
  if (!transformExpr) {
    console.log('Tip: Use --transform to modify responses');
    console.log('  node scripts/gui/intercept-response.mjs --url URL --pattern *api* --transform \'data.userProvince="湖北"\'');
  }

  process.exit(0);
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
