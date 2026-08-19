/* Pages Function：前端 → Worker 的安全代理 */
/* 环境变量在 Pages Dashboard 设置：TTS_WORKER_URL 和 TTS_API_KEY */

export async function onRequestPost({ request, env }) {
  try {
    // 读取前端的请求体
    const body = await request.json();

    // 转发给真实 Worker，注入密钥（前端完全看不到）
    const workerUrl = env.TTS_WORKER_URL + '/v1/audio/speech';
    const workerResp = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Game-Key': env.TTS_API_KEY
      },
      body: JSON.stringify(body)
    });

    // 透传 Worker 的响应
    const audioBlob = await workerResp.blob();
    return new Response(audioBlob, {
      status: workerResp.status,
      headers: {
        'Content-Type': workerResp.headers.get('Content-Type') || 'audio/mpeg'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}