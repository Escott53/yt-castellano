/**
 * Cloudflare Worker opcional — subtítulos vía Innertube ANDROID.
 * Deploy: wrangler deploy (cuenta Cloudflare).
 * Luego pega la URL …workers.dev en Ajustes → Proxy de subtítulos.
 */
export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const videoId = url.searchParams.get('v') || '';
    const lang = url.searchParams.get('lang') || 'es';
    if (!/^[\w-]{11}$/.test(videoId)) {
      return json({ error: 'videoId inválido' }, 400, cors);
    }

    try {
      const player = await innertubePlayer(videoId);
      const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      if (!tracks.length) return json({ error: 'sin pistas', segments: [] }, 404, cors);

      let track = tracks.find((t) => t.languageCode === lang)
        || tracks.find((t) => (t.languageCode || '').startsWith(lang))
        || tracks.find((t) => t.languageCode === 'en' && t.kind === 'asr')
        || tracks.find((t) => t.languageCode === 'en')
        || tracks[0];

      const body = await fetch(track.baseUrl + '&fmt=srv3', {
        headers: { 'User-Agent': 'com.google.android.youtube/20.10.38' },
      }).then((r) => r.text());

      const segments = parseSrv3(body);
      const title = player?.videoDetails?.title || videoId;
      return json({
        ok: true,
        videoId,
        title,
        lang: track.languageCode,
        segments,
      }, 200, cors);
    } catch (e) {
      return json({ error: String(e?.message || e), segments: [] }, 502, cors);
    }
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}

async function innertubePlayer(videoId) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'com.google.android.youtube/20.10.38',
    },
    body: JSON.stringify({
      context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
      videoId,
    }),
  });
  if (!res.ok) throw new Error('innertube ' + res.status);
  return res.json();
}

function parseSrv3(xml) {
  const segs = [];
  const re = /<p t="(\d+)" d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(xml))) {
    let text = m[3].replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ').trim();
    if (!text) continue;
    segs.push({ start: Number(m[1]) / 1000, dur: Number(m[2]) / 1000, text });
  }
  return segs;
}
