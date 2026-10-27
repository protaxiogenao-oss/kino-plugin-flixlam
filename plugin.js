/// <reference path="./kino.d.ts" />
/**
 * FlixLatam plugin for Kino — v1.0.0
 * Series, películas y anime en latino (flixlatam.com)
 * Home: Últimos episodios, Películas, Series, Anime, Populares
 * Audio + servidores manuales vía alternatives
 */

const BASE = "https://flixlatam.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function hdr(extra) {
  var h = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.5",
    Referer: BASE + "/",
  };
  if (extra) {
    for (var k in extra) h[k] = extra[k];
  }
  return h;
}

async function get(path, referer) {
  var url = path.indexOf("http") === 0 ? path : BASE + path;
  var r = await kino.fetch(url, {
    headers: hdr(referer ? { Referer: referer } : null),
    timeoutMs: 20000,
  });
  if (!r.ok) {
    throw kino.error("unavailable", "http " + r.status, {
      userMessage: "No se pudo cargar la página (" + r.status + ").",
    });
  }
  return await r.text();
}

function strip(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function abs(u) {
  if (!u) return "";
  if (u.indexOf("//") === 0) return "https:" + u;
  if (u.indexOf("http") === 0) return u;
  if (u.charAt(0) === "/") return BASE + u;
  return BASE + "/" + u;
}

function makeId(s) {
  return String(s || "x")
    .replace(/[^A-Za-z0-9._~-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[áàäâ]/g, "a")
    .replace(/[éèëê]/g, "e")
    .replace(/[íìïî]/g, "i")
    .replace(/[óòöô]/g, "o")
    .replace(/[úùüû]/g, "u")
    .replace(/ñ/g, "n")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rank(items, q) {
  var nq = norm(q);
  if (!nq) return items;
  var scored = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var nt = norm(it.title);
    var score = 0;
    if (nt === nq) score = 1000;
    else if (nt.indexOf(nq) === 0) score = 800;
    else if (nt.indexOf(nq) >= 0) score = 500;
    else {
      var words = nq.split(" ");
      var hit = 0;
      for (var w = 0; w < words.length; w++) {
        if (words[w].length > 1 && nt.indexOf(words[w]) >= 0) hit++;
      }
      score = hit * 120;
    }
    if (score > 0) scored.push({ it: it, score: score });
  }
  scored.sort(function (a, b) {
    return b.score - a.score;
  });
  var out = [];
  for (var j = 0; j < scored.length; j++) out.push(scored[j].it);
  return out;
}

function kindFromUrl(u) {
  if (/\/pelicula\//i.test(u)) return "movie";
  if (/\/anime\//i.test(u)) return "series";
  return "series";
}

function pathFromUrl(u) {
  try {
    var m = String(u).match(/flixlatam\.com(\/[^?#]*)/i);
    if (m) return m[1];
    if (u.charAt(0) === "/") return u.split("?")[0];
  } catch (e) {}
  return u;
}

/** Parse catalog / search cards: article.item */
function parseItems(html) {
  var items = [];
  var seen = {};
  var re =
    /<article[^>]*class="([^"]*)"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[\s\S]*?<img[^>]+src="([^"]+)"[^>]*(?:alt="([^"]*)")?[\s\S]*?(?:<h3[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>|<\/article>)/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var href = abs(m[2]);
    if (!/flixlatam\.com\/(serie|anime|pelicula)\//i.test(href)) continue;
    // skip episode deep links in catalog
    if (/\/temporada\/|\/capitulo\//i.test(href)) {
      // map episode card to series root
      var root = href.replace(/\/temporada\/.*$/i, "");
      href = root;
    }
    var path = pathFromUrl(href);
    if (seen[path]) continue;
    seen[path] = true;

    var title = strip(m[5] || m[4] || "");
    if (!title) {
      var slug = path.split("/").pop() || "";
      title = slug.replace(/-[a-zA-Z0-9]{5,}$/, "").replace(/-/g, " ");
    }
    // clean "Ver X online"
    title = title.replace(/^Ver\s+/i, "").replace(/\s+online$/i, "").trim();

    var poster = abs(m[3]);
    var kind = kindFromUrl(href);
    items.push({
      id: makeId(path.replace(/^\//, "").replace(/\//g, "-")),
      ref: path,
      title: title,
      kind: kind,
      poster: poster,
      backdrop: poster,
      genres: kind === "movie" ? ["movies"] : /\/anime\//i.test(href) ? ["anime"] : ["series"],
    });
  }

  // Fallback simpler pattern
  if (items.length === 0) {
    var re2 =
      /href="((?:https:\/\/flixlatam\.com)?\/(?:serie|anime|pelicula)\/[^"/?#]+)"[^>]*>[\s\S]{0,400}?<img[^>]+src="([^"]+)"[^>]*(?:alt="([^"]*)")?/gi;
    while ((m = re2.exec(html)) !== null) {
      var href2 = abs(m[1]);
      var path2 = pathFromUrl(href2);
      if (seen[path2] || /\/temporada\/|\/capitulo\//i.test(path2)) continue;
      seen[path2] = true;
      var title2 = strip(m[3] || "");
      if (!title2) {
        var slug2 = path2.split("/").pop() || "";
        title2 = slug2.replace(/-[a-zA-Z0-9]{5,}$/, "").replace(/-/g, " ");
      }
      title2 = title2.replace(/^Ver\s+/i, "").replace(/\s+online$/i, "").trim();
      items.push({
        id: makeId(path2.replace(/^\//, "").replace(/\//g, "-")),
        ref: path2,
        title: title2,
        kind: kindFromUrl(href2),
        poster: abs(m[2]),
        backdrop: abs(m[2]),
      });
    }
  }
  return items;
}

/** Últimos episodios: link to specific cap, show as series item pointing to series root */
function parseLatestEpisodes(html) {
  var items = [];
  var seen = {};
  var re =
    /<article[^>]*class="[^"]*item[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+\/(?:serie|anime)\/[^"]+\/temporada\/\d+\/capitulo\/\d+)"[\s\S]*?<img[^>]+src="([^"]+)"[^>]*(?:alt="([^"]*)")?[\s\S]*?(?:<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>|<div class="data">[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>)/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var href = abs(m[1]);
    var path = pathFromUrl(href);
    if (seen[path]) continue;
    seen[path] = true;

    var poster = abs(m[2]);
    var alt = strip(m[3] || "");
    var title = strip(m[4] || m[5] || alt);
    // episode badge T2E19
    var badge = "";
    var bm = path.match(/\/temporada\/(\d+)\/capitulo\/(\d+)/i);
    if (bm) badge = "T" + bm[1] + "E" + bm[2];
    if (title && badge && title.indexOf(badge) < 0 && !/T\d+/.test(title)) {
      title = title + " — " + badge;
    }
    if (!title) title = alt || path;

    // ref to series root so episodes() lists all
    var seriesPath = path.replace(/\/temporada\/.*$/i, "");
    items.push({
      id: makeId(path.replace(/^\//, "").replace(/\//g, "-")),
      ref: seriesPath,
      title: title,
      kind: "series",
      poster: poster,
      backdrop: poster,
      badges: badge ? [badge] : undefined,
      genres: /\/anime\//i.test(path) ? ["anime"] : ["series"],
    });
  }

  // looser fallback
  if (items.length === 0) {
    var re2 =
      /href="([^"]+\/(?:serie|anime)\/[^"]+\/temporada\/(\d+)\/capitulo\/(\d+))"[^>]*>[\s\S]{0,500}?<img[^>]+src="([^"]+)"[^>]*(?:alt="([^"]*)")?/gi;
    while ((m = re2.exec(html)) !== null) {
      var href2 = abs(m[1]);
      var path2 = pathFromUrl(href2);
      if (seen[path2]) continue;
      seen[path2] = true;
      var series2 = path2.replace(/\/temporada\/.*$/i, "");
      var badge2 = "T" + m[2] + "E" + m[3];
      var title2 = strip(m[5] || "");
      if (title2 && title2.indexOf(badge2) < 0) title2 = title2 + " — " + badge2;
      if (!title2) title2 = badge2;
      items.push({
        id: makeId(path2.replace(/^\//, "").replace(/\//g, "-")),
        ref: series2,
        title: title2,
        kind: "series",
        poster: abs(m[4]),
        backdrop: abs(m[4]),
        badges: [badge2],
      });
    }
  }
  return items;
}

function parsePageItems(html, basePath) {
  var items = parseItems(html);
  var next = null;
  var pageM = html.match(/href="([^"]*[?&]page=(\d+)[^"]*)"[^>]*>\s*(?:›|»|Siguiente|Next)/i);
  if (pageM) {
    next = pageM[1];
    if (next.indexOf("http") !== 0 && next.charAt(0) !== "/") next = basePath + next;
  } else {
    // numbered pagination: current page + 1
    var cur = 1;
    var curM = (basePath || "").match(/[?&]page=(\d+)/);
    if (curM) cur = parseInt(curM[1], 10);
    if (html.indexOf("page=" + (cur + 1)) >= 0 || html.indexOf("?page=" + (cur + 1)) >= 0) {
      var bp = (basePath || "/").split("?")[0];
      next = bp + "?page=" + (cur + 1);
    }
  }
  return { items: items, next: next };
}

/** Player options: name + iframe src */
function parsePlayers(html) {
  var players = [];
  // titles in order
  var titles = [];
  var tr = /id="playerOptions"[\s\S]*?<\/ul>/i.exec(html);
  if (tr) {
    var tm;
    var reT = /<span class="title">([^<]+)<\/span>/gi;
    while ((tm = reT.exec(tr[0])) !== null) titles.push(strip(tm[1]));
  }
  // iframes in player-* boxes
  var iframes = [];
  var ir = /id="player-(\d+)"[\s\S]*?<iframe[^>]+src=["']([^"']+)["']/gi;
  var im;
  while ((im = ir.exec(html)) !== null) {
    iframes.push({ idx: parseInt(im[1], 10), src: abs(im[2]) });
  }
  iframes.sort(function (a, b) {
    return a.idx - b.idx;
  });
  for (var i = 0; i < iframes.length; i++) {
    players.push({
      name: titles[i] || "Servidor " + (i + 1),
      url: iframes[i].src,
    });
  }
  // fallback any iframe
  if (players.length === 0) {
    var any = /<iframe[^>]+src=["']([^"']+)["']/gi;
    var am;
    var n = 0;
    while ((am = any.exec(html)) !== null) {
      var src = abs(am[1]);
      if (/vidurl|embed69|waaw|player|video/i.test(src)) {
        players.push({ name: "Servidor " + ++n, url: src });
      }
    }
  }
  return players;
}

function langLabel(code) {
  var c = String(code || "").toUpperCase();
  if (c === "LAT" || c === "LA" || c === "LATINO") return "Latino";
  if (c === "ESP" || c === "ES" || c === "CAST" || c === "CASTELLANO") return "Castellano";
  if (c === "SUB" || c === "VOSE" || c === "SUBS") return "Subtitulado";
  if (c === "ENG" || c === "EN" || c === "ENG") return "Inglés";
  return c || "Audio";
}

function serverLabel(name) {
  var n = String(name || "").toLowerCase();
  if (/streamwish|wish/.test(n)) return "Streamwish";
  if (/voe/.test(n)) return "Voe";
  if (/filemoon|moon/.test(n)) return "Filemoon";
  if (/vidhide|hide/.test(n)) return "Vidhide";
  if (/dood/.test(n)) return "Doodstream";
  if (/embed69|embed/.test(n)) return "Embed69";
  if (/moe/.test(n)) return "Moe";
  if (/netu|waaw|hqq/.test(n)) return "Netu";
  return name || "Servidor";
}

/** Prefer order helpers */
function preferScore(label, preferLang, preferServer) {
  var s = 0;
  var L = String(preferLang || "auto").toUpperCase();
  var S = String(preferServer || "auto").toLowerCase();
  var lab = String(label || "").toLowerCase();
  if (L !== "AUTO") {
    if (L === "LAT" && /latino/.test(lab)) s += 100;
    if (L === "ESP" && /castellano/.test(lab)) s += 100;
    if (L === "SUB" && /subtit/.test(lab)) s += 100;
    if (L === "ENG" && /ingl[eé]s|english/.test(lab)) s += 100;
  } else {
    if (/latino/.test(lab)) s += 50;
  }
  if (S !== "auto") {
    if (lab.indexOf(S) >= 0) s += 40;
  }
  if (/streamwish/.test(lab)) s += 5;
  if (/voe/.test(lab)) s += 4;
  if (/filemoon/.test(lab)) s += 3;
  return s;
}

async function captureStream(pageUrl, referer) {
  if (!kino.browser || !kino.browser.capture) return null;
  try {
    var cap = await kino.browser.capture(pageUrl, {
      timeoutMs: 25000,
      headers: hdr({ Referer: referer || BASE + "/" }),
    });
    var urls = (cap && (cap.urls || cap.streams || cap)) || [];
    if (!Array.isArray(urls)) urls = [];
    // prefer m3u8 then mp4
    var best = null;
    for (var i = 0; i < urls.length; i++) {
      var u = typeof urls[i] === "string" ? urls[i] : urls[i].url || urls[i].src;
      if (!u) continue;
      if (/\.m3u8(\?|$)/i.test(u)) return { url: u, mime: "application/x-mpegURL" };
      if (/\.mp4(\?|$)/i.test(u) && !best) best = { url: u, mime: "video/mp4" };
      if (!best && /video|stream|play/i.test(u)) best = { url: u };
    }
    return best;
  } catch (e) {
    return null;
  }
}

async function tryDirectFromEmbed(embedUrl) {
  // Some hosts expose file in HTML without PoW when fetched with right UA
  try {
    var html = await get(embedUrl, BASE + "/");
    var m3u = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
    if (m3u) return { url: m3u[0].replace(/\\u0026/g, "&"), mime: "application/x-mpegURL" };
    var mp4 = html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
    if (mp4) return { url: mp4[0].replace(/\\u0026/g, "&"), mime: "video/mp4" };
    // jwplayer / sources
    var file = html.match(/["']file["']\s*:\s*["'](https?:\/\/[^"']+)["']/i);
    if (file) {
      var fu = file[1].replace(/\\u0026/g, "&");
      return {
        url: fu,
        mime: /\.m3u8/i.test(fu) ? "application/x-mpegURL" : "video/mp4",
      };
    }
  } catch (e) {}
  return null;
}

export async function search(query) {
  var q = (query && query.q) || "";
  if (!q || !String(q).trim()) return [];
  var page = 1;
  if (query.cursor) {
    var cm = String(query.cursor).match(/page=(\d+)/);
    if (cm) page = parseInt(cm[1], 10);
  }
  var path = "/search?s=" + encodeURIComponent(String(q).trim());
  if (page > 1) path += "&page=" + page;
  var html = await get(path);
  var parsed = parsePageItems(html, path);
  var items = rank(parsed.items, q);
  if (parsed.next) {
    return { items: items, next: parsed.next };
  }
  return items;
}

export async function home() {
  var html = await get("/");
  var rows = [];

  var latest = parseLatestEpisodes(html);
  if (latest.length) {
    rows.push({
      id: "ultimos-episodios",
      title: "Últimos episodios",
      items: latest.slice(0, 24),
      ref: "/?section=ultimos",
      genre: "series",
    });
  }

  // Split remaining sections by headers in HTML order
  // Películas / Series / Anime blocks
  function sectionItems(label) {
    var idx = html.search(new RegExp("<h[12][^>]*>\\s*(?:<[^>]+>\\s*)*" + label, "i"));
    if (idx < 0) return [];
    var chunk = html.slice(idx, idx + 25000);
    return parseItems(chunk).slice(0, 24);
  }

  var pelis = sectionItems("Películas");
  if (!pelis.length) {
    try {
      var ph = await get("/peliculas");
      pelis = parseItems(ph).slice(0, 24);
    } catch (e) {}
  }
  if (pelis.length) {
    rows.push({
      id: "peliculas",
      title: "Películas",
      items: pelis,
      ref: "/peliculas",
      genre: "peliculas",
    });
  }

  var series = sectionItems("Series");
  if (!series.length) {
    try {
      var sh = await get("/series");
      series = parseItems(sh).slice(0, 24);
    } catch (e) {}
  }
  if (series.length) {
    rows.push({
      id: "series",
      title: "Series",
      items: series,
      ref: "/series",
      genre: "series",
    });
  }

  var anime = sectionItems("Anime");
  if (!anime.length) {
    try {
      var ah = await get("/animes");
      anime = parseItems(ah).slice(0, 24);
    } catch (e) {}
  }
  if (anime.length) {
    rows.push({
      id: "anime",
      title: "Anime",
      items: anime,
      ref: "/animes",
      genre: "anime",
    });
  }

  // Populares
  try {
    var pop = await get("/series/populares");
    var popItems = parseItems(pop).slice(0, 24);
    if (popItems.length) {
      rows.push({
        id: "populares",
        title: "Series populares",
        items: popItems,
        ref: "/series/populares",
        genre: "series",
      });
    }
  } catch (e) {}

  if (rows.length === 0 && latest.length === 0) {
    // last resort: any items on home
    var any = parseItems(html).slice(0, 24);
    if (any.length) {
      rows.push({ id: "inicio", title: "Inicio", items: any, ref: "/" });
    }
  }
  return rows;
}

export async function browse(ref, cursor) {
  var path = ref || "/";
  if (cursor) path = cursor;
  if (path.indexOf("http") === 0) path = pathFromUrl(path);
  if (path === "/?section=ultimos") {
    var h = await get("/");
    var latest = parseLatestEpisodes(h);
    return { items: latest, next: null };
  }
  var html = await get(path);
  var parsed = parsePageItems(html, path);
  return { items: parsed.items, next: parsed.next || undefined };
}

export async function episodes(ref) {
  var path = ref;
  if (path.indexOf("http") === 0) path = pathFromUrl(path);
  // normalize to series/anime root
  path = path.replace(/\/temporada\/.*$/i, "").replace(/\/$/, "");
  var html = await get(path);

  var title = "";
  var tm = html.match(/<title>([^<]+)/i);
  if (tm) {
    title = strip(tm[1])
      .replace(/\s*-\s*FLIXLATAM.*$/i, "")
      .replace(/^Ver\s+/i, "")
      .replace(/\s+Online.*$/i, "")
      .trim();
  }
  var poster = "";
  var pm = html.match(/class="poster"[\s\S]{0,400}?<img[^>]+src="([^"]+)"/i);
  if (pm) poster = abs(pm[1]);
  var overview = "";
  var om = html.match(/class="wp-content"[^>]*>([\s\S]*?)<\/div>/i);
  if (om) overview = strip(om[1]).slice(0, 600);

  var eps = [];
  var seen = {};
  var re =
    /href="((?:https:\/\/flixlatam\.com)?(\/(?:serie|anime)\/[^"]+\/temporada\/(\d+)\/capitulo\/(\d+)))"/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var full = pathFromUrl(abs(m[1]));
    var season = parseInt(m[3], 10);
    var number = parseInt(m[4], 10);
    var key = season + "x" + number;
    if (seen[key]) continue;
    seen[key] = true;
    eps.push({
      season: season,
      number: number,
      ref: "ep:" + full,
      title: "T" + season + "E" + number,
    });
  }
  eps.sort(function (a, b) {
    if (a.season !== b.season) return a.season - b.season;
    return a.number - b.number;
  });

  // movie: no episodes — resolve will use the same ref
  if (eps.length === 0 && /\/pelicula\//i.test(path)) {
    return {
      series: { title: title, poster: poster, overview: overview },
      episodes: [
        {
          season: 1,
          number: 1,
          ref: "ep:" + path,
          title: title || "Película",
        },
      ],
    };
  }

  return {
    series: {
      title: title || undefined,
      poster: poster || undefined,
      overview: overview || undefined,
    },
    episodes: eps,
  };
}

export async function resolve(ref) {
  var path = ref;
  var isLazy = false;
  var forcePlayer = null;

  if (String(ref).indexOf("play:") === 0) {
    // play:<base64url of player url>|<label>
    isLazy = true;
    var raw = String(ref).slice(5);
    var parts = raw.split("|");
    path = parts[0];
    try {
      // not real b64url always — we store absolute URL encoded
      path = decodeURIComponent(parts[0]);
    } catch (e) {
      path = parts[0];
    }
    forcePlayer = path;
  } else if (String(ref).indexOf("ep:") === 0) {
    path = String(ref).slice(3);
  }

  if (path.indexOf("http") === 0 && path.indexOf("flixlatam.com") < 0) {
    // direct embed resolve
    forcePlayer = path;
  } else if (path.indexOf("http") === 0) {
    path = pathFromUrl(path);
  }

  var preferLang = "LAT";
  var preferServer = "auto";
  try {
    if (kino.config) {
      preferLang = kino.config.preferLang || preferLang;
      preferServer = kino.config.preferServer || preferServer;
    }
  } catch (e) {}

  // Resolve a specific embed/player URL
  if (forcePlayer) {
    var direct = await tryDirectFromEmbed(forcePlayer);
    if (direct && direct.url) {
      return {
        url: direct.url,
        mime: direct.mime,
        headers: { Referer: forcePlayer, "User-Agent": UA },
        label: "Directo",
      };
    }
    var cap = await captureStream(forcePlayer, BASE + "/");
    if (cap && cap.url) {
      return {
        url: cap.url,
        mime: cap.mime,
        headers: { Referer: forcePlayer, "User-Agent": UA },
        label: "Capturado",
      };
    }
    // last resort: return embed as-is (Kino may still fail; alternatives help)
    throw kino.error("unavailable", "no stream", {
      userMessage: "No se pudo extraer el video de este servidor. Prueba otro en el menú.",
    });
  }

  // Load episode/movie page
  var pagePath = path.replace(/\/$/, "");
  var html = await get(pagePath);
  var players = parsePlayers(html);

  if (players.length === 0) {
    throw kino.error("unavailable", "no players", {
      userMessage: "No hay servidores disponibles para este título.",
    });
  }

  // Build alternatives: each player as lazy copy + try capture first preferred
  var alternatives = [];
  for (var i = 0; i < players.length; i++) {
    var p = players[i];
    var label = serverLabel(p.name);
    // Assume latino as site default
    var fullLabel = "Latino · " + label;
    alternatives.push({
      ref: "play:" + encodeURIComponent(p.url),
      label: fullLabel,
    });
  }

  // Sort alternatives by preference
  alternatives.sort(function (a, b) {
    return preferScore(b.label, preferLang, preferServer) - preferScore(a.label, preferLang, preferServer);
  });

  // Try to resolve the preferred one now
  var primary = null;
  for (var j = 0; j < players.length; j++) {
    var cand = players[j];
    var score = preferScore("Latino · " + serverLabel(cand.name), preferLang, preferServer);
    var direct2 = await tryDirectFromEmbed(cand.url);
    if (direct2 && direct2.url) {
      primary = {
        url: direct2.url,
        mime: direct2.mime,
        headers: { Referer: cand.url, "User-Agent": UA },
        label: "Latino · " + serverLabel(cand.name),
        _score: score,
      };
      break;
    }
    var cap2 = await captureStream(cand.url, pagePath);
    if (cap2 && cap2.url) {
      primary = {
        url: cap2.url,
        mime: cap2.mime,
        headers: { Referer: cand.url, "User-Agent": UA },
        label: "Latino · " + serverLabel(cand.name),
        _score: score,
      };
      break;
    }
  }

  if (primary) {
    var alts = [];
    for (var k = 0; k < alternatives.length; k++) {
      if (alternatives[k].label !== primary.label) alts.push(alternatives[k]);
    }
    return {
      url: primary.url,
      mime: primary.mime,
      headers: primary.headers,
      label: primary.label,
      alternatives: alts.length ? alts : undefined,
    };
  }

  // No direct stream yet — return first alternative as lazy via first ref resolve
  // Kino will call resolve again with play: ref when user picks
  if (alternatives.length) {
    // Force resolve first alternative recursively once
    try {
      var first = await resolve(alternatives[0].ref);
      if (first && first.url) {
        var rest = alternatives.slice(1);
        first.alternatives = rest.length ? rest : first.alternatives;
        first.label = first.label || alternatives[0].label;
        return first;
      }
    } catch (e) {}
  }

  throw kino.error("unavailable", "extract failed", {
    userMessage:
      "No se pudo obtener el video. Prueba otro servidor en el menú de fuentes.",
  });
}
