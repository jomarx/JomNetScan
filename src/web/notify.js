'use strict';

// Outbound alerts: Telegram, ntfy, or a plain JSON webhook.
//
// All three are a single HTTPS POST, so none of them needs a library. They are
// independent - configure both Telegram and a webhook and both fire.
//
// Nothing here is allowed to break a scan. Every failure is caught, logged and
// dropped; there is no retry, because the interesting alert is "a device just
// appeared" and a message that arrives ten minutes late is noise.

const https = require('https');
const http = require('http');
const { URL } = require('url');

const TIMEOUT_MS = 5000;

// The mask the UI sees in place of a stored secret. Also the test for "the
// browser sent the mask back rather than a new value" - see isMasked.
const MASK_CHAR = '•';

/** Fields that must never be sent to a browser in full. */
const SECRET_SETTINGS = ['telegramToken', 'webhookUrl'];

/**
 * Show enough of a secret to recognise it, never enough to use it. A short
 * value is replaced outright rather than half-revealed.
 */
function maskSecret(value) {
  if (!value) return '';
  const text = String(value);
  if (text.length <= 8) return MASK_CHAR.repeat(8);
  return MASK_CHAR.repeat(8) + text.slice(-4);
}

/**
 * Did this come back from a browser unchanged? The UI renders the mask in the
 * input, so an untouched field can be submitted verbatim by any change event
 * on the form. Writing that through would quietly destroy the real token.
 */
function isMasked(value) {
  return typeof value === 'string' && value.startsWith(MASK_CHAR);
}

/** A copy of settings safe to hand to a browser. */
function redactSettings(settings) {
  const out = { ...settings };
  for (const key of SECRET_SETTINGS) {
    if (out[key]) out[key] = maskSecret(out[key]);
  }
  return out;
}

/** Strip masked secrets out of an incoming patch so they can't overwrite the real ones. */
function stripMaskedSecrets(patch) {
  const out = { ...patch };
  for (const key of SECRET_SETTINGS) {
    if (key in out && isMasked(out[key])) delete out[key];
  }
  return out;
}

/** POST a body, resolving to { ok, status, body }. Never rejects. */
function post(urlString, { headers = {}, body = '' }) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlString);
    } catch {
      resolve({ ok: false, error: 'That is not a valid URL' });
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      resolve({ ok: false, error: `Unsupported protocol ${url.protocol}` });
      return;
    }

    const payload = Buffer.from(body, 'utf8');
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'POST',
      headers: { 'Content-Length': payload.length, ...headers },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (text.length < 2000) text += chunk; });
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        body: text,
        error: res.statusCode >= 300 ? `HTTP ${res.statusCode}` : null,
      }));
    });

    // Three ways this can end badly, and all of them have to settle the
    // promise - a notifier that hangs would hold up the scan that triggered it.
    req.on('timeout', () => { req.destroy(new Error(`No response within ${TIMEOUT_MS}ms`)); });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end(payload);
  });
}

function sendTelegram(settings, { title, message }) {
  const token = settings.telegramToken;
  const chatId = settings.telegramChatId;
  if (!token || !chatId) return null;
  return post(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: `${title}\n${message}`, disable_notification: false }),
  }).then((r) => ({ channel: 'telegram', ...r }));
}

function sendWebhook(settings, { title, message, devices }) {
  const url = settings.webhookUrl;
  if (!url) return null;

  if (settings.webhookFormat === 'ntfy') {
    // ntfy takes the message as the raw body and everything else as headers.
    return post(url, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: title },
      body: message,
    }).then((r) => ({ channel: 'ntfy', ...r }));
  }

  return post(url, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, message, devices }),
  }).then((r) => ({ channel: 'webhook', ...r }));
}

/** The same wording the desktop build puts in its notification. */
function describe(devices) {
  const names = devices.map((d) => d.name || d.discoveredName || d.hostname || d.vendor || d.ip);
  const shown = names.slice(0, 3).join(', ');
  return {
    title: devices.length === 1 ? 'New device on your network' : `${devices.length} new devices`,
    message: `${shown}${devices.length > 3 ? ', and others' : ''}`,
  };
}

/**
 * Fire every configured channel for one scan's worth of new devices.
 * Resolves once they've all settled; the caller does not await it.
 */
async function notifyNewDevices(settings, devices, log) {
  if (!devices.length || !settings.notifyOnNew) return [];
  const summary = {
    ...describe(devices),
    devices: devices.map((d) => ({
      ip: d.ip, mac: d.mac, vendor: d.vendor, hostname: d.hostname,
    })),
  };

  const sends = [sendTelegram(settings, summary), sendWebhook(settings, summary)].filter(Boolean);
  const results = await Promise.all(sends);
  for (const result of results) {
    if (!result.ok) log(`Alert via ${result.channel} failed: ${result.error}`);
  }
  return results;
}

/** One message to every configured channel, for the Send test message button. */
async function sendTest(settings) {
  const summary = {
    title: 'JomNetScan test',
    message: 'If you are reading this, alerts are working.',
    devices: [],
  };
  const sends = [sendTelegram(settings, summary), sendWebhook(settings, summary)].filter(Boolean);
  if (!sends.length) return { ok: false, error: 'No alert channel is configured' };

  const results = await Promise.all(sends);
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    results: results.map((r) => ({ channel: r.channel, ok: r.ok, error: r.error || null })),
    error: failed.length ? failed.map((r) => `${r.channel}: ${r.error}`).join('; ') : null,
  };
}

module.exports = {
  notifyNewDevices,
  sendTest,
  redactSettings,
  stripMaskedSecrets,
  maskSecret,
  SECRET_SETTINGS,
};
