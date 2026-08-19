/* ============================================================
 * Edge TTS Worker — 带密钥校验 + 防滥用
 * 环境变量 API_KEY = 你的密钥（在 Dashboard 设置，别写代码里）
 * ============================================================ */

const T = '6A5A1F447F67D9F3F0F790F1F5F5F5F5F5F5F5F5'; // Edge TTS 公开 token
const GECV = '1-130.0.2124.0';
const MAX_LEN = 500;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Game-Key',
};

export default {
  async fetch(request, env) {
    // 1. CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // 2. 密钥校验（所有请求都要验）
    if (!env.API_KEY) return jerr('Worker 未配置 API_KEY', 500);
    if (request.headers.get('X-Game-Key') !== env.API_KEY) return jerr('Forbidden', 403);

    // 3. 路由
    const u = new URL(request.url);
    if (u.pathname === '/v1/audio/speech' && request.method === 'POST') {
      return handleTTS(request);
    }

    // 4. 其他请求一律 404，不暴露任何信息
    return jerr('Not Found', 404);
  }
};

function jerr(msg, status) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

/* ====================== TTS 处理 ====================== */
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

/* ====================== Edge TTS 合成 ====================== */
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
  return t.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;' }[c]));
}

/* Sec-MS-GEC 签名（微软防滥用校验） */
async function genGEC() {
  const ticks  = Math.floor(Date.now() / 1000) * 1e7 + 116444736000000000;
  const hr     = 3600 * 1e7;
  const_rounded = ticks - (ticks % hr);
  const str    = `${const_rounded}_${GECV}`;
  const data   = new TextEncoder().encode(str);
  const hash   = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function synth(text, voice, rate, pitch) {
  const gec = await genGEC();
  const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${T}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${GECV}`;

  // Cloudflare Workers WebSocket：fetch + Upgrade header
  const wsResp = await fetch(wsUrl, {
    headers: {
      'Upgrade': 'websocket',
      'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
    }
  });
  const ws = wsResp.webSocket;
  ws.accept();

  const reqId = crypto.randomUUID();
  const ts    = new Date().toISOString();

  /* ① 发送配置（指定音频格式） */
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

  /* ② 发送 SSML（朗读内容） */
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}'>${escXml(text)}</prosody>` +
    `</voice></speak>`;

  ws.send(
    `X-RequestId:${reqId}\r\n` +
    `X-Timestamp:${ts}\r\n` +
    `Path:ssml\r\n` +
    `Content-Type:application/ssml+xml;charset=utf-8\r\n\r\n${ssml}`
  );

  /* ③ 接收音频分片，拼接 */
  return await new Promise((resolve) => {
    const chunks = [];

    const timer = setTimeout(() => {
      try { ws.close(); } catch(_) {}
      resolve(null);
    }, 15000);

    ws.addEventListener('message', (event) => {
      // 二进制帧 = 音频数据
      if (event.data instanceof ArrayBuffer) {
        const d = new Uint8Array(event.data);
        if (d.length < 2) return;
        const hlen = (d[0] << 8) | d[1];          // 前2字节=头长度
        const audio = d.slice(2 + hlen);          // 剩余=纯音频
        if (audio.length > 0) chunks.push(audio);
      }
      // 文本帧 = 元数据，检测 turn.end 表示合成结束
      else if (typeof event.data === 'string' && event.data.includes('Path:turn.end')) {
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