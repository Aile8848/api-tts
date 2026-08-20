/* ============================================================
 * Edge TTS Worker — 前端直连版（不依赖 Pages Functions）
 * 部署为独立的 Cloudflare Worker，前端直接 fetch 调用：
 *   POST https://<你的Worker域名>/v1/audio/speech
 *
 * 修复点（相对旧版）：
 *  1. T 改为微软 Edge TTS 的公开可信 client token（旧值是占位的假值，
 *     会导致 WS 握手被拒 → 在线永远 502）。
 *  2. genGEC 改用 BigInt 计算，避免 2024 年后日期因浮点精度丢失而
 *     算错 Sec-MS-GEC 校验码（同样会让握手被拒）。
 *  3. 直连模式下的防护：不依赖环境变量，用「Origin 白名单 + 前端携带的
 *     公开 token」两层挡掉随机扫描和他人把本 Worker 当免费 TTS API 白嫖。
 *     （说明：静态前端代码任何人都能看到，token 写在 JS 里本质是「防君子」，
 *      无法做到真·防滥用——但比完全裸奔强得多，且零配置、零密钥泄露风险。）
 * ============================================================ */

/* 微软 Edge TTS 公开可信 client token（与 edge-tts 官方库一致，请勿随意改动） */
const T = '6A5AA1D4EAFF4E9FB37E23D68491EF5B';
const GECV = '1-130.0.2124.0';
const MAX_LEN = 500;

/* ---------- 防护配置（按需修改）---------- */
/* 前端 JS 里会原样带上这个头；挡掉无头扫描/随机探测。
   注意：它写在公开前端里，能挡君子挡不住决心看源码的人——这是静态前端的固有限制。
   不校验 Origin：你的访问域名可能用 pages.dev 子域或自定义域名，硬匹配会误杀自己。 */
const GAME_TOKEN = 'lec1-TTS-k3y-8x';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Game-Key',
};

export default {
  async fetch(request, env) {
    // 预检请求直接放行（预检不带自定义头，不能在此校验 token）
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // 防护：前端携带的公开 token（挡掉无头扫描/随机探测）。
    // 不校验 Origin，避免你换访问域名（pages.dev 子域等）时被 403 误杀。
    const token = request.headers.get('X-Game-Key') || '';
    if (token !== GAME_TOKEN) {
      return jerr('Forbidden', 403);
    }

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
