/* Cloudflare Pages Function: menyajikan potongan lampiran PDF di https://jejakpajak.pages.dev/lampiran/<id>/<file>.pdf
   dari bucket Cloudflare R2 (binding LAMPIRAN -> jejak-pajak-lampiran). File diunggah oleh TERBITKAN-LAMPIRAN.bat.
   ?v=<sidik> = isi file tertentu (boleh disimpan lama di browser); ?unduh = minta browser menyimpan file. */
const POLA = /^[a-z]+-\d+[a-z]?-\d{4}\/[A-Za-z0-9-]+\.pdf$/;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-None-Match',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
};

function jawab(teks, status, tambahan) {
  return new Response(teks, { status, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', ...(tambahan || {}) } });
}

export async function onRequest({ request, env, params }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
  if (request.method !== 'GET' && request.method !== 'HEAD') return jawab('Metode tidak didukung', 405, { Allow: 'GET, HEAD, OPTIONS' });
  const jalur = [].concat(params.jalur || []).join('/');
  if (!POLA.test(jalur)) return jawab('Tidak ditemukan', 404);
  if (!env.LAMPIRAN) return jawab('Penyimpanan lampiran belum terhubung (binding LAMPIRAN)', 503);

  const url = new URL(request.url);
  const nama = jalur.split('/').pop();
  const kepala = new Headers(CORS);
  kepala.set('Content-Type', 'application/pdf');
  kepala.set('Accept-Ranges', 'bytes');
  kepala.set('Cache-Control', url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
  kepala.set('Content-Disposition', (url.searchParams.has('unduh') ? 'attachment' : 'inline') + '; filename="' + nama + '"');
  kepala.set('X-Content-Type-Options', 'nosniff');

  if (request.method === 'HEAD') {
    const o = await env.LAMPIRAN.head(jalur);
    if (!o) return jawab('Lampiran tidak ditemukan', 404);
    kepala.set('ETag', o.httpEtag);
    kepala.set('Content-Length', String(o.size));
    return new Response(null, { status: 200, headers: kepala });
  }

  let o;
  try {
    o = await env.LAMPIRAN.get(jalur, { range: request.headers, onlyIf: request.headers });
  } catch (e) {
    return jawab('Rentang tidak valid', 416, { 'Content-Range': 'bytes */*' });
  }
  if (!o) return jawab('Lampiran tidak ditemukan', 404);
  kepala.set('ETag', o.httpEtag);
  if (!('body' in o) || !o.body) {
    // syarat If-None-Match terpenuhi: browser sudah punya salinan yang sama
    return new Response(null, { status: request.headers.has('If-None-Match') ? 304 : 412, headers: kepala });
  }
  const r = o.range;
  const pakaiRentang = request.headers.has('Range') && r && (r.offset !== undefined || r.suffix !== undefined);
  if (pakaiRentang) {
    const mulai = r.suffix !== undefined ? Math.max(0, o.size - r.suffix) : r.offset;
    const panjang = r.suffix !== undefined ? o.size - mulai : (r.length !== undefined ? r.length : o.size - mulai);
    kepala.set('Content-Range', 'bytes ' + mulai + '-' + (mulai + panjang - 1) + '/' + o.size);
    kepala.set('Content-Length', String(panjang));
    return new Response(o.body, { status: 206, headers: kepala });
  }
  kepala.set('Content-Length', String(o.size));
  return new Response(o.body, { status: 200, headers: kepala });
}
