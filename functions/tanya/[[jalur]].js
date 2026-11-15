/* Cloudflare Pages Function: meneruskan https://jejakpajak.pages.dev/tanya/... ke Worker "jejak-tanya".
   Dengan begini aplikasi web cukup memanggil alamatnya sendiri (diizinkan Content-Security-Policy 'self'),
   dan alamat workers.dev tidak terlihat di kode halaman. Kuota, API key, dan prompt tetap diurus Worker. */
const WORKER = 'https://jejak-tanya.jjkpjk.workers.dev';   // ganti bila alamat dari "wrangler deploy" berbeda
const ASAL_SITUS = 'https://jejakpajak.pages.dev';         // harus tercantum di ASAL_DIIZINKAN pada wrangler.toml
const BOLEH = { kuota: 'GET', tanya: 'POST', kunci: 'POST' };

export async function onRequest({ request, params, env }) {
  const jalur = [].concat(params.jalur || []).join('/');
  const metode = BOLEH[jalur];
  if (!metode) return new Response('Tidak ditemukan', { status: 404 });
  if (request.method !== metode) return new Response('Metode tidak didukung', { status: 405 });

  const kepala = new Headers({ 'Origin': ASAL_SITUS, 'X-Perangkat': request.headers.get('X-Perangkat') || '' });
  if (metode === 'POST') kepala.set('Content-Type', 'application/json');
  let jawab;
  try {
    jawab = await fetch(`${(env && env.TANYA_WORKER) || WORKER}/${jalur}`, {
      method: metode, headers: kepala, body: metode === 'POST' ? await request.text() : undefined,
    });
  } catch (e) {
    return new Response(JSON.stringify({ kode: 'koneksi', pesan: 'Layanan tanya tidak bisa dihubungi. Coba lagi sebentar lagi.' }),
      { status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  return new Response(jawab.body, {
    status: jawab.status,
    headers: { 'Content-Type': jawab.headers.get('Content-Type') || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
