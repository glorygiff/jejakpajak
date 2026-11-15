/* Jejak Pajak — tab "Tanya AI" (versi web).
 *
 * Dimuat SETELAH skrip utama index.html dan memakai fungsi/data milik skrip itu (ALL, BYID, NASKAH, cite, mdLite, …).
 * Cukup satu baris sebelum </body>:   <script src="tanya.js"></script>
 * Permintaan dikirim ke /tanya/... di situs sendiri (Pages Function functions/tanya/[[jalur]].js), yang meneruskannya
 * ke Worker "jejak-tanya". Alamat lain bisa dipaksa dengan window.JEJAK_TANYA.
 *
 * Alur: cari potongan pasal yang relevan di data aplikasi sendiri (maks. 6) → kirim pertanyaan + potongan ke perantara
 * → perantara memotong kuota, menyusun prompt, dan memanggil DeepSeek → jawaban dialirkan ke sini beserta rujukannya.
 * API key DeepSeek tidak ada di aplikasi.
 */
(function () {
  'use strict';
  const ALAMAT = String(window.JEJAK_TANYA || 'tanya').trim().replace(/\/+$/, '');
  if (!ALAMAT || typeof ALL === 'undefined' || typeof NASKAH === 'undefined') return;
  if (typeof ANDROID !== 'undefined' && ANDROID) return;   // versi APK menyusul; jangan aktif di WebView APK dulu

  /* ---------- Batas (harus sama atau lebih kecil dari batas di Worker) ---------- */
  const AMBANG = 0.5, MAKS_TANYA = 500, MAKS_POTONGAN = 6, MAKS_PER_ATURAN = 2, MAKS_TEKS = 2400, MAKS_TOTAL = 15000;
  const KUNCI_PERANGKAT = 'jejak-aturan-pajak:perangkat:v1';
  const KUNCI_RIWAYAT = 'jejak-aturan-pajak:tanya-riwayat:v1';
  const CONTOH = [
    'Berapa batas lebih bayar untuk restitusi dipercepat?',
    'Siapa saja yang boleh menjadi kuasa wajib pajak?',
    'Bagaimana menghitung PPh Pasal 21 bulanan dengan tarif efektif rata-rata?',
    'Apa sanksi bila terlambat menyampaikan SPT Masa?',
  ];

  /* ---------- Identitas perangkat (acak, hanya untuk menghitung jatah harian) ---------- */
  function idPerangkat() {
    let id = '';
    try { id = localStorage.getItem(KUNCI_PERANGKAT) || ''; } catch (e) {}
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      id = (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')).replace(/-/g, '');
      try { localStorage.setItem(KUNCI_PERANGKAT, id); } catch (e) {}
    }
    return id;
  }
  const PERANGKAT = idPerangkat();

  /* ---------- Pencarian potongan pasal ---------- */
  const KATA_UMUM = new Set(('apa apakah bagaimana bagaimanakah berapa berapakah kapan siapa mengapa kenapa dimana mana manakah di ke dari yang dan atau ' +
    'untuk dengan pada dalam oleh itu ini adalah ialah ada jika kalau bila apabila saya aku kami kita anda kamu bisa dapat sudah belum akan masih juga saja ' +
    'tersebut tentang terkait menurut aturan peraturan ketentuan tolong jelaskan jelaskanlah sebutkan mohon seperti sebagai karena maka lebih per nya lah kah ' +
    'dong ya tidak bukan boleh sama antara setelah sebelum sampai hingga terhadap bagi para hal cara jadi tadi agar supaya serta namun tetapi tapi saat ketika ' +
    'secara sesuai berdasarkan apa saja dimaksud maksud arti pengertian berlaku sekarang terbaru baru lama bagaimanakah gimana berapakah adakah apakah ' +
    'dibaca baca membaca detil detail rinci rinciannya step langkah langkahnya tahapan memiliki punya mempunyai kemudian lalu melalui langsung perlu ' +
    'mana dan/atau contoh misal misalnya kasus sebuah suatu seorang ingin mau bantu tolong kira kira-kira ' +
    'juta miliar milyar ribu rupiah setahun sebulan sehari tahun bulan sekaligus').split(' '));
  const POLA_NOMOR = /\b(uu|pp|perppu|perpu|perpres|pmk|kmk|per|kep|se|peng)\s*[-.]?\s*(?:nomor\s*|no\.?\s*)?(\d+[a-z]?)(?:\s*\/\s*pj(?:\.\d+)?)?\s*(?:\/|\s+tahun\s+|\s+)\s*(\d{4})\b|\b(\d+)\s*\/\s*(pmk|kmk)(?:\.\d+)?\s*\/\s*(\d{4})\b/gi;

  // Cocokkan bentuk singkat ("PMK 164/2023", "PER 11/PJ/2025") dengan kutipan aturan di database
  let PETA_KUTIPAN = null;
  const kunciKutipan = t => norm(String(t)).replace(/nomor|no\.|tahun/g, ' ').replace(/[^a-z0-9]+/g, '');
  function cariKutipan(t) {
    if (!PETA_KUTIPAN || PETA_KUTIPAN.n !== ALL.length) { PETA_KUTIPAN = { n: ALL.length, m: new Map() }; ALL.forEach(r => PETA_KUTIPAN.m.set(kunciKutipan(cite(r)), r.id)); }
    return PETA_KUTIPAN.m.get(kunciKutipan(t)) || null;
  }
  function rujukanDalam(q) {
    const ids = new Set(); let m; POLA_NOMOR.lastIndex = 0;
    while ((m = POLA_NOMOR.exec(q))) {
      const teks = m[1] ? `${m[1].toUpperCase()} ${m[2]}${/^(per|se|kep|peng)$/i.test(m[1]) ? '/PJ' : ''}/${m[3]}` : `${m[4]}/${m[5].toUpperCase()}/${m[6]}`;
      const id = (typeof resolveRef === 'function' && resolveRef(teks)) || (m[1] && resolveRef(`${m[1].toUpperCase()} ${m[2]}/${m[3]}`)) || cariKutipan(teks) || (m[1] && cariKutipan(`${m[1]} ${m[2]}/${m[3]}`));
      if (id) ids.add(id);
    }
    return ids;
  }
  function istilahDari(q) {
    const bersih = norm(q).replace(POLA_NOMOR, ' ').replace(/[^a-z0-9%\s]/g, ' ');
    const semua = bersih.split(/\s+/).filter(Boolean);
    const AWAL_ANGKA = /^(pph|pasal|ppn|ayat|huruf|pmk|pp|uu|per|se|kep)$/;
    const kata = semua.map(w => w.replace(/(nya|kah|lah)$/, ''))
      .filter((w, i) => w && !KATA_UMUM.has(w) && (/^\d+$/.test(w) ? AWAL_ANGKA.test(semua[i - 1] || '') : w.length >= 3));
    const unik = [...new Set(kata)].slice(0, 16);
    // frasa dua kata yang berdampingan memberi bobot tambahan (mis. "lebih bayar", "kuasa wajib")
    const frasa = [];
    for (let i = 0; i < kata.length - 1; i++) frasa.push(kata[i] + ' ' + kata[i + 1]);
    return { kata: unik, frasa: [...new Set(frasa)].slice(0, 8) };
  }
  // Singkatan yang lazim ditanyakan tetapi ditulis lengkap di naskah (melengkapi SYNONYMS milik aplikasi)
  const SINGKATAN = {
    spt: ['spt', 'surat pemberitahuan'], sp2dk: ['sp2dk', 'permintaan penjelasan atas data'], pkp: ['pkp', 'pengusaha kena pajak'],
    wp: ['wajib pajak'], dpp: ['dpp', 'dasar pengenaan pajak'], stp: ['stp', 'surat tagihan pajak'], skp: ['skp', 'surat ketetapan pajak'],
    skpkb: ['skpkb', 'surat ketetapan pajak kurang bayar'], skplb: ['skplb', 'surat ketetapan pajak lebih bayar'], lhp: ['lhp', 'laporan hasil pemeriksaan'],
    ptkp: ['ptkp', 'penghasilan tidak kena pajak'], bupot: ['bupot', 'bukti pemotongan'], nik: ['nik', 'nomor induk kependudukan'],
    nitku: ['nitku', 'nomor identitas tempat kegiatan usaha'], efaktur: ['e faktur', 'faktur pajak elektronik'], terlambat: ['terlambat', 'jangka waktu', 'tidak disampaikan'],
    bayar: ['bayar', 'pembayaran'], lapor: ['lapor', 'pelaporan', 'disampaikan'], restitusi: ['restitusi', 'pengembalian pendahuluan', 'kelebihan pembayaran'],
  };
  SINGKATAN.telat = ['telat', 'terlambat', 'jangka waktu', 'tidak disampaikan'];
  Object.assign(SINGKATAN, {
    omset: ['omset', 'omzet', 'peredaran bruto'], omzet: ['omzet', 'omset', 'peredaran bruto'],
    marketplace: ['marketplace', 'lokapasar', 'perdagangan melalui sistem elektronik', 'pmse', 'penyelenggara sistem elektronik'],
    online: ['online', 'daring', 'sistem elektronik', 'pmse'], ecommerce: ['perdagangan melalui sistem elektronik', 'pmse', 'lokapasar'],
    menjual: ['menjual', 'penjualan', 'penyerahan'], jualan: ['penjualan', 'penyerahan'], dagang: ['perdagangan', 'pedagang'],
    gaji: ['gaji', 'penghasilan sehubungan dengan pekerjaan'], karyawan: ['karyawan', 'pegawai'],
  });
  // Kata yang menandai pertanyaan perpajakan. Bila ada, pertanyaan panjang berisi banyak kata cerita tetap diproses.
  const JANGKAR = new Set(('pajak perpajakan pph ppn ppnbm spt npwp nitku nik pkp faktur efaktur bupot omset omzet peredaran umkm restitusi sp2dk ' +
    'pemeriksaan keberatan banding gugatan sanksi denda bunga tarif coretax djp kpp meterai pbb bphtb natura tunjangan penghasilan dividen royalti ' +
    'pemotongan pemungutan potong pungut setor penyetoran lapor pelaporan kup ptkp skp skpkb skplb stp lhp dpp ' +
    'pmse pembukuan pencatatan').split(' '));
  const altIstilah = w => SINGKATAN[w] || ((typeof SYNONYMS !== 'undefined' && SYNONYMS[w]) ? SYNONYMS[w] : [w]);

  // Imbuhan sederhana: pertanyaan memakai kata kerja ("menyampaikan", "menghitung"), naskah memakai kata benda
  // ("penyampaian", "penghitungan"). Kata dipangkas ke kemungkinan kata dasarnya, lalu dicocokkan dengan imbuhan apa pun.
  function akarKata(w) {
    if (w.length < 6 || /[\d\s]/.test(w)) return [];
    const hasil = new Set();
    const pre = [[/^meny(?=[aiueo])/, 's'], [/^peny(?=[aiueo])/, 's'], [/^meng(?=[aiueo])/, ['k', '']], [/^peng(?=[aiueo])/, ['k', '']],
      [/^meng/, ''], [/^peng/, ''], [/^mem(?=[aiueo])/, 'p'], [/^pem(?=[aiueo])/, 'p'], [/^mem/, ''], [/^pem/, ''],
      [/^men(?=[aiueo])/, 't'], [/^pen(?=[aiueo])/, 't'], [/^men/, ''], [/^pen/, ''], [/^me/, ''], [/^pe/, ''], [/^per/, ''],
      [/^di/, ''], [/^ter/, ''], [/^ber/, '']];
    let dasar = [];
    for (const [re, ganti] of pre) if (re.test(w)) { (Array.isArray(ganti) ? ganti : [ganti]).forEach(g => dasar.push(w.replace(re, g))); break; }
    const adaAwalan = dasar.length > 0;
    if (!adaAwalan) dasar = [w];
    for (let d of dasar) {
      d = d.replace(/nya$/, '');
      const pangkas = adaAwalan ? d.replace(/(kan|an|i)$/, '') : d.replace(/(kan|an)$/, '');
      [d, pangkas].forEach(x => { if (x.length >= 4) hasil.add(x); });
    }
    hasil.delete(w);
    return [...hasil];
  }
  function regexAkar(r) {
    const s = r.replace(/[^a-z]/g, ''); if (s.length < 4) return null;
    const alt = [`(?:me|mem|men|meng|pe|pem|pen|peng|per|di|ter|ber|ke|se)?${s}`];
    const nasal = { s: 'ny', p: 'm', t: 'n', k: 'ng' }[s[0]];
    if (nasal) alt.push(`(?:me|pe)${nasal}${s.slice(1)}`);
    const re = new RegExp(`(^|[^a-z0-9])((?:${alt.join('|')}))`, 'g'); re.word = r; return re;
  }
  function regexIstilah(w) {
    const re = altIstilah(w).map(altRegex);
    akarKata(w).forEach(a => { const x = regexAkar(a); if (x) re.push(x); });
    return re;
  }
  const polosIstilah = w => [...altIstilah(w), ...akarKata(w).map(a => a.slice(1))];
  function teksRingkas(r) {
    return [r.ringkasan, ...(r.poin || []), ...(r.isi_pokok || []), (RINGKASAN[r.id] && RINGKASAN[r.id].teks) || ''].filter(Boolean).join('\n').trim();
  }
  function statusTeks(r) {
    let s = STATUS[r.status] || r.status || '';
    const oleh = (ids) => ids.map(id => BYID[id] ? cite(BYID[id]) : id).join(', ');
    if (r._dicabutOleh && r._dicabutOleh.length) s += `, dicabut oleh ${oleh(r._dicabutOleh)}`;
    if (r._diubahOleh && r._diubahOleh.length) s += `, diubah oleh ${oleh(r._diubahOleh)}`;
    return s.slice(0, 80);
  }
  function jendela(teks, pos, lebar) {
    if (teks.length <= lebar) return teks;
    let s = Math.max(0, Math.min(teks.length - lebar, pos - Math.floor(lebar / 3)));
    if (s > 0) { const sp = teks.indexOf(' ', s); if (sp > 0 && sp < s + 40) s = sp + 1; }
    const e = Math.min(teks.length, s + lebar);
    return (s > 0 ? '… ' : '') + teks.slice(s, e).trim() + (e < teks.length ? ' …' : '');
  }

  function cariPotongan(q, ekstra) {
    let { kata, frasa } = istilahDari(q);
    const rujuk = rujukanDalam(q);
    // Saran dari tahap kata kunci AI: hanya aturan yang benar-benar ada di database yang dipakai.
    const saran = new Set();
    if (ekstra) {
      (ekstra.aturan || []).forEach(a => {
        const t = String(a), ids = rujukanDalam(t);
        if (ids.size) ids.forEach(id => saran.add(id)); else { const id = resolveRef(t) || cariKutipan(t); if (id) saran.add(id); }
      });
      rujuk.forEach(id => saran.delete(id));
      const tambahan = (ekstra.kata_kunci || []).map(x => norm(String(x)).replace(/[^a-z0-9%\s]/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(x => x.length >= 3 && !KATA_UMUM.has(x));
      kata = [...new Set([...tambahan, ...kata])].slice(0, 22);
    }
    if (!kata.length && !rujuk.size && !saran.size) return { potongan: [], kata };
    const grup = kata.map(w => ({ w, re: regexIstilah(w), polos: polosIstilah(w) }));
    // frasa dua kata, termasuk bentuk panjangnya ("spt masa" → "surat pemberitahuan masa")
    const reFrasa = frasa.map(f => {
      const [a, b] = f.split(' ');
      const varian = [];
      altIstilah(a).forEach(x => altIstilah(b).forEach(y => varian.push(`${x} ${y}`)));
      return { f, re: varian.slice(0, 12).map(altRegex) };
    });
    const isiPenuh = r => (NASKAH[r.id] ? NASKAH[r.id].full : '');

    // 1) bobot istilah (idf) — hitung kasar dengan includes supaya cepat di 30 MB teks
    const nDok = ALL.length;
    grup.forEach(g => {
      let df = 0;
      for (const r of ALL) if (g.polos.some(a => r._idx.includes(a) || isiPenuh(r).includes(a))) df++;
      g.df = df; g.bobot = df ? Math.log(1 + nDok / df) : 0;
    });
    const aktif = grup.filter(g => g.df > 0);
    if (!aktif.length && !rujuk.size && !saran.size) return { potongan: [], kata };
    // Bobot seluruh istilah pertanyaan; istilah yang tidak ada di database sama sekali dihitung bobot maksimal,
    // supaya pertanyaan di luar topik ("resep nasi goreng") tidak lolos hanya karena satu kata kebetulan cocok.
    const bobotSemua = grup.reduce((t, g) => t + (g.df ? g.bobot : Math.log(1 + nDok)), 0) || 1;
    const bobotAktif = aktif.reduce((t, g) => t + g.bobot, 0) || 1;
    const adaJangkar = !!ekstra || kata.some(w => JANGKAR.has(w));

    // 2) nilai tiap aturan
    const kandidat = [];
    for (const r of ALL) {
      let skor = 0, cocok = 0;
      const full = isiPenuh(r);
      for (const g of aktif) {
        const diKepala = g.re.some(a => matchAlt(r._head, a));
        const diIdx = diKepala || g.re.some(a => matchAlt(r._idx, a));
        const diIsi = !diIdx && full && g.polos.some(a => full.includes(a)) && g.re.some(a => matchAlt(full, a));
        if (diKepala) { skor += g.bobot * 3; cocok++; } else if (diIdx) { skor += g.bobot * 1.6; cocok++; } else if (diIsi) { skor += g.bobot * 0.35; cocok++; }
      }
      const dirujuk = rujuk.has(r.id), disarankan = saran.has(r.id);
      if (!cocok && !dirujuk && !disarankan) continue;
      skor *= 0.5 + cocok / Math.max(1, aktif.length);
      skor += ({ berlaku: 1.2, diubah: 0.5, belum: 0.2, dicabut: -1.2 })[r.status] || 0;
      skor += Math.max(0, Math.min(1, ((+r.th || 1983) - 1983) / 43)) * 0.8;
      if (dirujuk) skor += 100;
      if (disarankan) skor += 30;
      kandidat.push({ r, skor });
    }
    kandidat.sort((a, b) => b.skor - a.skor);
    const atas = kandidat.slice(0, 24);
    const skorAturanMaks = atas.length ? Math.max(1, atas[0].skor) : 1;

    // 3) nilai tiap pasal/bagian di aturan teratas
    const calon = [];
    for (const { r, skor: skorAturan } of atas) {
      const N = NASKAH[r.id];
      const bagian = N ? N.segs.map(g => ({ l: g.l, t: g.t, n: g.n })) : [];
      const ring = teksRingkas(r);
      if (ring) bagian.push({ l: 'Ringkasan', t: ring, n: norm(ring), ringkasan: true });
      for (const b of bagian) {
        let s = 0, cocok = 0, liput = 0, pos = -1, kunciTerbaik = null, bobotTerbaik = 0;
        for (const g of aktif) {
          let c = 0;
          for (const a of g.re) {
            const h = hitung(b.n, a, 20);
            if (h) { c += h; if (pos < 0) { a.lastIndex = 0; const m = a.exec(b.n); if (m) pos = m.index; } }
          }
          if (c) { cocok++; liput += g.bobot; s += g.bobot * (1 + Math.log(c)); if (g.bobot > bobotTerbaik) { bobotTerbaik = g.bobot; kunciTerbaik = g.w; } }
        }
        for (const f of reFrasa) if (f.re.some(a => matchAlt(b.n, a))) s += 3;
        const dirujuk = rujuk.has(r.id), disarankan = saran.has(r.id);
        if (!cocok && !((dirujuk || disarankan) && b.ringkasan)) continue;
        s *= 0.4 + cocok / Math.max(1, aktif.length);
        if (b.ringkasan) s *= 0.9;
        if (b.t.length < 120) s *= 0.6;   // potongan sangat pendek (judul bab, dsb.) jarang menjawab
        if (!dirujuk) s *= ({ dicabut: 0.55, diubah: 0.85 })[r.status] || 1;   // utamakan aturan yang masih berlaku
        const panjang = aktif.length >= 5;
        if (panjang && /^(Pasal I › )?Pasal 1\b(?! *\d)/.test(String(b.l || ''))) s *= 0.5;   // pasal definisi memuat banyak istilah tapi jarang menjawab
        s += (panjang ? 5 : 2.5) * ((dirujuk || disarankan) ? 1 : skorAturan / skorAturanMaks);
        if (dirujuk) s += 6;
        if (disarankan) s += 3;
        else if (saran.size && !dirujuk) s *= 0.7;   // ada saran aturan yang terverifikasi: aturan lain diberi bobot lebih kecil
        calon.push({ r, l: b.l, t: b.t, pos, s, kunci: kunciTerbaik, liputan: liput / bobotSemua, liputanA: liput / bobotAktif, dirujuk, disarankan });
      }
    }
    calon.sort((a, b) => b.s - a.s);
    // Ambang relevansi: potongan terbaik harus memuat istilah yang mewakili ≥50% bobot pertanyaan
    // (kecuali pengguna menyebut nomor aturan yang ada). Di bawah itu pertanyaan tidak dikirim, jatah tidak terpakai.
    // Pertanyaan perpajakan (ada kata jangkar) cukup ≥30% dari istilah yang dikenal database, supaya pertanyaan
    // skenario panjang ("WP jual skincare impor lewat marketplace…") tetap diproses.
    const liputanTerbaik = calon.reduce((m, c) => Math.max(m, c.liputan), 0);
    const liputanATerbaik = calon.reduce((m, c) => Math.max(m, c.liputanA), 0);
    const lolos = rujuk.size || saran.size || (adaJangkar ? liputanATerbaik >= 0.3 : liputanTerbaik >= AMBANG);
    if (!lolos) return { potongan: [], kata, liputan: liputanTerbaik };

    // 4) pilih maks. 6 potongan, maks. 2 per aturan (4 bila aturannya disebut), total ≤ 15.000 huruf
    const dipilih = [], perAturan = {};
    let total = 0;
    // Aturan yang disarankan AI dan terbukti ada di database mendapat jatah tempat (maks. 4, satu potongan terbaik masing-masing),
    // sisanya diisi menurut nilai. Dengan begitu aturan inti tidak tergeser aturan lain yang kebetulan memuat istilah sama.
    const cadangan = [], sudah = new Set();
    for (const c of calon) {
      if (cadangan.length >= 4) break;
      if (c.disarankan && !sudah.has(c.r.id) && c.r.status !== 'dicabut') { cadangan.push(c); sudah.add(c.r.id); }
    }
    const urutan = [...cadangan, ...calon.filter(c => !cadangan.includes(c))];
    for (const c of urutan) {
      if (dipilih.length >= MAKS_POTONGAN) break;
      if ((perAturan[c.r.id] || 0) >= (c.dirujuk ? 4 : MAKS_PER_ATURAN)) continue;
      if (c.liputanA < 0.15 && !c.dirujuk && !c.disarankan) continue;
      const teks = jendela(c.t.replace(/[ \t]+/g, ' ').trim(), Math.max(0, c.pos), MAKS_TEKS);
      if (total + teks.length > MAKS_TOTAL) continue;
      total += teks.length; perAturan[c.r.id] = (perAturan[c.r.id] || 0) + 1;
      dipilih.push({ id: c.r.id, sumber: `${cite(c.r)} tentang ${c.r.judul}`.slice(0, 150), label: String(c.l || '').slice(0, 100), status: statusTeks(c.r), teks, kunci: c.kunci });
    }
    return { potongan: dipilih, kata, liputan: liputanTerbaik, _calon: calon.slice(0, 40).map(c => [cite(c.r), c.l, +c.s.toFixed(2), +c.liputan.toFixed(2)]) };
  }

  /* ---------- Riwayat (supaya pertanyaan yang sama tidak memakai jatah lagi) ---------- */
  const muatRiwayat = () => { try { const v = JSON.parse(localStorage.getItem(KUNCI_RIWAYAT) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
  const simpanRiwayat = v => { try { localStorage.setItem(KUNCI_RIWAYAT, JSON.stringify(v.slice(0, 20))); } catch (e) {} };
  const kunciTanya = q => norm(q).replace(/[^a-z0-9]+/g, ' ').trim();

  /* ---------- Tampilan ---------- */
  const gaya = document.createElement('style');
  gaya.textContent = `
#p-tanya{display:grid;gap:14px}
#p-tanya[hidden]{display:none!important}
#tq-form textarea{min-height:84px}
.tq-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.tq-bar .tq-kuota{margin-left:auto}
.tq-privasi{margin:0;font-size:12.5px;color:var(--warn);background:var(--warn-soft);border-radius:var(--r);padding:8px 10px}
.tq-jawab{display:grid;gap:14px}
.tq-q{margin:0;font-weight:600}
.tq-ref{display:inline-block;min-width:1.6em;padding:0 5px;margin:0 1px;border:1px solid var(--accent);border-radius:999px;background:var(--accent-soft);color:var(--accent);font:600 11.5px/1.5 var(--f-mono);cursor:pointer;vertical-align:1px}
.tq-awas{border-radius:var(--r);padding:9px 11px;background:var(--bad-soft);color:var(--bad);font-size:13.5px}
.tq-catat{border-radius:var(--r);padding:9px 11px;background:var(--warn-soft);color:var(--warn);font-size:13.5px}
.tq-sumber{display:grid;gap:0;border-top:1px solid var(--line)}
.tq-src{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;padding:10px 0;border-bottom:1px solid var(--line);text-align:left;background:none;border-left:0;border-right:0;border-top:0;cursor:pointer;width:100%}
.tq-src .tq-n{font:600 12px/1.6 var(--f-mono);color:var(--accent)}
.tq-src .cite{font-size:13px}
.tq-src .tq-l{font-size:13px;color:var(--muted)}
.tq-src:hover .cite{text-decoration:underline}
.tq-riwayat summary{cursor:pointer}
.tq-riwayat ul{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:0}
.tq-riwayat li button{width:100%;text-align:left;background:none;border:0;border-top:1px solid var(--line);padding:9px 0;cursor:pointer;display:grid;gap:2px}
.tq-riwayat li small{color:var(--muted)}
`;
  document.head.appendChild(gaya);

  const tombolTab = document.createElement('button');
  tombolTab.setAttribute('role', 'tab'); tombolTab.id = 'tab-tanya';
  tombolTab.setAttribute('aria-controls', 'p-tanya'); tombolTab.setAttribute('aria-selected', 'false');
  tombolTab.textContent = 'Tanya AI';
  $('#tab-cari').after(tombolTab);

  const panel = document.createElement('section');
  panel.setAttribute('role', 'tabpanel'); panel.id = 'p-tanya'; panel.setAttribute('aria-labelledby', 'tab-tanya'); panel.hidden = true;
  panel.innerHTML = `
    <p class="lead">Tulis pertanyaan tentang peraturan perpajakan. Jejak Pajak mencari pasal yang relevan di databasenya, lalu AI menyusun jawaban <b>hanya dari pasal-pasal itu</b>, lengkap dengan rujukannya.</p>
    <form class="panel" id="tq-form" novalidate>
      <label style="display:grid;gap:6px"><span class="label">Pertanyaan</span>
        <textarea id="tq" rows="3" maxlength="${MAKS_TANYA}" placeholder="mis. Berapa batas lebih bayar untuk restitusi dipercepat?"></textarea></label>
      <div class="tq-bar"><button class="btn" type="submit" id="tq-kirim">Tanya</button><span class="chain" id="tq-hitung">0/${MAKS_TANYA}</span><span class="chain tq-kuota" id="tq-kuota" role="status"></span></div>
      <p class="tq-privasi">Pertanyaan dan potongan pasal dikirim ke server DeepSeek. Jangan menulis data wajib pajak seperti nama, NPWP, atau nilai transaksi.</p>
    </form>
    <div class="beranda-contoh"><span class="label">Contoh</span>${CONTOH.map(c => `<button class="chip" type="button" data-tq-contoh="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <div id="tq-hasil" aria-live="polite"></div>
    <details class="tq-riwayat" id="tq-riwayat" hidden><summary class="label">Pertanyaan sebelumnya di perangkat ini</summary><ul id="tq-riwayat-list"></ul></details>`;
  $('#p-cari').after(panel);
  TABS.push('tanya');

  const el = {
    form: $('#tq-form'), tanya: $('#tq'), kirim: $('#tq-kirim'), hitung: $('#tq-hitung'), kuota: $('#tq-kuota'),
    hasil: $('#tq-hasil'), riwayat: $('#tq-riwayat'), riwayatList: $('#tq-riwayat-list'),
  };
  const ST = { jalan: null, sisa: null, sisaGlobal: null, potongan: [] };

  function tampilKuota() {
    if (ST.sisaGlobal === 0) { el.kuota.textContent = 'Kuota semua pengguna hari ini habis (dibuka 00.00 WIB)'; return; }
    if (ST.sisa == null) { el.kuota.textContent = ''; return; }
    el.kuota.textContent = `Sisa jatah hari ini: ${ST.sisa} pertanyaan`;
  }
  async function segarkanKuota() {
    try {
      const r = await fetch(ALAMAT + '/kuota', { headers: { 'X-Perangkat': PERANGKAT }, cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json(); ST.sisa = d.sisaPerangkat; ST.sisaGlobal = d.sisaGlobal; tampilKuota();
    } catch (e) {}
  }

  function htmlSumber(pot, adaJawaban) {
    // Catatan status digabung per aturan (satu aturan bisa muncul di dua potongan) dan hanya tampil bila ada jawaban.
    const perAturan = new Map();
    pot.forEach((p, i) => { const r = BYID[p.id]; if (r && (r.status === 'dicabut' || r.status === 'diubah')) { if (!perAturan.has(r.id)) perAturan.set(r.id, { r, no: [] }); perAturan.get(r.id).no.push(i + 1); } });
    const oleh = ids => (ids || []).map(id => BYID[id] ? cite(BYID[id]) : id).join(', ');
    const sebut = (x, kata, ids) => `${x.no.map(n => `[${n}]`).join('')} ${esc(cite(x.r))}${ids && ids.length ? ` (${kata} oleh ${esc(oleh(ids))})` : ''}`;
    const cabut = [...perAturan.values()].filter(x => x.r.status === 'dicabut').map(x => sebut(x, 'dicabut', x.r._dicabutOleh));
    const ubah = [...perAturan.values()].filter(x => x.r.status === 'diubah').map(x => sebut(x, 'diubah', x.r._diubahOleh));
    const catatan = !adaJawaban ? '' : (cabut.length ? `<div class="tq-awas">${cabut.length === 1
        ? `Dasar ${cabut[0]} sudah dicabut, jadi tidak bisa dipakai sebagai dasar saat ini. Buka aturan penggantinya.`
        : `Beberapa dasar sudah dicabut, jadi tidak bisa dipakai sebagai dasar saat ini: ${cabut.join('; ')}. Buka aturan penggantinya.`}</div>` : '')
      + (ubah.length ? `<div class="tq-catat">${ubah.length === 1
        ? `Catatan: ${ubah[0]} pernah diubah. Bunyi pasal yang dikutip mungkin sudah berbeda, periksa versi terbarunya.`
        : `Catatan: beberapa dasar pernah diubah, bunyi pasalnya mungkin sudah berbeda: ${ubah.join('; ')}. Periksa versi terbarunya.`}</div>` : '');
    return `${catatan}
      <div style="display:grid;gap:6px"><span class="label">${adaJawaban ? 'Dasar yang dibaca AI' : 'Pasal yang ditemukan di database'} (ketuk untuk membuka naskah)</span>
      <div class="tq-sumber">${pot.map((p, i) => { const r = BYID[p.id]; return `<button type="button" class="tq-src" data-tq-buka="${i}">
        <span class="tq-n">[${i + 1}]</span><span><span class="cite">${esc(r ? cite(r) : p.sumber)}</span> <span class="tq-l">· ${esc(p.label)}</span>
        ${r ? `<span class="pill ${esc(r.status)}" style="margin-left:6px">${esc(STATUS[r.status] || r.status)}</span>` : ''}<br><span class="tq-l">${esc(r ? r.judul : '')}</span></span></button>`; }).join('')}</div></div>
      ${adaJawaban ? '<p class="chain" style="margin:0">Jawaban disusun AI dari potongan di atas dan bisa keliru. Cocokkan dengan naskah sebelum dipakai dalam SP2DK, LHP, atau keputusan.</p>' : ''}`;
  }
  function htmlJawaban(teks, pot) {
    return mdLite(teks).replace(/\[(\d{1,2})\]/g, (m, n) => (+n >= 1 && +n <= pot.length) ? `<button type="button" class="tq-ref" data-tq-buka="${+n - 1}" aria-label="Buka sumber ${n}">${n}</button>` : m);
  }
  function tampilHasil(q, teks, pot, catatan, sedang) {
    ST.potongan = pot;
    el.hasil.innerHTML = `<div class="panel tq-jawab">
      <p class="tq-q">${esc(q)}</p>
      <div class="md-out" id="tq-teks">${teks ? htmlJawaban(teks, pot) : ''}${sedang ? `<p class="chain thinking">${esc(sedang)}</p>` : ''}</div>
      ${ST.jalan ? '<div><button class="btn ghost small" type="button" data-tq-stop>Hentikan</button></div>' : ''}
      ${catatan ? `<p class="chain" style="margin:0">${catatan}</p>` : ''}
      ${pot.length ? htmlSumber(pot, !!teks) : ''}
    </div>`;
  }
  function renderRiwayat() {
    const v = muatRiwayat();
    el.riwayat.hidden = !v.length;
    el.riwayatList.innerHTML = v.map((x, i) => `<li><button type="button" data-tq-riwayat="${i}"><span>${esc(x.q)}</span><small>${esc(fmtTgl(x.waktu))}</small></button></li>`).join('');
  }

  async function tanya(q, paksa) {
    q = String(q || '').trim().slice(0, MAKS_TANYA);
    if (q.length < 5) { toast('Tulis pertanyaan yang lebih lengkap.'); return; }
    if (ST.jalan) return;
    const k = kunciTanya(q), lama = muatRiwayat().find(x => x.k === k);
    if (lama && !paksa) {
      tampilHasil(lama.q, lama.jawaban, lama.potongan, `Jawaban tersimpan dari ${esc(fmtTgl(lama.waktu))}, tidak memakai jatah. <button class="linkish" type="button" data-tq-ulang>Tanya ulang</button>`);
      return;
    }
    if (NASKAH_ST.status === 'memuat') { toast('Data naskah masih dimuat. Coba lagi sebentar.'); return; }

    // Pertanyaan kasus/bebas seputar pajak (≥5 kata bermakna, tanpa nomor aturan): minta AI menerjemahkan dulu ke istilah peraturan (1 jatah untuk kedua tahap).
    let ekstra = null;
    const ist = istilahDari(q);
    if ((q.length >= 100 || ist.kata.length >= 5) && ist.kata.some(w => JANGKAR.has(w)) && !rujukanDalam(q).size) {
      el.kirim.disabled = true;
      tampilHasil(q, '', [], '', 'Menerjemahkan pertanyaan ke istilah peraturan…');
      try {
        const r = await fetch(ALAMAT + '/kunci', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Perangkat': PERANGKAT }, body: JSON.stringify({ pertanyaan: q }) });
        const d = await r.json().catch(() => ({}));
        if (d.sisaPerangkat != null) ST.sisa = d.sisaPerangkat;
        if (d.sisaGlobal != null) ST.sisaGlobal = d.sisaGlobal;
        if (d.kode === 'kuota_global') ST.sisaGlobal = 0;
        tampilKuota();
        if (!r.ok) { el.kirim.disabled = false; tampilHasil(q, '', [], esc(d.pesan || `Layanan tanya sedang tidak tersedia (kode ${r.status}). Coba lagi nanti.`)); return; }
        ekstra = d;
      } catch (e) {
        el.kirim.disabled = false; tampilHasil(q, '', [], 'Tidak bisa terhubung ke layanan tanya. Periksa internet, lalu coba lagi.'); return;
      }
    }

    const { potongan } = cariPotongan(q, ekstra);
    if (!potongan.length && !ekstra) {
      tampilHasil(q, '', [], 'Tidak ditemukan pasal yang cocok dengan pertanyaan ini di database, jadi pertanyaan tidak dikirim ke AI dan jatah tidak terpakai. Coba kata kunci yang lebih spesifik, misalnya istilah atau nomor aturannya.');
      return;
    }

    const ctl = new AbortController(); ST.jalan = ctl;
    el.kirim.disabled = true;
    let teks = '', terakhir = 0;
    tampilHasil(q, '', potongan, '', `Membaca ${potongan.length} potongan pasal…`);
    try {
      const res = await fetch(ALAMAT + '/tanya', {
        method: 'POST', signal: ctl.signal, cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Perangkat': PERANGKAT },
        body: JSON.stringify({ pertanyaan: q, potongan: potongan.map(({ sumber, label, status, teks }) => ({ sumber, label, status, teks })), tiket: ekstra ? ekstra.tiket : undefined }),
      });
      if (!res.ok || !res.body) {
        let d = {}; try { d = await res.json(); } catch (e) {}
        if (d.sisaPerangkat != null) ST.sisa = d.sisaPerangkat;
        if (d.kode === 'kuota_global') ST.sisaGlobal = 0;
        tampilKuota();
        ST.jalan = null;
        tampilHasil(q, '', potongan, esc(d.pesan || `Layanan tanya sedang tidak tersedia (kode ${res.status}). Coba lagi nanti.`));
        return;
      }
      const baca = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let sisa = '', selesai = null, galat = '';
      for (;;) {
        const { value, done } = await baca.read();
        if (done) break;
        sisa += value;
        let i;
        while ((i = sisa.indexOf('\n\n')) >= 0) {
          const blok = sisa.slice(0, i); sisa = sisa.slice(i + 2);
          const baris = blok.split('\n').find(b => b.startsWith('data:'));
          if (!baris) continue;
          let d; try { d = JSON.parse(baris.slice(5)); } catch (e) { continue; }
          if (d.mulai) { ST.sisa = d.sisaPerangkat; ST.sisaGlobal = d.sisaGlobal; tampilKuota(); }
          if (d.t) teks += d.t;
          if (d.selesai) selesai = d;
          if (d.galat) galat = d.galat;
        }
        if (teks && Date.now() - terakhir > 80) { terakhir = Date.now(); tampilHasil(q, teks, potongan, ''); }
      }
      ST.jalan = null;
      const catatan = galat ? esc(galat)
        : !teks ? 'AI tidak mengembalikan jawaban. Coba lagi.'
        : selesai && selesai.ditolak ? 'Jawaban dihentikan oleh penyaring konten penyedia AI.'
        : selesai && selesai.terpotong ? 'Jawaban terpotong karena batas panjang. Persempit pertanyaannya bila perlu.' : '';
      tampilHasil(q, teks, potongan, catatan);
      if (teks && !galat) {
        const v = muatRiwayat().filter(x => x.k !== k);
        v.unshift({ k, q, jawaban: teks, potongan: potongan.map(({ id, sumber, label, status, kunci }) => ({ id, sumber, label, status, kunci })), waktu: new Date().toISOString() });
        simpanRiwayat(v); renderRiwayat();
      }
    } catch (e) {
      ST.jalan = null;
      if (e && e.name === 'AbortError') tampilHasil(q, teks, potongan, 'Dihentikan.');
      else tampilHasil(q, teks, potongan, 'Tidak bisa terhubung ke layanan tanya. Periksa internet, lalu coba lagi.');
    } finally {
      ST.jalan = null; el.kirim.disabled = false;
    }
  }

  /* ---------- Peristiwa ---------- */
  el.tanya.addEventListener('input', () => { el.hitung.textContent = `${el.tanya.value.length}/${MAKS_TANYA}`; });
  el.tanya.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); tanya(el.tanya.value); } });
  el.form.addEventListener('submit', e => { e.preventDefault(); tanya(el.tanya.value); });
  panel.addEventListener('click', e => {
    const c = e.target.closest('[data-tq-contoh]'); if (c) { el.tanya.value = c.dataset.tqContoh; el.hitung.textContent = `${el.tanya.value.length}/${MAKS_TANYA}`; tanya(el.tanya.value); return; }
    const b = e.target.closest('[data-tq-buka]'); if (b) { const p = ST.potongan[+b.dataset.tqBuka]; if (p && BYID[p.id]) openDetail(p.id, p.kunci || ''); return; }
    if (e.target.closest('[data-tq-stop]')) { ST.jalan && ST.jalan.abort(); return; }
    if (e.target.closest('[data-tq-ulang]')) { const q = el.hasil.querySelector('.tq-q'); tanya(q ? q.textContent : el.tanya.value, true); return; }
    const rw = e.target.closest('[data-tq-riwayat]');
    if (rw) { const x = muatRiwayat()[+rw.dataset.tqRiwayat]; if (x) { el.tanya.value = x.q; el.hitung.textContent = `${x.q.length}/${MAKS_TANYA}`; tanya(x.q); window.scrollTo({ top: panel.getBoundingClientRect().top + scrollY - 8 }); } }
  });

  const tabAsli = showTab;
  showTab = function (nama) { tabAsli(nama); if (nama === 'tanya') segarkanKuota(); };
  renderRiwayat();
  // Skrip utama sudah mengganti #tanya menjadi #cari sebelum berkas ini dimuat; baca alamat awal halaman.
  let hashAwal = location.hash;
  try { const nav = performance.getEntriesByType('navigation')[0]; if (nav && nav.name) hashAwal = new URL(nav.name).hash || hashAwal; } catch (e) {}
  if (hashAwal === '#tanya') showTab('tanya');

  // untuk pengujian dari konsol: JejakTanya.cari('pertanyaan')
  window.JejakTanya = { cari: (q, e) => cariPotongan(q, e).potongan, diagnosa: (q, e) => cariPotongan(q, e) };
})();
