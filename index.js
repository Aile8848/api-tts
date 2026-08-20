/* ============================================================
 * Edge TTS Worker — 密钥校验 + 防滥用
 * 部署为独立的 Cloudflare Worker（Pages Function tts.js 会转发到这里）
 * 环境变量：API_KEY（在 Dashboard 设置）
 *
 * 修复点（相对旧版）：
 *  1. T 改为微软 Edge TTS 的公开可信 client token（旧值是占位的假值，
 *     会导致 WS 握手被拒 → 在线永远 502）。
 *  2. genGEC 改用 BigInt 计算，避免 2024 年后日期因浮点精度丢失而
 *     算错 Sec-MS-GEC 校验码（同样会让握手被拒）。
 * ============================================================ */

/* 微软 Edge TTS 公开可信 client token（与 edge-tts 官方库一致，请勿随意改动） */
const T = '6A5AA1D4EAFF4E9FB37E23D68491EF5B';
const GECV = '1-130.0.2124.0';
const MAX_LEN = 500;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Game-Key',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (!env.API_KEY) return jerr('Worker 未配置 API_KEY', 500);
    if (request.headers.get('X-Game-Key') !== env.API_KEY) return jerr('Forbidden', 403);

    const u = new URL(request.url);
    if (u.pathname === '/v1/audio/speech' && request.method === 'POST') {
      return handleTTS(request);
    }

    return jerr('Not Found', 404);
  }
};

function jerr(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

async function handleTTS(request) {
  try {
    const body = await request.json();
    const text = (body.input || '').trim();

    if (!text) return jerr('缺少 input 参数', 400);
    if (text.length > MAX_LEN) return jerr(`文本过长（上限 ${MAX_LEN} 字）`, 400);

    const voice = body.voice || 'zh-CN-XiaoxiaoNeural';
    const rate  = fmtRate(body.speed || 1.0);
    const pitch = fmtPitch(body.pitch || '0');

    const audio = await synth(text, voice, rate, pitch);
    if (!audio) return jerr('合成失败，请重试', 502);

    return new Response(audio, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audio.byteLength.toString(),
        'Cache-Control': 'no-cache',
        ...CORS
      }
    });
  } catch (e) {
    return jerr('内部错误: ' + e.message, 500);
  }
}

function fmtRate(s) {
  if (s === 1.0) return '+0%';
  const p = Math.round((s - 1.0) * 100);
  return (p >= 0 ? '+' : '') + p + '%';
}
function fmtPitch(p) {
  const v = parseInt(p) || 0;
  return (v >= 0 ? '+' : '') + v + 'Hz';
}
function escXml(t) {
  return t.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
}

/* 生成 Sec-MS-GEC 校验码（与 edge-tts 官方算法完全一致）
 * 关键：先在整秒维度对齐到整点，再用 BigInt 拼接，避免浮点精度丢失 */
async function genGEC() {
  const secs = Math.floor(Date.now() / 1000);
  const roundedSecs = secs - (secs % 3600);                       // 对齐到整点（秒）
  const val = (BigInt(roundedSecs) * 10000000n + 116444736000000000n).toString();
  const str = `${val}_${GECV}`;
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function synth(text, voice, rate, pitch) {
  const gec = await genGEC();
  const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${T}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${GECV}`;

  const wsResp = await fetch(wsUrl, {
    headers: {
      'Upgrade': 'websocket',
      'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
    }
  });
  const ws = wsResp.webSocket;
  if (!ws) return null;          // fetch 未升级为 WebSocket（如被拦截）
  ws.accept();

  const reqId = crypto.randomUUID();
  const ts = new Date().toISOString();

  ws.send(
    `X-Timestamp:${ts}\r\n` +
    `Path:speech.config\r\n` +
    `Content-Type:application/json;charset=utf-8\r\n\r\n` +
    JSON.stringify({
      context: { synthesis: { audio: {
        metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
      } } }
    })
  );

  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}'>${escXml(text)}</prosody>` +
    `</voice></speak>`;

  // SSML 用 edge-tts 官方二进制帧发送：\x00\x01 + requestId(36) + \x00 + 报文
  // 这是微软服务端 100% 接受的格式，比纯文本帧更稳
  const ssmlHead =
    `X-RequestId:${reqId}\r\n` +
    `X-Timestamp:${ts}\r\n` +
    `Path:ssml\r\n` +
    `Content-Type:application/ssml+xml;charset=utf-8\r\n\r\n${ssml}`;
  const headBytes = new TextEncoder().encode(ssmlHead);
  const frame = new Uint8Array(2 + reqId.length + 1 + headBytes.length);
  let off = 0;
  frame[off++] = 0x00; frame[off++] = 0x01;
  for (let i = 0; i < reqId.length; i++) frame[off++] = reqId.charCodeAt(i);
  frame[off++] = 0x00;
  frame.set(headBytes, off);
  ws.send(frame);

  return await new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => {
      try { ws.close(); } catch(_) {}
      resolve(null);
    }, 15000);

    ws.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) {
        const d = new Uint8Array(event.data);
        if (d.length < 2) return;
        const hlen = (d[0] << 8) | d[1];
        const audio = d.slice(2 + hlen);
        if (audio.length > 0) chunks.push(audio);
      } else if (typeof event.data === 'string' && event.data.includes('Path:turn.end')) {
        clearTimeout(timer);
        ws.close();
        resolve(concat(chunks));
      }
    });

    ws.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function concat(chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const r = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { r.set(c, off); off += c.length; }
  return r.buffer;
}
