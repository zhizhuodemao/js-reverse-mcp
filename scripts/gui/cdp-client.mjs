/**
 * CDP Client - 浏览器 DevTools Protocol 连接层
 *
 * GUI/CLI 共享模块。MCP Server 内部和 GUI 脚本均使用此模块连接和操作浏览器。
 *
 * 用法:
 *   import { CDPClient } from './cdp-client.mjs';
 *   const client = new CDPClient('ws://127.0.0.1:9222/...');
 *   await client.send('Page.navigate', { url: 'https://example.com' });
 *   const title = await client.eval('document.title');
 */

import WebSocket from 'ws';

export class CDPClient {
  constructor(wsUrl) {
    this._id = 1;
    this._pending = new Map();
    this._ws = new WebSocket(wsUrl);
    return new Promise((resolve, reject) => {
      this._ws.on('open', () => resolve(this));
      this._ws.on('error', reject);
      this._ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          const resolve = this._pending.get(msg.id);
          if (resolve) { this._pending.delete(msg.id); resolve(msg); }
        } catch(e) {}
      });
    });
  }

  /** 调用 CDP 方法 */
  async send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this._id++;
      const timer = setTimeout(() => { this._pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 30000);
      this._pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this._ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 在页面执行 JS */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    return r?.result?.result?.value;
  }

  /** 模拟鼠标点击 */
  async clickAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  /** 按 CSS 选择器点击 */
  async clickEl(selector) {
    const coords = await this.eval(`JSON.stringify((()=>{
      const el = document.querySelector('${selector}');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })())`);
    if (!coords) throw new Error(`Element not found: ${selector}`);
    const { x, y } = JSON.parse(coords);
    await this.clickAt(x, y);
  }

  /** 按文本内容点击 */
  async clickByText(text) {
    const coords = await this.eval(`JSON.stringify((()=>{
      const all = document.querySelectorAll('*');
      for (const el of all) {
        if (el.textContent.trim() === '${text}' && el.offsetParent !== null) {
          const rect = el.getBoundingClientRect();
          return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        }
      }
      return null;
    })())`);
    if (!coords) throw new Error(`Text not found: ${text}`);
    const { x, y } = JSON.parse(coords);
    await this.clickAt(x, y);
  }

  /** 等待指定毫秒 */
  static sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

/** 从 CDP HTTP 端点获取页面 WebSocket URL */
export async function findPageWs(httpEndpoint, urlFilter) {
  const resp = await fetch(`${httpEndpoint}/json`);
  const pages = await resp.json();
  const target = pages.find(p => p.url && (!urlFilter || p.url.includes(urlFilter)));
  return target?.webSocketDebuggerUrl;
}

/** 从 CDP HTTP 端点获取所有页面 */
export async function listPages(httpEndpoint) {
  const resp = await fetch(`${httpEndpoint}/json`);
  return resp.json();
}
