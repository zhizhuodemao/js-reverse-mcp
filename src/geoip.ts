/**
 * @license
 * Copyright 2026
 * SPDX-License-Identifier: Apache-2.0
 */

import {ProxyAgent} from 'undici';

/**
 * GeoIP lookup helpers.
 * TypeScript port of geoip.py — resolves timezone and locale from a proxy's
 * exit IP using the free ip-api.com JSON endpoint (no API key, no local DB).
 *
 * Falls back gracefully: if the lookup fails the caller gets undefined values
 * and can proceed with default locale/timezone.
 */

const IP_ECHO_URLS = [
  'https://api.ipify.org',
  'https://checkip.amazonaws.com',
  'https://ifconfig.me/ip',
];

const COUNTRY_LOCALE_MAP: Record<string, string> = {
  US: 'en-US',
  GB: 'en-GB',
  AU: 'en-AU',
  CA: 'en-CA',
  NZ: 'en-NZ',
  DE: 'de-DE',
  FR: 'fr-FR',
  ES: 'es-ES',
  MX: 'es-MX',
  BR: 'pt-BR',
  IT: 'it-IT',
  NL: 'nl-NL',
  JP: 'ja-JP',
  KR: 'ko-KR',
  CN: 'zh-CN',
  TW: 'zh-TW',
  HK: 'zh-HK',
  RU: 'ru-RU',
  PL: 'pl-PL',
  TR: 'tr-TR',
  IN: 'hi-IN',
  ID: 'id-ID',
  PH: 'en-PH',
  TH: 'th-TH',
  VN: 'vi-VN',
};

export interface GeoResult {
  timezone?: string;
  locale?: string;
  ip?: string;
  country?: string;
}

/**
 * Resolve the exit IP of a proxy URL by calling free IP-echo services
 * through the proxy. Returns undefined if all attempts fail.
 *
 * Note: Node's global fetch does not honor HTTPS_PROXY/HTTP_PROXY by default,
 * so proxy lookups must pass an undici dispatcher explicitly.
 */
async function resolveExitIp(
  timeoutMs = 5000,
  dispatcher?: ProxyAgent,
): Promise<string | undefined> {
  for (const url of IP_ECHO_URLS) {
    try {
      const ip = (await fetchText(url, timeoutMs, dispatcher)).trim();
      if (/^[\d.]+$|^[0-9a-f:]+$/i.test(ip)) return ip;
    } catch {
      // try next
    }
  }
  return undefined;
}

type FetchOptions = RequestInit & {dispatcher?: ProxyAgent};

async function fetchText(
  url: string,
  timeoutMs: number,
  dispatcher?: ProxyAgent,
): Promise<string> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      ...(dispatcher ? {dispatcher} : {}),
    } as FetchOptions);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Look up timezone and locale for an IP address using ip-api.com.
 * Optionally routes through proxy so strict-proxy environments don't block.
 */
async function lookupIp(
  ip: string,
  timeoutMs = 5000,
  dispatcher?: ProxyAgent,
): Promise<GeoResult> {
  try {
    const resText = await fetchText(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode,timezone`,
      timeoutMs,
      dispatcher,
    );
    const data = JSON.parse(resText) as {
      status: string;
      countryCode?: string;
      timezone?: string;
    };
    if (data.status !== 'success') return {ip};
    const locale = data.countryCode
      ? COUNTRY_LOCALE_MAP[data.countryCode]
      : undefined;
    return {ip, country: data.countryCode, timezone: data.timezone, locale};
  } catch {
    return {ip};
  }
}

/**
 * Resolve geo information (timezone, locale) from a proxy URL.
 * Mirrors Python's resolve_proxy_geo_with_ip() but without the local GeoLite2 DB.
 *
 * @param proxyUrl  e.g. "http://user:pass@host:port" or "socks5://host:port"
 * @param timeoutMs timeout in ms for network calls (default 5000)
 */
export async function resolveProxyGeo(
  proxyUrl: string,
  timeoutMs = 5000,
): Promise<GeoResult> {
  // Create one ProxyAgent for the full lookup so both the IP-echo call and the
  // ip-api.com lookup go through the proxy — necessary in strict-proxy envs.
  const dispatcher = new ProxyAgent(proxyUrl);
  try {
    const ip = await resolveExitIp(timeoutMs, dispatcher);
    if (!ip) return {};
    return lookupIp(ip, timeoutMs, dispatcher);
  } finally {
    await dispatcher.close();
  }
}

/**
 * Resolve geo from the current machine's public IP (no proxy).
 * Used when --geoip is set without --proxy (less common, but supported).
 */
export async function resolveLocalGeo(timeoutMs = 5000): Promise<GeoResult> {
  for (const url of IP_ECHO_URLS) {
    try {
      const ip = (await fetchText(url, timeoutMs)).trim();
      if (/^[\d.]+$|^[0-9a-f:]+$/i.test(ip)) return lookupIp(ip, timeoutMs);
    } catch {
      // try next
    }
  }
  return {};
}
