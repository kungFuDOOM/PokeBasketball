// Encodes a real Play of the Game through the production WebCodecs path (src/screens/potgClip.ts) in headless Chromium,
// then checks the MP4 with ffprobe: codec, size, fps, frame gaps, moov before mdat, audio, and a non-blank mid frame.
// Usage: node scripts/clip-webcodecs-check.mjs [outDir]   (needs /usr/bin/google-chrome, ffmpeg, ffprobe, playwright-core)
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const out = process.argv[2] ?? '/workspace/pj-potg-wc-shots';
mkdirSync(out, { recursive: true });
const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--enable-features=VaapiVideoEncoder', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto('http://localhost:5199/');
const res = await page.evaluate(async () => {
  const imp = (p) => import(/* @vite-ignore */ p);
  const [{ COURTS }, { monByDex }, { Game }, { ReplayRecorder }, sync, types, potg, clip, { Audio }] = await Promise.all([
    imp('/src/data/courts.ts'), imp('/src/data/pokemon.ts'), imp('/src/game/game.ts'), imp('/src/game/replay.ts'), imp('/src/game/sync.ts'),
    imp('/src/game/types.ts'), imp('/src/screens/potg.ts'), imp('/src/screens/potgClip.ts'), imp('/src/game/audio.ts'),
  ]);
  const team = (name, dexes) => ({ name, abbr: name.slice(0, 3).toUpperCase(), color: '#3b6fd8', color2: '#16224a', human: true, roster: dexes.map(monByDex) });
  const cfg = { home: team('Pallet Town', [25, 381, 6, 445, 382]), away: team('Indigo Elite', [94, 130, 149, 248, 150]), quarterLen: 30, difficulty: 'pro', court: COURTS['Indigo Elite'], seed: 5 };
  const g = new Game(cfg); g.viewTeam = 1;
  const rec = new ReplayRecorder(cfg, g.seed, 1);
  const rng = types.seededRng(9);
  for (let t = 0; g.phase !== 'final' && t < 100000; t++) {
    const i = types.emptyIntent(); i.mx = rng() * 2 - 1; i.my = rng() * 2 - 1; i.shoot = rng() < 0.03; i.pass = rng() < 0.01;
    const inputs = [sync.packInput(i), sync.packInput(i)];
    rec.beforeBoth(g, inputs); const n = g.events.length; sync.stepGame(g, inputs); rec.after(g, g.events.slice(n)); g.events.length = 0;
  }
  if (!potg.rememberBest(g, rec, new Audio())) return { error: 'no play' };
  const supported = clip.clipSupported(g);
  const t0 = performance.now();
  const file = await clip.recordPlayClip(g).done;
  const ms = performance.now() - t0;
  if (!file) return { error: 'no file', supported };
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { supported, ms, name: file.name, type: file.type, b64: btoa(s) };
});
await browser.close(); await server.close();
if (res.error) { console.log(res); process.exit(1); }
const mp4 = `${out}/potg-webcodecs.mp4`;
writeFileSync(mp4, Buffer.from(res.b64, 'base64'));
const probe = (...a) => execFileSync('ffprobe', ['-v', 'error', ...a, mp4]).toString();
const j = JSON.parse(probe('-show_entries', 'format=duration,size,bit_rate,format_name:stream=index,codec_type,codec_name,profile,width,height,r_frame_rate,avg_frame_rate,nb_frames,pix_fmt', '-of', 'json'));
const pts = probe('-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0').split('\n').filter(Boolean).map(Number).sort((a, b) => a - b);
const gaps = pts.slice(1).map((v, i) => (v - pts[i]) * 1000);
const hist = {}; for (const x of gaps) { const k = x < 10 ? '<10ms' : x < 30 ? '10-30ms' : x < 37 ? '30-37ms(ok)' : '>=37ms'; hist[k] = (hist[k] ?? 0) + 1; }
// moov vs mdat offsets from the top-level boxes
const b = readFileSync(mp4); const boxes = []; for (let o = 0; o + 8 <= b.length;) { let sz = b.readUInt32BE(o); const ty = b.toString('latin1', o + 4, o + 8); if (sz === 1) sz = Number(b.readBigUInt64BE(o + 8)); boxes.push([ty, o]); if (!sz) break; o += sz; }
const moov = boxes.find((x) => x[0] === 'moov')?.[1], mdat = boxes.find((x) => x[0] === 'mdat')?.[1];
// non-blank mid frame
const frame = `${out}/potg-webcodecs-midframe.png`;
execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String((pts.at(-1) ?? 2) / 2), '-i', mp4, '-frames:v', '1', frame]);
const stat = execFileSync('ffmpeg', ['-v', 'error', '-i', frame, '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-']).toString();
const g1 = (k) => Number(stat.match(new RegExp(`${k}=([\\d.]+)`))?.[1]);
const v = j.streams.find((s) => s.codec_type === 'video');
console.log(JSON.stringify({
  clipSupported: res.supported, encodeMs: Math.round(res.ms), file: res.name, mime: res.type, bytes: j.format.size, container: j.format.format_name, durationS: +j.format.duration, bitrate: +j.format.bit_rate,
  codec: v.codec_name, profile: v.profile, size: `${v.width}x${v.height}`, pix_fmt: v.pix_fmt, rFrameRate: v.r_frame_rate, frames: pts.length,
  avgFps: +(pts.length / (pts.at(-1) - pts[0] + 1 / 30)).toFixed(2), gapMs: { min: +Math.min(...gaps).toFixed(2), max: +Math.max(...gaps).toFixed(2) }, gapHistogram: hist,
  audioStreams: j.streams.filter((s) => s.codec_type === 'audio').length, moovOffset: moov, mdatOffset: mdat, moovBeforeMdat: moov < mdat,
  midFrame: { YMIN: g1('lavfi.signalstats.YMIN'), YMAX: g1('lavfi.signalstats.YMAX'), YAVG: g1('lavfi.signalstats.YAVG'), YDIF: g1('lavfi.signalstats.YDIF') },
}, null, 1));
