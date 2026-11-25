// Marquee - a flicker-free "Now Showing" poster display for Plex.
// No dependencies; needs Node 18+.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const CFG = {
  port: parseInt(env('PORT', '8686'), 10),
  plexUrl: env('PLEX_URL', 'http://localhost:32400').replace(/\/+$/, ''),
  plexToken: env('PLEX_TOKEN', ''),
  libraries: env('LIBRARIES', '').split(',').map(s => s.trim()).filter(Boolean),
  slideSeconds: Math.max(5, parseInt(env('SLIDE_SECONDS', '30'), 10)),
  pollSeconds: Math.max(2, parseInt(env('POLL_SECONDS', '5'), 10)),
  theaterPlayers: env('THEATER_PLAYERS', '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  theaterMode: env('THEATER_MODE', 'black').toLowerCase(), // black | poster
  hideUser: /^(1|true|yes)$/i.test(env('HIDE_USER', 'true')),
  hidePlayer: /^(1|true|yes)$/i.test(env('HIDE_PLAYER', 'true')),
  // USER_NAMES: "plexuser=Friendly Name, otheruser=Mom" (matched on Plex user name or user id, case-insensitive)
  userNames: new Map(env('USER_NAMES', '').split(',').map(p => p.split('=')).filter(p => p.length === 2 && p[0].trim() && p[1].trim()).map(([k, v]) => [k.trim().toLowerCase(), v.trim()])),
  posterWidth: parseInt(env('POSTER_WIDTH', '1080'), 10),
  // v1.3: scores and studio
  showScores: !/^(0|false|no)$/i.test(env('SHOW_SCORES', 'true')),
  showTitle: /^(1|true|yes)$/i.test(env('SHOW_TITLE', 'false')),
  haUrl: env('HA_URL', '').replace(/\/+$/, ''),
  haToken: env('HA_TOKEN', ''),
  f1Leader: !/^(0|false|no)$/i.test(env('F1_LEADER', 'true')),
  f1LeaderEntity: env('F1_LEADER_ENTITY', 'sensor.f1_drivers_top_three_p1'),
  f1SessionEntity: env('F1_SESSION_ENTITY', 'sensor.f1_current_session'),
  f1DriversEntity: env('F1_DRIVERS_ENTITY', 'sensor.f1_driver_list'),
  f1LapEntity: env('F1_LAP_ENTITY', 'sensor.f1_race_lap_count'),
  theaterName: env('THEATER_NAME', '').trim().slice(0, 40),
  headings: {
    library: env('HEADING_LIBRARY', 'Now Available').trim(),
    playing: env('HEADING_PLAYING', 'Now Playing').trim(),
    comingSoon: env('HEADING_COMING_SOON', 'Coming Soon').trim(),
    trailer: env('HEADING_TRAILER', 'Now Previewing').trim(),
    f1: env('HEADING_F1', 'Race Leader').trim(),
    custom: env('HEADING_CUSTOM', 'Spotlight').trim(),
  },
  rotate: ['90', '180', '270'].includes(env('ROTATE', '0').trim()) ? Number(env('ROTATE', '0').trim()) : 0,
  showStudio: !/^(0|false|no)$/i.test(env('SHOW_STUDIO', 'true')),
  // v1.3: idle slideshow filters
  excludeRatings: env('EXCLUDE_RATINGS', '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  excludeRatingsHours: env('EXCLUDE_RATINGS_HOURS', ''), // e.g. "07-21": only filter between 7 AM and 9 PM; blank = always
  includeGenres: env('INCLUDE_GENRES', '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  excludeGenres: env('EXCLUDE_GENRES', '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  tz: env('TZ', ''),
  // v1.3: your own posters/photos
  customDir: env('CUSTOM_DIR', '/posters'),
  customEvery: Math.max(0, parseInt(env('CUSTOM_EVERY', '4'), 10) || 0),
  customCaptions: !/^(0|false|no)$/i.test(env('CUSTOM_CAPTIONS', 'true')),
  // v1.3: coming soon from Radarr
  radarrUrl: env('RADARR_URL', '').replace(/\/+$/, ''),
  radarrKey: env('RADARR_API_KEY', ''),
  comingSoonDays: Math.max(1, parseInt(env('COMING_SOON_DAYS', '120'), 10) || 120),
  comingSoonEvery: Math.max(0, parseInt(env('COMING_SOON_EVERY', '6'), 10) || 0),
  // v1.3: trailers between posters (local files first, YouTube fallback; movie list comes from Radarr, not Plex)
  trailersEvery: Math.max(0, parseInt(env('TRAILERS_EVERY', '8'), 10) || 0),
  trailerSource: env('TRAILER_SOURCE', 'both').toLowerCase(),   // both | files | youtube
  trailerMaxSeconds: Math.max(15, parseInt(env('TRAILER_MAX_SECONDS', '150'), 10) || 150),
  trailerMuted: !/^(0|false|no)$/i.test(env('TRAILER_MUTED', 'true')),
  trailerVolume: Math.max(0, Math.min(100, parseInt(env('TRAILER_VOLUME', '60'), 10) || 0)),
  moviesDir: env('MOVIES_DIR', '/movies'),
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
if (!CFG.plexToken) log('WARNING: PLEX_TOKEN is not set; Plex requests will fail.');

async function plex(p) {
  const res = await fetch(CFG.plexUrl + p, {
    headers: { 'X-Plex-Token': CFG.plexToken, Accept: 'application/json', 'X-Plex-Client-Identifier': 'marquee-display', 'X-Plex-Product': 'Marquee' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Plex ${p} -> HTTP ${res.status}`);
  return res.json();
}

// ---------- library posters for idle mode ----------
let library = [];
async function loadLibrary() {
  try {
    const secs = (await plex('/library/sections')).MediaContainer.Directory || [];
    const wanted = secs.filter(s => s.type === 'movie' && (!CFG.libraries.length || CFG.libraries.some(n => n.toLowerCase() === String(s.title).toLowerCase())));
    const items = [];
    for (const s of wanted) {
      const mc = (await plex(`/library/sections/${s.key}/all?type=1`)).MediaContainer;
      for (const m of mc.Metadata || []) {
        if (!m.thumb) continue;
        items.push({
          key: m.ratingKey, title: m.title, year: m.year, rating: m.contentRating || '', runtime: m.duration ? Math.round(m.duration / 60000) : null, thumb: m.thumb,
          studio: CFG.showStudio ? (m.studio || '') : '', scores: CFG.showScores ? scoreLabels(m) : [],
          genres: (m.Genre || []).map(g => String(g.tag || '').toLowerCase()).filter(Boolean),
        });
      }
    }
    if (items.length) library = items;
    log(`Library loaded: ${library.length} posters from ${wanted.map(s => s.title).join(', ') || 'no movie libraries'} (${library.filter(passesFilters).length} pass the slideshow filters right now)`);
  } catch (e) { log('Library load failed:', e.message); }
}

// ---------- scores ----------
// Plex sends critic and audience ratings (0-10) plus an image hint saying where they came from.
function scoreLabel(img, val, fallback) {
  if (val === undefined || val === null || val === '' || isNaN(Number(val))) return '';
  val = Number(val); img = String(img || '');
  const pct = Math.round(val * 10) + '%';
  if (/rottentomatoes:\/\/image\.rating\.(ripe|rotten)/.test(img)) return 'Critics ' + pct;
  if (/rottentomatoes:\/\/image\.rating\.(upright|spilled)/.test(img)) return 'Audience ' + pct;
  if (/^imdb:/.test(img)) return 'IMDb ' + val.toFixed(1);
  if (/^themoviedb:/.test(img)) return 'TMDB ' + pct;
  return fallback + ' ' + val.toFixed(1);
}
function scoreLabels(m) {
  if (m.rating !== undefined && m.audienceRating !== undefined && Number(m.rating) === Number(m.audienceRating)) return [scoreLabel('', m.rating, 'Rating').replace(/ [\d.]+$/, ' ' + Math.round(Number(m.rating) * 10) + '%')];   // Plex's library listing often repeats one score in both fields
  return [scoreLabel(m.ratingImage, m.rating, 'Critics'), scoreLabel(m.audienceRatingImage, m.audienceRating, 'Audience')].filter(Boolean);
}

// ---------- idle slideshow filters ----------
const normRating = r => String(r || '').toLowerCase().replace(/^[a-z]{2}\//, '').trim();   // "gb/15" -> "15"
function hourNow() {
  try { return parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: CFG.tz || undefined }).format(new Date()), 10); }
  catch (e) { return new Date().getHours(); }
}
function ratingFilterActive() {
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(CFG.excludeRatingsHours.trim());
  if (!m) return true;
  const a = +m[1], b = +m[2], h = hourNow();
  return a <= b ? (h >= a && h < b) : (h >= a || h < b);   // supports overnight ranges like 21-07
}
function passesFilters(it) {
  if (CFG.excludeRatings.length && ratingFilterActive() && CFG.excludeRatings.includes(normRating(it.rating))) return false;
  if (CFG.includeGenres.length && !it.genres.some(g => CFG.includeGenres.includes(g))) return false;
  if (CFG.excludeGenres.length && it.genres.some(g => CFG.excludeGenres.includes(g))) return false;
  return true;
}

// ---------- your own posters/photos ----------
let custom = [];
const IMG_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
function scanCustom() {
  try {
    const files = fs.readdirSync(CFG.customDir, { withFileTypes: true })
      .filter(d => d.isFile() && IMG_EXT[path.extname(d.name).toLowerCase()] && !d.name.startsWith('.'))
      .map(d => d.name);
    const before = custom.length;
    custom = files.map(f => ({
      key: 'c:' + f,
      src: '/custom/' + encodeURIComponent(f),
      title: CFG.customCaptions ? path.basename(f, path.extname(f)).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() : '',
    }));
    if (custom.length !== before) log(`Custom posters: ${custom.length} in ${CFG.customDir}`);
  } catch (e) { if (custom.length) log('Custom folder not readable:', e.message); custom = []; }
}
function serveCustom(name, res) {
  const f = path.basename(name);   // no sub-folders, no ../
  const full = path.join(CFG.customDir, f);
  const type = IMG_EXT[path.extname(f).toLowerCase()];
  if (!type || !fs.existsSync(full)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
  fs.createReadStream(full).pipe(res);
}

// ---------- idle playlist ----------
// Each slide carries everything the page needs: picture source, heading and caption.
function movieSlide(m) {
  return { key: 'l' + m.key, src: '/img?t=' + encodeURIComponent(m.thumb), heading: CFG.headings.library, title: m.title,
    sub: [m.year ? String(m.year) : '', m.studio].filter(Boolean).join('  ·  '),
    chips: [m.rating, m.runtime ? fmtRuntime(m.runtime) : ''], scores: m.scores };
}
const fmtRuntime = mins => { const h = Math.floor(mins / 60), m = mins % 60; return h ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + 'm'; };
function buildPlaylist(n) {
  const movies = shuffle(library.filter(passesFilters)).slice(0, n).map(movieSlide);
  const extras = [];
  if (CFG.customEvery && custom.length) extras.push({ every: CFG.customEvery, items: shuffle(custom).map(c => ({ key: c.key, src: c.src, heading: CFG.headings.custom, title: c.title, sub: '', chips: [], scores: [] })) });
  for (const x of extraSources()) extras.push(x);
  const out = []; const idx = extras.map(() => 0);
  movies.forEach((m, i) => {
    out.push(m);
    extras.forEach((x, k) => { if (x.items.length && (i + 1) % x.every === 0) { out.push(x.items[idx[k] % x.items.length]); idx[k]++; } });
  });
  if (!movies.length) extras.forEach(x => out.push(...x.items));
  return out;
}
// ---------- coming soon (Radarr) ----------
let coming = [];
const extImages = new Map();   // id -> remote poster URL (kept server-side; the page only sees /ext?k=id)
const fmtDate = d => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: CFG.tz || undefined }).format(d);
async function loadComingSoon() {
  if (!CFG.radarrUrl || !CFG.radarrKey) return;
  try {
    const now = new Date(), end = new Date(now.getTime() + CFG.comingSoonDays * 864e5);
    const r = await fetch(`${CFG.radarrUrl}/api/v3/calendar?unmonitored=false&start=${now.toISOString()}&end=${end.toISOString()}`, { headers: { 'X-Api-Key': CFG.radarrKey }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const list = await r.json();
    const out = [];
    for (const m of list) {
      if (m.hasFile) continue;   // already in your library
      const img = (m.images || []).find(i => i.coverType === 'poster');
      const remote = img && (img.remoteUrl || (img.url && CFG.radarrUrl + img.url));
      if (!remote) continue;
      // Only movies that are not out yet: the release date (theaters, or digital when there is no theatrical date) must be in the future.
      // Requested older titles that just haven't been found are left off.
      const release = m.inCinemas ? ['In theaters', m.inCinemas] : m.digitalRelease ? ['On digital', m.digitalRelease] : m.physicalRelease ? ['On disc', m.physicalRelease] : null;
      if (!release || new Date(release[1]) < new Date(now.toDateString())) continue;
      const dates = [release];
      const id = 'r' + m.id;
      extImages.set(id, remote);
      const ratings = m.ratings || {};
      const scores = CFG.showScores ? [
        ratings.rottenTomatoes && ratings.rottenTomatoes.value ? 'Critics ' + Math.round(ratings.rottenTomatoes.value) + '%' : '',
        ratings.imdb && ratings.imdb.value ? 'IMDb ' + Number(ratings.imdb.value).toFixed(1) : '',
      ].filter(Boolean) : [];
      out.push({ key: 'cs:' + id, src: '/ext?k=' + id, heading: CFG.headings.comingSoon, title: m.title,
        sub: dates[0][0] + ' ' + fmtDate(new Date(dates[0][1])) + (CFG.showStudio && m.studio ? '  ·  ' + m.studio : ''),
        chips: [m.certification || '', m.runtime ? fmtRuntime(m.runtime) : ''], scores, rating: m.certification || '',
        genres: (m.genres || []).map(g => String(g).toLowerCase()) });
    }
    coming = out;
    log(`Coming soon: ${coming.length} upcoming movies from Radarr (next ${CFG.comingSoonDays} days)`);
  } catch (e) { log('Radarr coming-soon load failed:', e.message); }
}
async function warmExt(id) {
  if (imgCache.has('ext:' + id)) return;
  try {
    const r = await fetch(extImages.get(id), { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;
    const buf = Buffer.from(await r.arrayBuffer()); buf.type = r.headers.get('content-type') || 'image/jpeg';
    imgCache.set('ext:' + id, buf);
  } catch (e) {}
}
async function serveExt(id, res) {
  const remote = extImages.get(id);
  if (!remote) { res.writeHead(404); return res.end(); }
  let buf = imgCache.get('ext:' + id);
  if (!buf) {
    const headers = remote.startsWith(CFG.radarrUrl) ? { 'X-Api-Key': CFG.radarrKey } : {};
    const r = await fetch(remote, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) { res.writeHead(502); return res.end(); }
    buf = Buffer.from(await r.arrayBuffer());
    buf.type = r.headers.get('content-type') || 'image/jpeg';
    imgCache.set('ext:' + id, buf);
    if (imgCache.size > 300) imgCache.delete(imgCache.keys().next().value);
  }
  res.writeHead(200, { 'Content-Type': buf.type || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
  res.end(buf);
}

// ---------- trailers ----------
// Radarr gives the movie folder and its YouTube trailer id. A local trailer is a video file named
// "*-trailer.mp4" (or .webm/.m4v) in the movie folder, or any such video in a "Trailers" sub-folder.
// Movie folders are found under MOVIES_DIR by their folder name, so the Radarr path doesn't need to match.
let radarrMovies = [];
const trailerFiles = new Map();   // id -> absolute file path (never sent to the page)
const trailerCheck = new Map();   // radarr id -> file path or '' (cached lookups, refreshed hourly)
const VID_EXT = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm' };
async function loadRadarrMovies() {
  if (!CFG.radarrUrl || !CFG.radarrKey || !CFG.trailersEvery) return;
  try {
    const r = await fetch(`${CFG.radarrUrl}/api/v3/movie`, { headers: { 'X-Api-Key': CFG.radarrKey }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    radarrMovies = (await r.json()).filter(m => m.hasFile).map(m => ({ id: m.id, title: m.title, year: m.year, folder: path.basename(String(m.path || '')),
      yt: m.youTubeTrailerId || '', rating: m.certification || '', genres: (m.genres || []).map(g => String(g).toLowerCase()) }));
    trailerCheck.clear();
    log(`Trailers: ${radarrMovies.length} movies from Radarr, ${radarrMovies.filter(m => m.yt).length} with a YouTube trailer`);
  } catch (e) { log('Radarr movie list load failed:', e.message); }
}
function findLocalTrailer(m) {
  if (trailerCheck.has(m.id)) return trailerCheck.get(m.id);
  let found = '';
  try {
    const dir = path.join(CFG.moviesDir, m.folder);
    const isVid = f => VID_EXT[path.extname(f).toLowerCase()];
    for (const f of fs.readdirSync(dir)) { if (/[-_. ]trailer\.[a-z0-9]+$/i.test(f) && isVid(f)) { found = path.join(dir, f); break; } }
    if (!found) for (const sub of ['Trailers', 'trailers']) {
      try { const f = fs.readdirSync(path.join(dir, sub)).find(isVid); if (f) { found = path.join(dir, sub, f); break; } } catch (e) {}
    }
  } catch (e) {}
  trailerCheck.set(m.id, found);
  return found;
}
function trailerSlides(n) {
  const out = []; let lookups = 0;
  for (const m of shuffle(radarrMovies)) {
    if (out.length >= n) break;
    if (!passesFilters(m)) continue;
    // Look in at most 60 new movie folders per playlist so the array disks aren't all woken at once.
    let file = '';
    if (CFG.trailerSource !== 'youtube') { if (!trailerCheck.has(m.id)) { if (lookups >= 60) continue; lookups++; } file = findLocalTrailer(m); }
    const base = { heading: CFG.headings.trailer, title: m.title, sub: m.year ? String(m.year) : '', chips: [m.rating], scores: [], max: CFG.trailerMaxSeconds, muted: CFG.trailerMuted };
    if (file) { const id = 't' + m.id; trailerFiles.set(id, file); out.push(Object.assign({ key: 'tr:' + id, video: '/trailer?k=' + id }, base)); }
    else if (m.yt && CFG.trailerSource !== 'files') out.push(Object.assign({ key: 'yt:' + m.yt, youtube: m.yt }, base));
  }
  return out;
}
function serveTrailer(id, req, res) {
  const file = trailerFiles.get(id);
  if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const size = fs.statSync(file).size, type = VID_EXT[path.extname(file).toLowerCase()] || 'video/mp4';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const start = m[1] ? parseInt(m[1], 10) : Math.max(0, size - parseInt(m[2], 10));
    const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
}

// Extra slide sources mixed into the idle slideshow.
let extraSources = () => {
  const x = [];
  const cs = coming.filter(passesFilters);
  if (CFG.comingSoonEvery && cs.length) x.push({ every: CFG.comingSoonEvery, items: shuffle(cs) });
  if (CFG.trailersEvery && radarrMovies.length) { const t = trailerSlides(Math.ceil(200 / CFG.trailersEvery) + 1); if (t.length) x.push({ every: CFG.trailersEvery, items: t }); }
  return x;
};

// ---------- live sessions ----------
const isTheater = m => {
  if (!CFG.theaterPlayers.length) return false;
  const p = m.Player || {};
  const hay = [p.title, p.product, p.device, p.address, p.machineIdentifier].filter(Boolean).map(x => String(x).toLowerCase());
  return CFG.theaterPlayers.some(t => hay.some(h => h === t || h.includes(t)));
};
const audioLabel = a => {
  if (!a) return '';
  const codec = { truehd: 'TrueHD', eac3: 'Dolby Digital+', ac3: 'Dolby Digital', dca: 'DTS', 'dca-ma': 'DTS-HD MA', aac: 'AAC', flac: 'FLAC', opus: 'Opus' }[String(a.audioCodec || '').toLowerCase()] || String(a.audioCodec || '').toUpperCase();
  const ch = { 1: '1.0', 2: '2.0', 6: '5.1', 8: '7.1' }[a.audioChannels] || (a.audioChannels ? a.audioChannels + 'ch' : '');
  return [codec, ch].filter(Boolean).join(' ');
};
const seenUsers = new Set();
const viewerName = m => {
  const u = m.User || {};
  const raw = String(u.title || '');
  const name = CFG.userNames.get(raw.toLowerCase()) || (u.id !== undefined && CFG.userNames.get(String(u.id))) || raw;
  // Log each Plex user once so the exact names are easy to copy into USER_NAMES.
  if (raw && !seenUsers.has(raw)) { seenUsers.add(raw); log(`Viewer seen: Plex user "${raw}" (id ${u.id}) -> shown as "${name}"${CFG.hideUser ? ' (hidden: HIDE_USER=true)' : ''}`); }
  return name;
};
const resLabel = r => { r = String(r || '').toLowerCase(); return r === '4k' ? '4K' : r === 'sd' ? 'SD' : /^\d+$/.test(r) ? r + 'p' : /^\d+p$/.test(r) ? r : r.toUpperCase(); };

function shapeSession(m) {
  const media = (m.Media && m.Media[0]) || {};
  const ep = m.type === 'episode';
  return {
    id: String((m.Session && m.Session.id) || m.sessionKey || m.ratingKey),
    key: String(m.ratingKey),
    type: m.type,
    title: ep ? m.grandparentTitle : m.title,
    subtitle: ep ? `S${String(m.parentIndex).padStart(2, '0')}E${String(m.index).padStart(2, '0')} · ${m.title}` : (m.year ? String(m.year) : ''),
    thumb: ep ? (m.grandparentThumb || m.parentThumb || m.thumb) : m.thumb,
    rating: m.contentRating || '',
    studio: CFG.showStudio ? (m.studio || (ep ? '' : '')) : '',
    scores: CFG.showScores ? scoreLabels(m) : [],
    resolution: resLabel(media.videoResolution),
    hdr: /hdr|dolby vision|dovi/i.test(JSON.stringify(media.Part || '')) ? 'HDR' : '',
    audio: audioLabel(media),
    duration: m.duration || 0,
    viewOffset: m.viewOffset || 0,
    state: (m.Player && m.Player.state) || 'playing',
    user: (() => { const n = viewerName(m); return CFG.hideUser ? '' : n; })(),
    player: CFG.hideUser || CFG.hidePlayer ? '' : ((m.Player && m.Player.title) || ''),
    theater: isTheater(m),
  };
}

// ---------- F1 (Home Assistant F1 integration) ----------
// While a session is live the display shows the leader, P2/P3 with gaps, flags and short pop-ups.
// After a race or sprint it shows the winner for a while. During race week, a countdown and the
// championship standings join the idle slideshow. Read-only calls to Home Assistant.
const F1E = {
  leader: CFG.f1LeaderEntity, session: CFG.f1SessionEntity, drivers: CFG.f1DriversEntity, lap: CFG.f1LapEntity,
  p2: CFG.f1LeaderEntity.replace(/p1$/, 'p2'), p3: CFG.f1LeaderEntity.replace(/p1$/, 'p3'),
  positions: env('F1_POSITIONS_ENTITY', 'sensor.f1_drivers_driver_positions'), track: env('F1_TRACK_ENTITY', 'sensor.f1_track_status'),
  status: env('F1_STATUS_ENTITY', 'sensor.f1_session_status'), next: env('F1_NEXT_RACE_ENTITY', 'sensor.f1_next_race'),
  week: env('F1_RACE_WEEK_ENTITY', 'binary_sensor.f1_race_week'), replay: env('F1_REPLAY_ENTITY', 'sensor.f1_replay_status'), standings: env('F1_STANDINGS_ENTITY', 'sensor.f1_driver_standings'),
};
const F1_WINNER_MIN = Math.max(0, parseInt(env('F1_WINNER_MINUTES', '15'), 10) || 0);
const F1_CARDS_EVERY = Math.max(0, parseInt(env('F1_CARDS_EVERY', '8'), 10) || 0);
const F1_HEAD = { winner: env('HEADING_F1_WINNER', 'Race Winner').trim(), week: env('HEADING_F1_WEEK', 'Race Week').trim(), champ: env('HEADING_F1_STANDINGS', 'Championship').trim() };
let f1 = null;                         // what the screen shows in F1 mode
let f1Drivers = [], f1DriversAt = 0, f1Checked = 0, f1Warned = false;
let f1Replay = false, f1LastLive = null, f1LastLiveAt = 0, f1Winner = null;
let f1Pos = { at: 0, drivers: [], fastest: null }, f1Toast = null, f1Seen = { fastest: null, pit: null };
async function haState(id) {
  const r = await fetch(`${CFG.haUrl}/api/states/${id}`, { headers: { Authorization: 'Bearer ' + CFG.haToken }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + id);
  return r.json();
}
const haTry = id => haState(id).catch(() => ({ state: 'unavailable', attributes: {} }));
const isUnset = s => /^(unavailable|unknown|none|)$/i.test(String(s));
const f1Live = (st, status) => {
  if (/^(finished|finalised|finalized|ended)$/i.test(String(status || ''))) return false;
  const a = (st && st.attributes) || {};
  return a.active === true || /^(started|live|running|aborted|suspended)$/i.test(String(a.live_status || ''));
};
function f1FindDriver(leader) {
  const a = leader.attributes || {};
  const nested = Object.values(a).filter(v => v && typeof v === 'object' && !Array.isArray(v)).flatMap(o => [o.tla, o.code, o.racing_number, o.name, o.last_name]);
  const vals = [leader.state, a.tla, a.code, a.driver_code, a.racing_number, a.driver_number, a.number, a.name, a.driver, a.driver_name, a.full_name, a.last_name].concat(nested)
    .filter(v => v !== undefined && v !== null && v !== '').map(v => String(v).trim().toLowerCase());
  return f1Drivers.find(d => vals.some(v => v === String(d.tla || '').toLowerCase() || v === String(d.racing_number || '') || v === String(d.name || '').toLowerCase()
    || v === String(d.last_name || '').toLowerCase() || v === (String(d.first_name || '') + ' ' + String(d.last_name || '')).toLowerCase()));
}
const f1Name = d => [d.first_name, d.last_name].filter(Boolean).join(' ') || d.name || d.tla;
const f1Img = d => { const u = d.headshot_large || d.headshot_small; if (!u) return ''; extImages.set('f1' + d.tla, u); return '/ext?k=f1' + encodeURIComponent(d.tla); };
async function f1LoadDrivers() {
  if (f1Drivers.length && Date.now() - f1DriversAt < 3600e3) return;
  const list = ((await haState(F1E.drivers)).attributes || {}).drivers || [];
  if (!list.length) return;
  f1Drivers = list; f1DriversAt = Date.now();
  // Fetch every driver's photo ahead of time so a lead change shows instantly.
  for (const d of f1Drivers) if (f1Img(d)) warmExt('f1' + d.tla);
}
// Gaps, pit stops and the fastest lap come from the (large) driver positions sensor, read every few seconds while live.
async function f1LoadPositions(force) {
  if (!force && Date.now() - f1Pos.at < 4000) return;
  f1Pos.at = Date.now();
  const p = await haTry(F1E.positions);
  const a = p.attributes || {};
  f1Pos.drivers = (a.drivers || []).map(d => ({ tla: d.tla, pos: Number(d.current_position) || 99, gap: d.gap_to_leader || '', inPit: !!d.in_pit, out: !!(d.retired || d.stopped) }));
  f1Pos.fastest = a.fastest_lap && a.fastest_lap.tla ? { tla: a.fastest_lap.tla, time: a.fastest_lap.time || '', name: a.fastest_lap.name || a.fastest_lap.tla } : null;
}
function f1Pop(text, kind) {
  f1Toast = { text, kind, id: Date.now(), until: Date.now() + 10000 };
  log('F1: ' + text);
  setTimeout(() => { if (f1Toast && Date.now() >= f1Toast.until) { f1Toast = null; f1Publish(); } }, 10100);
}
const f1Flag = s => ({ SC: 'Safety Car', VSC: 'Virtual Safety Car', RED: 'Red Flag', YELLOW: 'Yellow Flag' })[String(s || '').toUpperCase()] || '';
async function pollF1Once() {
  try {
    const [sess, status, rp] = await Promise.all([haTry(F1E.session), haTry(F1E.status), haTry(F1E.replay)]);
    // Replay mode (F1 app plays a finished session's timing in step with a recording) counts as live.
    const replaying = /^(playing|paused|seeking)$/i.test(String(rp.state));
    const ra = rp.attributes || {};
    const sa = Object.assign({}, sess.attributes || {});
    if (replaying) {
      const sel = String(ra.selected_session || '');
      if (!sa.name && !sa.type) { const m = /(Race|Sprint Qualifying|Sprint|Qualifying|Practice \d)/i.exec(sel); sa.name = m ? m[1] : 'Race'; }
      if (!sa.meeting_name) { const m = /([A-Z][\w ]*Grand Prix)/.exec(sel); sa.meeting_name = m ? m[1] : sel; }
    }
    const race = /race|sprint/i.test(String(sa.type || sa.name || ''));
    if (f1Replay !== replaying) { log(replaying ? 'F1: replay started' + (ra.selected_session ? ' (' + ra.selected_session + ')' : '') : 'F1: replay stopped'); f1Replay = replaying; }
    const ended = /^(finished|finalised|finalized|ended)$/i.test(String(status.state));
    if (replaying ? (ended && f1LastLive) : !f1Live(sess, status.state)) {
      // Session just ended: a race or sprint gets a winner screen with the final podium.
      if (f1LastLive && !f1Winner && F1_WINNER_MIN && /race|sprint/i.test(f1LastLive.session) && Date.now() - f1LastLiveAt < 15 * 60e3) {
        f1Winner = Object.assign({}, f1LastLive, { key: 'f1w:' + f1LastLive.tla, winner: true, heading: F1_HEAD.winner, flag: '', toast: null, until: Date.now() + F1_WINNER_MIN * 60e3 });
        log(`F1: ${f1LastLive.session} finished, winner ${f1LastLive.name}`);
        setTimeout(() => { f1Winner = null; f1Publish(); }, F1_WINNER_MIN * 60e3 + 500);
      }
      if (f1 && !f1Winner) log('F1: session no longer live, back to posters');
      f1LastLive = null; f1 = f1Winner; return;
    }
    if (f1Winner) f1Winner = null;                      // a new session started
    await f1LoadDrivers();
    const [leader, p2, p3, lapSt, track] = await Promise.all([haState(F1E.leader), haTry(F1E.p2), haTry(F1E.p3), haTry(F1E.lap), haTry(F1E.track)]);
    await f1LoadPositions(false);
    if (isUnset(leader.state)) { f1 = null; return; }
    const d = f1FindDriver(leader);
    if (!d) { if (!f1Warned) { log('F1: could not match the leader to a driver:', JSON.stringify(leader.state)); f1Warned = true; } f1 = null; return; }
    const lap = /^\d+$/.test(lapSt.state) ? lapSt.state : '', laps = (lapSt.attributes || {}).total_laps || '';
    const posOf = tla => f1Pos.drivers.find(x => x.tla === tla) || {};
    const podium = [p2, p3].map((s, i) => {
      if (isUnset(s.state)) return null;
      const x = f1FindDriver(s); if (!x) return null;
      const g = race ? (/^\+/.test(posOf(x.tla).gap || '') ? posOf(x.tla).gap : '') : (s.attributes || {}).lap_time || '';
      return { pos: i + 2, tla: x.tla, name: x.last_name || x.name, team: x.team || '', color: x.team_color || '#888', gap: g || '', img: f1Img(x) };
    }).filter(Boolean);
    // Pop-ups: the leader pitting, and a new fastest lap of the race.
    const lp = posOf(d.tla);
    const pitNow = d.tla + ':' + (lp.inPit ? 'in' : 'out');
    if (race && lp.inPit && f1Seen.pit === d.tla + ':out') f1Pop('Pit stop · ' + f1Name(d), 'pit');
    f1Seen.pit = pitNow;
    const fl = f1Pos.fastest, flKey = fl ? fl.tla + fl.time : '';
    if (flKey && flKey !== f1Seen.fastest) { if (f1Seen.fastest !== null && race) { const fd = f1Drivers.find(x => x.tla === fl.tla); f1Pop('Fastest lap · ' + (fd ? f1Name(fd) : fl.name) + ' ' + fl.time, 'fastest'); } f1Seen.fastest = flKey; }
    if (!flKey && f1Seen.fastest === null) f1Seen.fastest = '';
    const next = { key: 'f1:' + d.tla, tla: d.tla, name: f1Name(d), team: d.team || '', color: d.team_color || '#e8414f',
      number: d.racing_number || '', img: f1Img(d), lap, laps, session: sa.name || sa.type || '', meeting: sa.meeting_name || '',
      podium, flag: f1Flag(track.state), toast: f1Toast && Date.now() < f1Toast.until ? { text: f1Toast.text, kind: f1Toast.kind, id: f1Toast.id } : null };
    if (!f1 || f1.key !== next.key) log(`F1: ${next.session} leader is ${next.name} (${next.team})`);
    if ((f1 ? f1.flag : '') !== next.flag) log('F1: track status ' + (next.flag || 'clear'));
    f1 = next; f1LastLive = next; f1LastLiveAt = Date.now();
  } catch (e) { if (Date.now() - f1Checked > 600e3) { log('F1: Home Assistant check failed:', e.message); f1Checked = Date.now(); } f1 = f1Winner; }
}
const f1Sig = () => f1 ? JSON.stringify([f1.key, f1.lap, f1.flag, f1.toast && f1.toast.id, (f1.podium || []).map(p => p.tla + p.gap)]) : '';
let f1Busy = false, f1Again = false;
async function pollF1() {
  if (f1Busy) { f1Again = true; return; }
  f1Busy = true;
  const before = f1Sig();
  try { await pollF1Once(); } finally {
    f1Busy = false;
    if (f1Sig() !== before) recompute();
    if (f1Again) { f1Again = false; pollF1(); }
  }
}
function f1Publish() { if (f1Winner === null && f1 && f1.winner) f1 = null; if (f1 && !f1.winner) f1.toast = f1Toast && Date.now() < f1Toast.until ? { text: f1Toast.text, kind: f1Toast.kind, id: f1Toast.id } : null; recompute(); }

// ---- race week cards for the idle slideshow (drawn as SVG posters) ----
let f1Cards = [], f1CardSvg = new Map();
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
async function dataUri(id) { await warmExt(id); const b = imgCache.get('ext:' + id); return b ? `data:${b.type || 'image/png'};base64,${b.toString('base64')}` : ''; }
const fmtWhen = d => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: CFG.tz || undefined }).format(d);
function untilText(ms) {
  if (ms <= 0) return 'Starting now';
  const m = Math.round(ms / 60000), dd = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return dd ? `in ${dd}d ${h}h` : h ? `in ${h}h ${mm}m` : `in ${mm}m`;
}
const svgWrap = body => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1000 1500" width="1000" height="1500" font-family="Inter, Roboto, 'Segoe UI', Arial, sans-serif">`
  + `<defs><radialGradient id="g" cx="50%" cy="42%" r="65%"><stop offset="0" stop-color="#e8414f" stop-opacity=".28"/><stop offset="1" stop-color="#e8414f" stop-opacity="0"/></radialGradient></defs>`
  + `<rect width="1000" height="1500" rx="28" fill="#101218"/><rect width="1000" height="1500" rx="28" fill="url(#g)"/>${body}</svg>`;
async function buildF1Cards() {
  if (!CFG.haUrl || !CFG.haToken || !F1_CARDS_EVERY) { f1Cards = []; return; }
  try {
    const [week, nx, st] = await Promise.all([haTry(F1E.week), haTry(F1E.next), haTry(F1E.standings)]);
    await f1LoadDrivers().catch(() => {});
    const cards = [];
    if (week.state === 'on') {
      const a = nx.attributes || {}, start = new Date(a.race_start_utc || nx.state);
      if (!isNaN(start) && start.getTime() > Date.now() - 2 * 3600e3) {
        let outline = '';
        if (a.circuit_outline_url) { extImages.set('f1circuit', a.circuit_outline_url); outline = await dataUri('f1circuit'); }
        const when = fmtWhen(start), until = untilText(start.getTime() - Date.now());
        f1CardSvg.set('next', svgWrap(
          `<text x="500" y="150" text-anchor="middle" fill="#9aa0aa" font-size="34" font-weight="600" letter-spacing="10">ROUND ${esc(a.round || '')}</text>`
          + (outline ? `<image x="110" y="230" width="780" height="620" preserveAspectRatio="xMidYMid meet" href="${outline}" xlink:href="${outline}"/>` : '')
          + `<text x="500" y="985" text-anchor="middle" fill="#f4f5f7" font-size="64" font-weight="800">${esc(String(a.race_name || '').replace(/ Grand Prix$/, ''))}</text>`
          + `<text x="500" y="1050" text-anchor="middle" fill="#f4f5f7" font-size="40" font-weight="600" letter-spacing="6">GRAND PRIX</text>`
          + `<text x="500" y="1150" text-anchor="middle" fill="#9aa0aa" font-size="36">${esc(a.circuit_name || '')}</text>`
          + `<text x="500" y="1290" text-anchor="middle" fill="#f4f5f7" font-size="52" font-weight="700">${esc(when)}</text>`
          + `<text x="500" y="1370" text-anchor="middle" fill="#e8414f" font-size="44" font-weight="700">${esc(until)}</text>`));
        cards.push({ key: 'f1c:next:' + until, src: '/f1card?k=next&v=' + encodeURIComponent(until), heading: F1_HEAD.week, title: a.race_name || 'Next race',
          sub: when, chips: ['Round ' + (a.round || ''), until], scores: [] });
      }
      const list = ((st.attributes || {}).driver_standings || []).slice(0, 5);
      if (list.length) {
        const rows = await Promise.all(list.map(async (s, i) => {
          const code = (s.Driver || {}).code || '', dr = f1Drivers.find(x => x.tla === code) || {};
          const img = dr.tla ? await dataUri('f1' + dr.tla) : '';
          const y = 300 + i * 230, col = dr.team_color || '#888';
          const name = (s.Driver || {}).familyName || dr.last_name || code;   // last name only, so it never runs into the points
          const team = ((s.Constructors || [])[0] || {}).name || dr.team || '';
          return `<rect x="70" y="${y}" width="860" height="200" rx="22" fill="#171a22"/><rect x="70" y="${y}" width="12" height="200" rx="6" fill="${esc(col)}"/>`
            + `<text x="150" y="${y + 125}" text-anchor="middle" fill="#f4f5f7" font-size="64" font-weight="800">${esc(s.position)}</text>`
            + (img ? `<image x="215" y="${y + 10}" width="180" height="180" preserveAspectRatio="xMidYMid slice" href="${img}" xlink:href="${img}"/>` : '')
            + `<text x="420" y="${y + 92}" fill="#f4f5f7" font-size="44" font-weight="700">${esc(name)}</text>`
            + `<text x="420" y="${y + 148}" fill="#9aa0aa" font-size="32">${esc(team)}</text>`
            + `<text x="900" y="${y + 92}" text-anchor="end" fill="#f4f5f7" font-size="48" font-weight="800">${esc(s.points)}</text>`
            + `<text x="900" y="${y + 148}" text-anchor="end" fill="#9aa0aa" font-size="28" letter-spacing="4">PTS</text>`;
        }));
        f1CardSvg.set('standings', svgWrap(`<text x="500" y="170" text-anchor="middle" fill="#f4f5f7" font-size="56" font-weight="800">Driver Standings</text>`
          + `<text x="500" y="230" text-anchor="middle" fill="#9aa0aa" font-size="32" letter-spacing="6">AFTER ROUND ${esc((st.attributes || {}).round || '')}</text>` + rows.join('')));
        const top = list[0], topName = [(top.Driver || {}).givenName, (top.Driver || {}).familyName].filter(Boolean).join(' ');
        cards.push({ key: 'f1c:standings:' + list.map(s => (s.Driver || {}).code + s.points).join(','), src: '/f1card?k=standings&v=' + encodeURIComponent((st.attributes || {}).round || ''),
          heading: F1_HEAD.champ, title: 'Driver standings', sub: `${topName} leads with ${top.points} points`, chips: ['After round ' + ((st.attributes || {}).round || '')], scores: [] });
      }
    }
    if (cards.length && !f1Cards.length) log(`F1: race week, ${cards.length} F1 card${cards.length > 1 ? 's' : ''} added to the slideshow`);
    f1Cards = cards;
  } catch (e) { log('F1: race week cards failed:', e.message); }
}
function serveF1Card(k, res) {
  const svg = f1CardSvg.get(k);
  if (!svg) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
  res.end(svg);
}
{ const base = extraSources; extraSources = () => { const x = base(); if (F1_CARDS_EVERY && f1Cards.length) x.push({ every: F1_CARDS_EVERY, items: f1Cards.slice() }); return x; }; }

// Home Assistant pushes changes to the top three, session, flag and lap sensors over its websocket, so a lead change
// reaches the screen within about a second. The 30 second check above is only a fallback.
let haWsDelay = 5000, haWsWarned = false;
function haWatch() {
  if (typeof WebSocket !== 'function') return;
  let ws, timer = null;
  try { ws = new WebSocket(CFG.haUrl.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/api/websocket'); } catch (e) { return setTimeout(haWatch, 60000); }
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: CFG.haToken }));
    else if (m.type === 'auth_invalid') { log('F1: Home Assistant rejected the token for live updates'); ws.close(); }
    else if (m.type === 'auth_ok') {
      haWsDelay = 5000; haWsWarned = false;
      ws.send(JSON.stringify({ id: 1, type: 'subscribe_entities', entity_ids: [F1E.leader, F1E.p2, F1E.p3, F1E.session, F1E.status, F1E.lap, F1E.track, F1E.replay] }));
      log('F1: live updates from Home Assistant connected');
    } else if (m.type === 'event') { clearTimeout(timer); timer = setTimeout(pollF1, 250); }
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    if (!haWsWarned) { log('F1: live updates from Home Assistant disconnected, retrying'); haWsWarned = true; }
    setTimeout(haWatch, haWsDelay); haWsDelay = Math.min(haWsDelay * 2, 300000);
  };
}

let state = { mode: 'idle', sessions: [], at: Date.now() };
let signature = '';
const clients = new Set();

function broadcast() {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(payload);
}

async function poll() {
  try {
    const mc = (await plex('/status/sessions')).MediaContainer;
    const all = (mc.Metadata || []).filter(m => m.type === 'movie' || m.type === 'episode').map(shapeSession);
    plexAll = all;
    recompute();
  } catch (e) { log('Session poll failed:', e.message); }
}
let plexAll = [];
// Works out what the screen should show from the last Plex poll and the F1 state, and pushes it if it changed.
function recompute() {
  {
    const all = plexAll;
    const theaterOn = all.some(s => s.theater);
    // Paused streams are skipped so the slideshow keeps going; the theater still goes black while paused.
    const shown = all.filter(s => s.state !== 'paused' && (!s.theater || CFG.theaterMode === 'poster'));
    const mode = theaterOn && CFG.theaterMode === 'black' ? 'black' : f1 ? 'f1' : (shown.length ? 'playing' : 'idle');
    // Only what changes the picture goes in the signature; progress is interpolated client-side.
    const sig = mode + '|' + f1Sig() + '|' + shown.map(s => [s.id, s.key, s.state, s.resolution, s.audio, s.user, s.player].join(':')).join(',');
    // Re-sync progress occasionally (seek/pause drift) without forcing a redraw of the poster.
    const drift = shown.some(s => { const o = state.sessions.find(x => x.id === s.id); return o && Math.abs((o.viewOffset + (o.state === 'playing' ? Date.now() - state.at : 0)) - s.viewOffset) > 15000; });
    if (sig !== signature || drift) {
      signature = sig;
      const prevMode = state.mode;
      state = { mode, sessions: mode === 'playing' ? shown : [], f1: mode === 'f1' ? f1 : null, at: Date.now() };
      broadcast();
      if (mode !== 'f1' || prevMode !== 'f1') log(`State -> ${mode}${mode === 'playing' ? ': ' + shown.map(s => s.title + ' [' + s.state + ']').join(', ') : ''}`);
    }
  }
}

// ---------- image proxy (token never reaches the browser) ----------
const imgCache = new Map();
async function image(thumb, res) {
  if (!/^\/library\/(metadata|collections)\/[\w/]+$/.test(thumb)) { res.writeHead(400); return res.end(); }
  let buf = imgCache.get(thumb);
  if (!buf) {
    const url = `/photo/:/transcode?width=${CFG.posterWidth}&height=${Math.round(CFG.posterWidth * 1.5)}&minSize=1&upscale=1&url=${encodeURIComponent(thumb)}`;
    const r = await fetch(CFG.plexUrl + url, { headers: { 'X-Plex-Token': CFG.plexToken }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) { res.writeHead(502); return res.end(); }
    buf = Buffer.from(await r.arrayBuffer());
    imgCache.set(thumb, buf);
    if (imgCache.size > 300) imgCache.delete(imgCache.keys().next().value);
  }
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
  res.end(buf);
}

// ---------- http ----------
const PUB = path.join(__dirname, 'public');
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`retry: 5000\ndata: ${JSON.stringify(state)}\n\n`);
      clients.add(res);
      const ka = setInterval(() => res.write(': ka\n\n'), 25000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }
    if (u.pathname === '/api/config') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ slideSeconds: CFG.slideSeconds, showScores: CFG.showScores, showTitle: CFG.showTitle, theaterName: CFG.theaterName, rotate: CFG.rotate, headings: CFG.headings, trailerVolume: CFG.trailerVolume })); }
    if (u.pathname === '/api/library') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(buildPlaylist(200))); }
    if (u.pathname === '/trailer') return serveTrailer(u.searchParams.get('k') || '', req, res);
    if (u.pathname === '/ext') return await serveExt(u.searchParams.get('k') || '', res);
    if (u.pathname === '/f1card') return serveF1Card(u.searchParams.get('k') || '', res);
    if (u.pathname.startsWith('/custom/')) return serveCustom(decodeURIComponent(u.pathname.slice(8)), res);
    if (u.pathname === '/img') return await image(u.searchParams.get('t') || '', res);
    if (u.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
    const file = u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^([/\\])+/, '');
    const full = path.join(PUB, file);
    if (!full.startsWith(PUB) || !fs.existsSync(full)) { res.writeHead(404); return res.end('not found'); }
    const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }[path.extname(full)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    fs.createReadStream(full).pipe(res);
  } catch (e) { log('Request error', u.pathname, e.message); if (!res.headersSent) res.writeHead(500); res.end(); }
}).listen(CFG.port, () => log(`Marquee listening on :${CFG.port} (theater name: ${CFG.theaterName || 'none'}, rotate: ${CFG.rotate}, Plex ${CFG.plexUrl}, theater players: ${CFG.theaterPlayers.join(', ') || 'none'}, theater mode: ${CFG.theaterMode}, show viewer: ${!CFG.hideUser}, friendly names: ${CFG.userNames.size}, scores: ${CFG.showScores}, filters: ${[CFG.excludeRatings.length && 'ratings', CFG.includeGenres.length && 'include genres', CFG.excludeGenres.length && 'exclude genres'].filter(Boolean).join(', ') || 'none'}, custom every ${CFG.customEvery})`));

loadLibrary();
setInterval(loadLibrary, 60 * 60 * 1000);
scanCustom();
setInterval(scanCustom, 5 * 60 * 1000);
loadComingSoon();
setInterval(loadComingSoon, 60 * 60 * 1000);
loadRadarrMovies();
setInterval(loadRadarrMovies, 60 * 60 * 1000);
poll();
setInterval(poll, CFG.pollSeconds * 1000);
if (CFG.f1Leader && CFG.haUrl && CFG.haToken) {
  pollF1(); haWatch();
  setInterval(() => { if (f1 && !f1.winner) f1LoadPositions(true).then(pollF1, () => {}); else pollF1(); }, 5000);   // gaps and pit stops; also the fallback if live updates drop
  buildF1Cards(); setInterval(buildF1Cards, 10 * 60 * 1000);
}
