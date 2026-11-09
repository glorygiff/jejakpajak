/* Cloudflare Pages Function: menyajikan data aturan di https://jejakpajak.pages.dev/data/...
   Server Cloudflare yang mengambil file dari repository data di GitHub, jadi browser pengguna
   tidak perlu bisa membuka github.com / raw.githubusercontent.com (banyak kantor memblokirnya). */
const ASAL = 'https://raw.githubusercontent.com/glorygiff/jejak-pajak-data/main/';
const BOLEH = /^(manifest\.json|lengkap\.json\.gz|pembaruan\/\d{1,6}\.json(\.gz)?)$/;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' };

export async function onRequest({ request, params }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Metode tidak didukung', { status: 405, headers: CORS });
  const jalur = [].concat(params.jalur || []).join('/');
  if (!BOLEH.test(jalur)) return new Response('Tidak ditemukan', { status: 404, headers: CORS });

  const manifest = jalur === 'manifest.json';
  const v = new URL(request.url).searchParams.get('v') || '';
  // manifest: cache 60 detik; file pembaruan bernomor tidak pernah berubah; lengkap.json.gz dibedakan dengan ?v=versi
  const ttl = manifest ? 60 : jalur.startsWith('pembaruan/') ? 7 * 86400 : 3600;
  const tanda = manifest ? 't=' + Math.floor(Date.now() / 60000) : v ? 'v=' + encodeURIComponent(v) : '';
  let asal;
  try {
    asal = await fetch(ASAL + jalur + (tanda ? '?' + tanda : ''), { cf: { cacheTtl: ttl, cacheEverything: true } });
  } catch (e) {
    return new Response('Gagal mengambil data dari sumber', { status: 502, headers: CORS });
  }
  if (!asal.ok) return new Response('Sumber data menjawab HTTP ' + asal.status, { status: asal.status === 404 ? 404 : 502, headers: CORS });
  return new Response(request.method === 'HEAD' ? null : asal.body, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': manifest ? 'application/json; charset=utf-8' : /\.gz$/.test(jalur) ? 'application/octet-stream' : 'application/json; charset=utf-8',
      'Cache-Control': manifest ? 'no-cache' : 'public, max-age=' + ttl,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
