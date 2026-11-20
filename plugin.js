/// <reference path="./kino.d.ts" />
/**
 * FlixLatam plugin for Kino — v1.2.6
 * Hecho por Hotaru Yume. Series, películas y anime en latino (flixlatam.com)
 * Resolve: Embed69 Anubis PoW+cookies → AES → Vidhide / Streamwish / Filemoon
 * v1.2.6: PoW Anubis obligatorio (getSoft no descartaba el challenge), cookies kino.fetch
 * v1.2.5: browser.page / capture
 * v1.2.4: episodios #sN-eM, home por secciones h2
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

function isChallengeOrEmpty(html) {
  if (!html || html.length < 400) return true;
  // Cloudflare / origin errors / Anubis bot-check (embed69)
  if (
    /just a moment|cf-chl|attention required|error code:\s*50[123]|502 bad gateway|503 service|origin is unreachable/i.test(
      html
    )
  )
    return true;
  if (
    /anubis_challenge|no eres un robot|asegur[aá]ndonos de que no eres|techaro\.lol-anubis|proof.of.work|pass-challenge/i.test(
      html
    )
  )
    return true;
  // Player shell without decryptable embeds
  if (
    /embed69\.org/i.test(html) &&
    !/dataLink|LINK_CHALLENGE|sortedEmbeds/i.test(html) &&
    html.length < 15000
  )
    return true;
  return false;
}

function isAnubisHtml(html) {
  return !!(
    html &&
    /anubis_challenge|no eres un robot|techaro\.lol-anubis|pass-challenge/i.test(
      html
    )
  );
}

/** Solve Anubis "fast" PoW (SHA-256 of randomData+nonce with N hex zero prefix). */
function solveAnubisFast(randomData, difficulty) {
  var needBytes = Math.floor(difficulty / 2);
  var odd = difficulty % 2 !== 0;
  var max = 5000000;
  for (var nonce = 0; nonce < max; nonce++) {
    var hex = kino.crypto.hash("sha256", String(randomData) + String(nonce));
    var ok = true;
    for (var i = 0; i < needBytes; i++) {
      if (hex.substr(i * 2, 2) !== "00") {
        ok = false;
        break;
      }
    }
    if (ok && odd) {
      var nibble = parseInt(hex.charAt(needBytes * 2), 16);
      if (nibble !== 0) ok = false;
    }
    if (ok) return { hash: hex, nonce: nonce };
  }
  return null;
}

/**
 * If HTML is Anubis gate, solve PoW; kino.fetch stores the auth cookie (cookies:true)
 * and the pass-challenge redirect usually returns the real player body.
 */
async function passAnubisAndFetch(pageUrl, challengeHtml, referer) {
  try {
    var cm = challengeHtml.match(
      /<script[^>]*id=["']anubis_challenge["'][^>]*>([\s\S]*?)<\/script>/i
    );
    if (!cm) {
      cm = challengeHtml.match(
        /id=["']anubis_challenge["'][^>]*>\s*(\{[\s\S]*?\})\s*<\/script>/i
      );
    }
    if (!cm) return "";
    var payload = JSON.parse(cm[1].trim());
    var rules = payload.rules || {};
    var ch = payload.challenge || payload;
    var difficulty =
      rules.difficulty != null ? rules.difficulty : ch.difficulty || 4;
    var randomData = ch.randomData;
    var id = ch.id;
    if (!randomData || !id) return "";
    var solved = solveAnubisFast(randomData, difficulty);
    if (!solved) return "";

    var base = "https://embed69.org";
    try {
      base = pageUrl.match(/^(https?:\/\/[^/]+)/i)[1];
    } catch (e) {}
    var redir = "/";
    try {
      redir = pageUrl.replace(base, "") || "/";
      if (redir.charAt(0) !== "/") redir = "/" + redir;
    } catch (e2) {}

    var passUrl =
      base +
      "/.within.website/x/cmd/anubis/api/pass-challenge?id=" +
      encodeURIComponent(id) +
      "&response=" +
      encodeURIComponent(solved.hash) +
      "&nonce=" +
      encodeURIComponent(String(solved.nonce)) +
      "&redir=" +
      encodeURIComponent(redir) +
      "&elapsedTime=250";

    var r = await kino.fetch(passUrl, {
      headers: hdr({ Referer: pageUrl }),
      timeoutMs: 25000,
      cookies: true,
    });
    var body = "";
    try {
      body = await r.text();
    } catch (e3) {
      body = "";
    }
    // Redirect often lands on the real player with dataLink
    if (
      body &&
      /dataLink|LINK_CHALLENGE|sortedEmbeds/i.test(body) &&
      !isAnubisHtml(body)
    ) {
      return body;
    }
    // Cookie should be stored: fetch original again
    var html2 = await getRaw(pageUrl, referer || BASE + "/", 15000);
    if (
      html2 &&
      /dataLink|LINK_CHALLENGE|sortedEmbeds/i.test(html2) &&
      !isAnubisHtml(html2)
    ) {
      return html2;
    }
    return "";
  } catch (e) {
    try {
      kino.log && kino.log("anubis pass failed: " + (e && e.message));
    } catch (e4) {}
    return "";
  }
}

/** Load embed69 / player HTML: raw fetch → Anubis PoW → browser last. */
async function loadPlayerHtml(playerUrl) {
  // 1) Raw fetch (keep Anubis challenge HTML — getSoft would discard it)
  var html = await getRaw(playerUrl, BASE + "/", 12000);
  if (
    html &&
    /dataLink|LINK_CHALLENGE|sortedEmbeds/i.test(html) &&
    !isAnubisHtml(html)
  ) {
    return html;
  }

  // 2) Anubis PoW (works on device without WebView; ~0.2s for difficulty 4)
  if (html && isAnubisHtml(html)) {
    var passed = await passAnubisAndFetch(playerUrl, html, BASE + "/");
    if (passed) return passed;
  } else if (!html) {
    // Empty: try once more to get challenge page
    html = await getRaw(playerUrl, BASE + "/", 12000);
    if (html && isAnubisHtml(html)) {
      var passed2 = await passAnubisAndFetch(playerUrl, html, BASE + "/");
      if (passed2) return passed2;
    }
    if (
      html &&
      /dataLink|LINK_CHALLENGE|sortedEmbeds/i.test(html) &&
      !isAnubisHtml(html)
    ) {
      return html;
    }
  }

  // 3) Hidden browser only if PoW failed (slow; often Access Denied on datacenter IPs)
  try {
    if (kino.browser && typeof kino.browser.page === "function") {
      var page = await kino.browser.page(playerUrl, {
        waitFor: "dataLink",
        timeoutMs: 20000,
      });
      if (
        page &&
        page.html &&
        /dataLink|LINK_CHALLENGE|sortedEmbeds/i.test(page.html) &&
        !isAnubisHtml(page.html)
      ) {
        return page.html;
      }
    }
  } catch (e) {}

  // 4) Cookie may have been set by browser
  html = await getRaw(playerUrl, BASE + "/", 10000);
  if (
    html &&
    /dataLink|sortedEmbeds/i.test(html) &&
    !isAnubisHtml(html)
  ) {
    return html;
  }
  return "";
}

async function get(path, referer, timeoutMs) {
  var url = path.indexOf("http") === 0 ? path : BASE + path;
  var r = await kino.fetch(url, {
    headers: hdr(referer ? { Referer: referer } : null),
    timeoutMs: timeoutMs || 10000,
  });
  if (!r.ok) {
    throw kino.error("unavailable", "http " + r.status, {
      userMessage: "No se pudo cargar la página (" + r.status + ").",
    });
  }
  var text = await r.text();
  if (isChallengeOrEmpty(text)) {
    throw kino.error("unavailable", "challenge_or_empty", {
      userMessage: "El sitio no respondió contenido usable.",
    });
  }
  return text;
}

async function getSoft(url, referer, timeoutMs) {
  try {
    var full = url.indexOf("http") === 0 ? url : BASE + url;
    var r = await kino.fetch(full, {
      headers: hdr(referer ? { Referer: referer } : null),
      timeoutMs: timeoutMs || 6000,
      cookies: true,
    });
    if (!r.ok) return "";
    var text = await r.text();
    if (isChallengeOrEmpty(text)) return "";
    return text;
  } catch (e) {
    return "";
  }
}

/** Fetch raw HTML even if it is an Anubis / CF challenge page. */
async function getRaw(url, referer, timeoutMs) {
  try {
    var full = url.indexOf("http") === 0 ? url : BASE + url;
    var r = await kino.fetch(full, {
      headers: hdr(referer ? { Referer: referer } : null),
      timeoutMs: timeoutMs || 10000,
      cookies: true,
    });
    if (!r.ok) return "";
    return await r.text();
  } catch (e) {
    return "";
  }
}

/** Read HTML for listings: cheap fetch first, then optional hidden browser (CF / 502). */
async function readPage(path, opts) {
  opts = opts || {};
  var timeoutFetch = opts.fetchMs || 8000;
  var timeoutBrowser = opts.browserMs || 10000;
  var waitFor = opts.waitFor || "article";
  var url = path.indexOf("http") === 0 ? path : BASE + path;

  var html = await getSoft(url, null, timeoutFetch);
  if (html && !isChallengeOrEmpty(html)) return html;

  // Origin often 502 / CF challenge — try real browser page (manifest has browser: "pages")
  try {
    if (kino.browser && typeof kino.browser.page === "function") {
      var page = await kino.browser.page(url, {
        waitFor: waitFor,
        timeoutMs: timeoutBrowser,
      });
      if (page && page.html && !isChallengeOrEmpty(page.html)) return page.html;
    }
  } catch (e) {
    // blocked / busy / browser_unavailable / timeout → fall through
  }
  return "";
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
    var s = String(u || "");
    var m = s.match(/flixlatam\.com(\/[^?#]*)/i);
    if (m) return m[1];
    if (s.charAt(0) === "/") {
      return s.split("?")[0].split("#")[0];
    }
    // bare path without leading slash
    if (/^(serie|anime|pelicula)\//i.test(s)) {
      return "/" + s.split("?")[0].split("#")[0];
    }
  } catch (e) {}
  return String(u || "").split("?")[0].split("#")[0];
}

/** Series slug path without season/episode or hash */
function seriesPathFromHref(href) {
  var p = pathFromUrl(abs(href));
  p = p.replace(/\/temporada\/.*$/i, "").replace(/\/$/, "");
  return p;
}

/** Parse #s12-e3 or /temporada/12/capitulo/3 → {season, number} */
function parseEpCoords(href) {
  var s = String(href || "");
  var hm = s.match(/#s(\d+)-e(\d+)/i);
  if (hm) return { season: parseInt(hm[1], 10), number: parseInt(hm[2], 10) };
  var tm = s.match(/\/temporada\/(\d+)\/capitulo\/(\d+)/i);
  if (tm) return { season: parseInt(tm[1], 10), number: parseInt(tm[2], 10) };
  return null;
}

function episodePagePath(seriesPath, season, number) {
  var base = seriesPath.replace(/\/$/, "");
  return base + "/temporada/" + season + "/capitulo/" + number;
}

function parseItems(html) {
  var items = [];
  var seen = {};
  var re =
    /<article[^>]*class="([^"]*)"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[\s\S]*?<img[^>]+src="([^"]+)"[^>]*(?:alt="([^"]*)")?[\s\S]*?(?:<h3[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>|<\/article>)/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var href = abs(m[2]);
    if (!/flixlatam\.com\/(serie|anime|pelicula)\//i.test(href)) continue;
    if (/\/temporada\/|\/capitulo\//i.test(href)) {
      href = href.replace(/\/temporada\/.*$/i, "");
    }
    var path = pathFromUrl(href);
    if (seen[path]) continue;
    seen[path] = true;
    var title = strip(m[5] || m[4] || "");
    if (!title) {
      var slug = path.split("/").pop() || "";
      title = slug.replace(/-[a-zA-Z0-9]{5,}$/, "").replace(/-/g, " ");
    }
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

function parseLatestEpisodes(html) {
  // Current site: /serie|anime/slug#s4-e1 (hash). Legacy: /temporada/N/capitulo/M
  var items = [];
  var seen = {};
  var re =
    /<article[^>]*class="[^"]*"[^>]*>[\s\S]*?<a[^>]+href="((?:https:\/\/flixlatam\.com)?\/(?:serie|anime)\/[^"#?]+(?:#s\d+-e\d+|\/temporada\/\d+\/capitulo\/\d+)?)"[\s\S]*?<img[^>]+src="([^"]+)"[^>]*(?:alt="([^"]*)")?[\s\S]*?(?:<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>|<div class="data">[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>)/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var href = m[1];
    var coords = parseEpCoords(href);
    var seriesPath = seriesPathFromHref(href);
    if (!seriesPath || !/\/(serie|anime)\//i.test(seriesPath)) continue;
    var key = seriesPath + (coords ? ":" + coords.season + "x" + coords.number : "");
    if (seen[key]) continue;
    seen[key] = true;
    var poster = abs(m[2]);
    var alt = strip(m[3] || "");
    var title = strip(m[4] || m[5] || alt);
    var badge = coords ? "T" + coords.season + "E" + coords.number : "";
    if (title && badge && title.indexOf(badge) < 0 && !/T\d+/.test(title)) {
      title = title + " — " + badge;
    }
    if (!title) title = alt || seriesPath;
    items.push({
      id: makeId((seriesPath + (badge || "")).replace(/^\//, "").replace(/\//g, "-")),
      ref: seriesPath,
      title: title,
      kind: "series",
      poster: poster,
      backdrop: poster,
      badges: badge ? [badge] : undefined,
      genres: /\/anime\//i.test(seriesPath) ? ["anime"] : ["series"],
    });
  }
  if (items.length === 0) {
    // Fallback: any episode-looking href near an image
    var re2 =
      /href="((?:https:\/\/flixlatam\.com)?\/(?:serie|anime)\/[^"]+#s(\d+)-e(\d+))"[^>]*>[\s\S]{0,600}?<img[^>]+src="([^"]+)"[^>]*(?:alt="([^"]*)")?/gi;
    while ((m = re2.exec(html)) !== null) {
      var series2 = seriesPathFromHref(m[1]);
      var badge2 = "T" + m[2] + "E" + m[3];
      var key2 = series2 + ":" + m[2] + "x" + m[3];
      if (seen[key2]) continue;
      seen[key2] = true;
      var title2 = strip(m[5] || "");
      if (title2 && title2.indexOf(badge2) < 0) title2 = title2 + " — " + badge2;
      if (!title2) title2 = badge2;
      items.push({
        id: makeId((series2 + badge2).replace(/^\//, "").replace(/\//g, "-")),
        ref: series2,
        title: title2,
        kind: "series",
        poster: abs(m[4]),
        backdrop: abs(m[4]),
        badges: [badge2],
        genres: /\/anime\//i.test(series2) ? ["anime"] : ["series"],
      });
    }
  }
  return items;
}

function parsePageItems(html, basePath) {
  var items = parseItems(html);
  var next = null;
  var pageM = html.match(
    /href="([^"]*[?&]page=(\d+)[^"]*)"[^>]*>\s*(?:›|»|Siguiente|Next)/i
  );
  if (pageM) {
    next = pageM[1];
    if (next.indexOf("http") !== 0 && next.charAt(0) !== "/")
      next = basePath + next;
  } else {
    var cur = 1;
    var curM = (basePath || "").match(/[?&]page=(\d+)/);
    if (curM) cur = parseInt(curM[1], 10);
    if (
      html.indexOf("page=" + (cur + 1)) >= 0 ||
      html.indexOf("?page=" + (cur + 1)) >= 0
    ) {
      var bp = (basePath || "/").split("?")[0];
      next = bp + "?page=" + (cur + 1);
    }
  }
  return { items: items, next: next };
}

function parsePlayers(html) {
  var players = [];
  var titles = [];
  var tr = /id="playerOptions"[\s\S]*?<\/ul>/i.exec(html);
  if (tr) {
    var tm;
    var reT = /<span class="title">([^<]+)<\/span>/gi;
    while ((tm = reT.exec(tr[0])) !== null) titles.push(strip(tm[1]));
  }
  var iframes = [];
  var ir = /id="player-(\d+)"[\s\S]*?<iframe[^>]+src=["']([^"']+)["']/gi;
  var im;
  while ((im = ir.exec(html)) !== null) {
    var raw = im[2];
    // Keep absolute embed69.org URLs; only resolve relative paths against FlixLatam
    var src =
      /^https?:\/\//i.test(raw) || raw.indexOf("//") === 0
        ? abs(raw)
        : abs(raw);
    iframes.push({ idx: parseInt(im[1], 10), src: src });
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
  if (players.length === 0) {
    var any = /<iframe[^>]+src=["']([^"']+)["']/gi;
    var am;
    var n = 0;
    while ((am = any.exec(html)) !== null) {
      var src2 = abs(am[1]);
      if (/vidurl|embed69|waaw|player|video/i.test(src2)) {
        players.push({ name: "Servidor " + ++n, url: src2 });
      }
    }
  }
  // Also pick bare embed69 links outside iframes
  if (players.length === 0) {
    var bare = html.match(
      /https?:\/\/(?:www\.)?embed69\.org\/[^\s"'<>]+/gi
    );
    if (bare) {
      for (var b = 0; b < bare.length; b++) {
        players.push({ name: "Embed69", url: bare[b].replace(/[.,;]+$/, "") });
      }
    }
  }
  return players;
}

function langLabel(code) {
  var c = String(code || "").toUpperCase();
  if (c === "LAT" || c === "LA" || c === "LATINO") return "Latino";
  if (c === "ESP" || c === "ES" || c === "CAST" || c === "CASTELLANO")
    return "Castellano";
  if (c === "SUB" || c === "VOSE" || c === "SUBS") return "Subtitulado";
  if (c === "ENG" || c === "EN") return "Inglés";
  return c || "Audio";
}

function serverLabel(name) {
  var n = String(name || "").toLowerCase();
  if (/streamwish|wish|hglink|swhoi|strwish/.test(n)) return "Streamwish";
  if (/voe/.test(n)) return "Voe";
  if (/filemoon|moon/.test(n)) return "Filemoon";
  if (/vidhide|hide|morencius|earnvids/.test(n)) return "Vidhide";
  if (/dood/.test(n)) return "Doodstream";
  if (/rapid/.test(n)) return "Rapidvideo";
  if (/embed69|embed/.test(n)) return "Embed69";
  if (/moe/.test(n)) return "Moe";
  if (/netu|waaw|hqq/.test(n)) return "Netu";
  return name || "Servidor";
}

function preferScore(label, preferLang, preferServer) {
  var s = 0;
  var L = String(preferLang || "auto").toUpperCase();
  var S = String(preferServer || "auto").toLowerCase();
  var lab = String(label || "").toLowerCase();
  if (L !== "AUTO") {
    if (L === "LAT" && /latino/.test(lab)) s += 100;
    if (L === "ESP" && /castellano/.test(lab)) s += 100;
    if (L === "SUB" && /subtit/.test(lab)) s += 100;
    if (L === "ENG" && /ingl|english/.test(lab)) s += 100;
  } else {
    if (/latino/.test(lab)) s += 50;
    if (/castellano/.test(lab)) s += 40;
  }
  if (S !== "auto" && lab.indexOf(S) >= 0) s += 80;
  // Vidhide first (no captcha, packer → m3u8). VOE last (often captcha).
  if (/vidhide|morencius|earnvids/.test(lab)) s += 30;
  if (/streamwish|hglink|swhoi|strwish/.test(lab)) s += 18;
  if (/filemoon|moon/.test(lab)) s += 12;
  if (/rapid/.test(lab)) s += 6;
  if (/voe/.test(lab)) s -= 20;
  return s;
}

/* ─── Embed69 PoW + AES ─── */

function solvePoW(challenge, difficulty, salt) {
  var prefix = "";
  for (var i = 0; i < difficulty; i++) prefix += "0";
  var nonce = 0;
  var max = 2000000;
  while (nonce < max) {
    var h = kino.crypto.hash("sha256", challenge + String(nonce));
    if (h.indexOf(prefix) === 0) {
      var keyHex = kino.crypto.hash(
        "sha256",
        challenge + String(nonce) + salt
      );
      return keyHex;
    }
    nonce++;
  }
  return null;
}

function decryptLink(encB64, keyHex) {
  try {
    // raw = iv(16) || ciphertext ; key is 32 bytes from sha256
    var rawB64 = encB64.replace(/\s/g, "");
    // decode to get iv + ct - kino.crypto.decrypt needs data as base64 of ciphertext only with separate iv
    // We need to split: use atob
    var bin = atob(rawB64);
    var ivBytes = [];
    var ctChars = [];
    for (var i = 0; i < bin.length; i++) {
      if (i < 16) ivBytes.push(bin.charCodeAt(i));
      else ctChars.push(bin.charAt(i));
    }
    var ivHex = "";
    for (var j = 0; j < ivBytes.length; j++) {
      var hx = ivBytes[j].toString(16);
      ivHex += hx.length === 1 ? "0" + hx : hx;
    }
    var ctB64 = btoa(ctChars.join(""));
    var plain = kino.crypto.decrypt("aes-256-cbc", {
      key: keyHex,
      keyEncoding: "hex",
      iv: ivHex,
      ivEncoding: "hex",
      data: ctB64,
    });
    return plain;
  } catch (e) {
    return null;
  }
}

function parseDataLink(html) {
  var m = html.match(/let\s+dataLink\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return [];
  try {
    // JSON-ish (already valid JSON from site)
    return JSON.parse(m[1]);
  } catch (e) {
    return [];
  }
}

function parsePoW(html) {
  var ch = html.match(/POW_CHALLENGE\s*=\s*['"]([^'"]+)['"]/);
  var df = html.match(/POW_DIFFICULTY\s*=\s*(\d+)/);
  var sa = html.match(/POW_SALT\s*=\s*['"]([^'"]+)['"]/);
  if (!ch || !df || !sa) return null;
  return {
    challenge: ch[1],
    difficulty: parseInt(df[1], 10),
    salt: sa[1],
  };
}

/** New Embed69 scheme (2025+): SHA256(LINK_CHALLENGE + LINK_SALT) as AES key */
function parseLinkKey(html) {
  var ch = html.match(/LINK_CHALLENGE\s*=\s*['"]([^'"]+)['"]/);
  var sa = html.match(/LINK_SALT\s*=\s*['"]([^'"]+)['"]/);
  if (!ch || !sa) return null;
  return kino.crypto.hash("sha256", ch[1] + sa[1]);
}

/** Decrypt all embeds from an embed69/vidurl page */
function decryptEmbed69Page(html) {
  var data = parseDataLink(html);
  if (!data.length) return [];
  var keyHex = parseLinkKey(html);
  if (!keyHex) {
    // legacy PoW (older player pages)
    var pow = parsePoW(html);
    if (pow) keyHex = solvePoW(pow.challenge, pow.difficulty, pow.salt);
  }
  if (!keyHex) return [];
  var out = [];
  for (var i = 0; i < data.length; i++) {
    var file = data[i];
    var lang = langLabel(file.video_language);
    var embeds = file.sortedEmbeds || [];
    for (var j = 0; j < embeds.length; j++) {
      var e = embeds[j];
      var url = decryptLink(e.link, keyHex);
      if (url) {
        url = String(url).replace(/`/g, "").trim();
      }
      if (url && url.indexOf("http") === 0) {
        out.push({
          lang: lang,
          server: serverLabel(e.servername || url),
          serverRaw: e.servername || "",
          url: url,
        });
      }
    }
  }
  return out;
}

/* ─── Host extractors ─── */

function toBase(n, base) {
  var digits =
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  if (n === 0) return "0";
  var s = "";
  while (n > 0) {
    s = digits.charAt(n % base) + s;
    n = Math.floor(n / base);
  }
  return s;
}

/** Dean Edwards packer unpack (streamwish family) */
function unpackPacker(html) {
  var m = html.match(
    /\}\s*\(\s*'((?:\\'|[^'])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\'|[^'])*)'\s*\.split\s*\(\s*'\|'\s*\)/
  );
  if (!m) {
    m = html.match(
      /\}\s*\(\s*"((?:\\"|[^"])*)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*"((?:\\"|[^"])*)"\s*\.split\s*\(\s*"\|"\s*\)/
    );
  }
  if (!m) return "";
  var payload = m[1]
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
  var a = parseInt(m[2], 10);
  var c = parseInt(m[3], 10);
  var keywords = m[4].split("|");
  var d = {};
  while (c--) {
    if (keywords[c]) d[toBase(c, a)] = keywords[c];
  }
  var out = payload.replace(/\b\w+\b/g, function (w) {
    return d[w] != null ? d[w] : w;
  });
  return out;
}

function findStreamInText(text) {
  if (!text) return null;
  var m3u = text.match(/https?:\/\/[^"'\s\\<>]+\\.m3u8[^"'\s\\<>]*/i);
  if (!m3u) m3u = text.match(/https?:\/\/[^"'\s\\<>]+m3u8[^"'\s\\<>]*/i);
  if (m3u) {
    return {
      url: m3u[0].replace(/\\u0026/g, "&").replace(/\\/g, ""),
      mime: "application/x-mpegURL",
    };
  }
  var mp4 = text.match(/https?:\/\/[^"'\s\\<>]+\.mp4[^"'\s\\<>]*/i);
  if (mp4) {
    return {
      url: mp4[0].replace(/\\u0026/g, "&").replace(/\\/g, ""),
      mime: "video/mp4",
    };
  }
  var file = text.match(/["']file["']\s*:\s*["'](https?:\/\/[^"']+)["']/i);
  if (file) {
    var fu = file[1].replace(/\\u0026/g, "&");
    return {
      url: fu,
      mime: /\.m3u8/i.test(fu) ? "application/x-mpegURL" : "video/mp4",
    };
  }
  return null;
}

async function extractFromStreamwish(embedUrl) {
  // try known mirrors
  var idM = embedUrl.match(/\/(?:e|v|f)\/([a-z0-9]+)/i);
  var id = idM ? idM[1] : null;
  var urls = [embedUrl];
  if (id) {
    urls = urls.concat([
      "https://swhoi.com/e/" + id,
      "https://hglink.to/e/" + id,
      "https://strwish.com/e/" + id,
      "https://streamwish.to/e/" + id,
    ]);
  }
  for (var i = 0; i < urls.length; i++) {
    var html = await getSoft(urls[i], "https://embed69.org/");
    if (!html || html.length < 500) continue;
    var stream = findStreamInText(html);
    if (stream) return stream;
    var unpacked = unpackPacker(html);
    if (unpacked) {
      stream = findStreamInText(unpacked);
      if (stream) return stream;
    }
  }
  return null;
}

async function extractFromVoe(embedUrl) {
  // VOE often shows a captcha in real browsers; still try plain extraction.
  var html = await getSoft(embedUrl, "https://embed69.org/");
  if (!html) return null;
  if (/captcha|turnstile|cf-challenge|just a moment/i.test(html)) return null;
  var stream = findStreamInText(html);
  if (stream) return stream;
  var m = html.match(
    /(?:var|let|const)\s+\w+\s*=\s*['"]([A-Za-z0-9+/=]{40,})['"]/
  );
  if (m) {
    try {
      var dec = atob(m[1]);
      stream = findStreamInText(dec);
      if (stream) return stream;
    } catch (e) {}
  }
  var p = html.match(/prompt\s*\(\s*['"]([A-Za-z0-9+/=]+)['"]/);
  if (p) {
    try {
      stream = findStreamInText(atob(p[1]));
      if (stream) return stream;
    } catch (e) {}
  }
  // application/json encoded blob used by some VOE mirrors
  var j = html.match(
    /<script[^>]*type=["']application\/json["'][^>]*>\s*\["([^"]+)"\]/i
  );
  if (j) {
    try {
      stream = findStreamInText(atob(j[1]));
      if (stream) return stream;
    } catch (e) {}
  }
  return null;
}

async function extractFromVidhide(embedUrl) {
  // Normalize /d/ /f/ /file/ → /v/ or keep /embed/
  var url = String(embedUrl || "");
  var candidates = [url];
  var idM = url.match(
    /\/(?:embed|e|v|f|d|file|download)\/([A-Za-z0-9]+)/i
  );
  var id = idM ? idM[1] : null;
  if (id) {
    var hosts = [
      "morencius.com",
      "vidhidevip.com",
      "vidhidepre.com",
      "vidhidepro.com",
      "smoothpre.com",
      "dhtpre.com",
    ];
    for (var h = 0; h < hosts.length; h++) {
      candidates.push("https://" + hosts[h] + "/embed/" + id);
      candidates.push("https://" + hosts[h] + "/v/" + id);
      candidates.push("https://" + hosts[h] + "/e/" + id);
    }
  }
  // de-dupe
  var seen = {};
  var list = [];
  for (var c = 0; c < candidates.length; c++) {
    if (!seen[candidates[c]]) {
      seen[candidates[c]] = true;
      list.push(candidates[c]);
    }
  }
  for (var i = 0; i < Math.min(list.length, 5); i++) {
    var html = await getSoft(list[i], "https://embed69.org/");
    if (!html || html.length < 400) continue;
    var stream = findStreamInText(html);
    if (stream) {
      stream.headers = {
        Referer: list[i],
        "User-Agent": UA,
        Origin: "https://" + (list[i].split("/")[2] || "vidhidevip.com"),
      };
      return stream;
    }
    var unpacked = unpackPacker(html);
    if (unpacked) {
      // prefer links.hls2 / hls4 absolute URLs
      var hls = unpacked.match(
        /["']hls[24]?["']\s*:\s*["'](https?:\/\/[^"']+m3u8[^"']*)["']/i
      );
      if (!hls) {
        hls = unpacked.match(
          /["']hls[24]?["']\s*:\s*["'](\/[^"']+m3u8[^"']*)["']/i
        );
      }
      if (hls) {
        var hu = hls[1];
        if (hu.charAt(0) === "/") {
          try {
            hu = "https://" + list[i].split("/")[2] + hu;
          } catch (e) {}
        }
        return {
          url: hu.replace(/\\u0026/g, "&"),
          mime: "application/x-mpegURL",
          headers: {
            Referer: list[i],
            "User-Agent": UA,
            Origin: "https://" + (list[i].split("/")[2] || "vidhidevip.com"),
          },
        };
      }
      stream = findStreamInText(unpacked);
      if (stream) {
        stream.headers = {
          Referer: list[i],
          "User-Agent": UA,
        };
        return stream;
      }
    }
  }
  return null;
}

async function extractFromGeneric(embedUrl) {
  var html = await getSoft(embedUrl, "https://embed69.org/");
  if (!html) return null;
  var stream = findStreamInText(html);
  if (stream) return stream;
  var unpacked = unpackPacker(html);
  if (unpacked) {
    stream = findStreamInText(unpacked);
    if (stream) return stream;
  }
  return null;
}

async function extractStreamFromEmbed(embed) {
  var url = embed.url;
  var host = "";
  try {
    host = url.split("/")[2] || "";
  } catch (e) {}
  var tag = (host + " " + (embed.serverRaw || "") + " " + (embed.server || "")).toLowerCase();
  var stream = null;

  if (/vidhide|morencius|earnvids|smoothpre|dhtpre|peytone/i.test(tag)) {
    stream = await extractFromVidhide(url);
  } else if (/streamwish|hglink|swhoi|strwish|wish/i.test(tag)) {
    stream = await extractFromStreamwish(url);
  } else if (/voe/i.test(tag)) {
    // VOE is often captcha-gated — only try if user preferred it
    stream = await extractFromVoe(url);
  } else if (/filemoon|moon/i.test(tag)) {
    stream = await extractFromGeneric(url);
  } else {
    stream = await extractFromGeneric(url);
    if (!stream && /wish|hglink|swhoi/i.test(url)) {
      stream = await extractFromStreamwish(url);
    }
    if (!stream && /vidhide|morencius|embed\//i.test(url)) {
      stream = await extractFromVidhide(url);
    }
  }
  if (stream && stream.url) {
    stream.label = (embed.lang || "Audio") + " · " + (embed.server || serverLabel(url));
    if (!stream.headers) {
      stream.headers = {
        Referer: url,
        "User-Agent": UA,
      };
    }
  }
  return stream;
}

/** Capture m3u8/mp4 from an embed URL via hidden browser (last resort). */
async function captureEmbedStream(embedUrl, label) {
  try {
    if (!kino.browser || typeof kino.browser.capture !== "function") return null;
    var cap = await kino.browser.capture(embedUrl, {
      timeoutMs: 18000,
      match: "\\.m3u8|master\\.txt|/hls/|\\.mp4",
      autoplay: true,
    });
    if (!cap || !cap.media || !cap.media.length) return null;
    var best = cap.media[0];
    return {
      url: best.url,
      mime: best.mime || (/\.m3u8/i.test(best.url) ? "application/x-mpegURL" : "video/mp4"),
      label: label || "Captura",
      headers: best.headers || {
        Referer: embedUrl,
        "User-Agent": UA,
      },
    };
  } catch (e) {
    return null;
  }
}

/** From a vidurl/embed69 player page → list of playable streams */
async function resolvePlayerPage(playerUrl) {
  var html = await loadPlayerHtml(playerUrl);
  if (!html) return [];

  var embeds = decryptEmbed69Page(html);
  if (!embeds.length) {
    var direct = findStreamInText(html);
    if (direct) return [direct];
    // Anubis passed but decrypt failed — try capture on player itself
    var capPlayer = await captureEmbedStream(playerUrl, "Embed69");
    return capPlayer ? [capPlayer] : [];
  }

  // Prefer Vidhide / Streamwish; VOE last (captcha)
  embeds.sort(function (a, b) {
    return (
      preferScore(b.lang + " · " + b.server, "auto", "vidhide") -
      preferScore(a.lang + " · " + a.server, "auto", "vidhide")
    );
  });

  var streams = [];
  var max = Math.min(embeds.length, 8);
  for (var i = 0; i < max; i++) {
    if (
      /voe/i.test(embeds[i].server + embeds[i].serverRaw + embeds[i].url) &&
      streams.length > 0
    ) {
      continue;
    }
    try {
      var s = await extractStreamFromEmbed(embeds[i]);
      if (s && s.url) {
        streams.push(s);
      } else if (/vidhide|morencius|streamwish|hglink|filemoon/i.test(
        embeds[i].server + embeds[i].url
      )) {
        // Host page blocked or packed differently — capture media requests
        var cap = await captureEmbedStream(
          embeds[i].url,
          embeds[i].lang + " · " + embeds[i].server
        );
        if (cap && cap.url) streams.push(cap);
      }
      if (streams.length >= 2 && !/voe/i.test(streams[0].label || "")) break;
    } catch (e) {}
  }
  return streams;
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
  var html = "";
  try {
    html = await readPage(path, { fetchMs: 8000, browserMs: 6000, waitFor: "article" });
  } catch (e) {
    return [];
  }
  if (!html) return [];
  var parsed = parsePageItems(html, path);
  var items = rank(parsed.items, q).slice(0, 100);
  if (parsed.next) return { items: items, next: parsed.next };
  return items;
}

export async function home() {
  // Hard limit: 20s. Never chain long waits (12s+8s was still timing out).
  // Site origin behind Cloudflare often returns 502 or hangs.
  // Plan: storage cache → one short fetch → optional browser.page → parse → return.
  // NEVER throw from home (throws become timeouts / disable the plugin).

  var CACHE_KEY = "home_html_v3";
  var CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
  var rows = [];
  var seen = {};
  var html = "";

  function takeUnique(list, max) {
    var out = [];
    for (var i = 0; i < list.length && out.length < max; i++) {
      var it = list[i];
      var key = it.ref || it.id;
      if (seen[key]) continue;
      seen[key] = true;
      out.push(it);
    }
    return out;
  }

  /** Slice HTML from matching h2 until the next h2 (avoids mixing sections). */
  function sectionSlice(label) {
    if (!html) return "";
    // Label must sit inside the same <h2>...</h2> (icons allowed before text)
    var re = new RegExp(
      "<h2\\b[^>]*>(?:(?!<\\/h2>)[\\s\\S])*?" + label + "(?:(?!<\\/h2>)[\\s\\S])*?<\\/h2>",
      "i"
    );
    var m = re.exec(html);
    if (!m) return "";
    var start = m.index;
    var afterHeader = start + m[0].length;
    var rest = html.slice(afterHeader);
    var next = rest.search(/<h2\b/i);
    return next >= 0 ? html.slice(start, afterHeader + next) : html.slice(start);
  }

  function sectionItems(label, kindFilter) {
    var chunk = sectionSlice(label);
    if (!chunk) return [];
    var list = parseItems(chunk);
    if (!kindFilter) return list;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var ref = it.ref || "";
      if (kindFilter === "movie" && /\/pelicula\//i.test(ref)) out.push(it);
      else if (kindFilter === "anime" && /\/anime\//i.test(ref)) out.push(it);
      else if (kindFilter === "series" && /\/serie\//i.test(ref)) out.push(it);
    }
    return out;
  }

  function buildRows() {
    var out = [];
    seen = {};
    // Últimos episodios: only that h2 block (not the whole page)
    var latestChunk = sectionSlice("ltimos Episodios");
    if (!latestChunk) latestChunk = sectionSlice("Últimos Episodios");
    if (!latestChunk) latestChunk = sectionSlice("Ultimos Episodios");
    var latest = parseLatestEpisodes(latestChunk || "");
    if (latest.length) {
      out.push({
        id: "ultimos-episodios",
        title: "Últimos episodios",
        items: takeUnique(latest, 40),
        ref: "/?section=ultimos",
        genre: "series",
      });
    }
    var pelis = sectionItems("Películas", "movie");
    if (!pelis.length) pelis = sectionItems("Peliculas", "movie");
    pelis = takeUnique(pelis, 40);
    if (pelis.length) {
      out.push({
        id: "peliculas",
        title: "Películas",
        items: pelis,
        ref: "/peliculas",
        genre: "peliculas",
      });
    }
    var series = takeUnique(sectionItems("Series", "series"), 40);
    if (series.length) {
      out.push({
        id: "series",
        title: "Series",
        items: series,
        ref: "/series",
        genre: "series",
      });
    }
    var anime = sectionItems("Anime", "anime");
    if (!anime.length) anime = sectionItems("Animes", "anime");
    anime = takeUnique(anime, 40);
    if (anime.length) {
      out.push({
        id: "anime",
        title: "Anime",
        items: anime,
        ref: "/animes",
        genre: "anime",
      });
    }
    var doramas = takeUnique(sectionItems("Doramas", "series"), 40);
    if (doramas.length) {
      out.push({
        id: "doramas",
        title: "Doramas",
        items: doramas,
        ref: "/generos/dorama",
        genre: "series",
      });
    }
    if (!out.length) {
      var any = takeUnique(parseItems(html), 40);
      if (any.length) {
        out.push({ id: "inicio", title: "Inicio", items: any, ref: "/" });
      }
    }
    return out;
  }

  // 1) Fresh cache (instant — survives intermittent 502)
  // kino.storage is sync; values are strings
  try {
    var raw = kino.storage.get(CACHE_KEY);
    if (raw) {
      var cached = JSON.parse(raw);
      if (cached && cached.html && cached.ts && Date.now() - cached.ts < CACHE_TTL_MS) {
        html = cached.html;
        rows = buildRows();
        if (rows.length) return rows;
      }
    }
  } catch (e) {}

  // 2) One network path only: short fetch, then browser if needed (budget < 18s)
  try {
    html = await readPage("/", {
      fetchMs: 7000,
      browserMs: 10000,
      waitFor: "article",
    });
  } catch (e) {
    html = "";
  }

  if (html && !isChallengeOrEmpty(html)) {
    try {
      // Cap cached HTML size to stay under 256 KB storage budget
      var toStore = html.length > 180000 ? html.slice(0, 180000) : html;
      kino.storage.set(
        CACHE_KEY,
        JSON.stringify({ html: toStore, ts: Date.now() }),
        { ttlMs: CACHE_TTL_MS }
      );
    } catch (e) {}
    rows = buildRows();
    if (rows.length) return rows;
  }

  // 3) Stale cache better than empty / timeout
  try {
    var raw2 = kino.storage.get(CACHE_KEY);
    if (raw2) {
      var stale = JSON.parse(raw2);
      if (stale && stale.html) {
        html = stale.html;
        rows = buildRows();
        if (rows.length) return rows;
      }
    }
  } catch (e) {}

  // 4) Always return something so Kino never records home [timeout]
  return [
    {
      id: "inicio",
      title: "FlixLatam (sitio no disponible)",
      items: [],
      ref: "/peliculas",
    },
  ];
}

export async function browse(ref, cursor) {
  var path = ref || "/";
  if (cursor) path = cursor;
  if (path.indexOf("http") === 0) path = pathFromUrl(path);
  var html = "";
  try {
    html = await readPage(path === "/?section=ultimos" ? "/" : path, {
      fetchMs: 8000,
      browserMs: 8000,
      waitFor: "article",
    });
  } catch (e) {
    return { items: [] };
  }
  if (!html) return { items: [] };
  if (path === "/?section=ultimos") {
    return { items: parseLatestEpisodes(html).slice(0, 100), next: null };
  }
  var parsed = parsePageItems(html, path);
  return {
    items: (parsed.items || []).slice(0, 100),
    next: parsed.next || undefined,
  };
}

export async function episodes(ref) {
  var path = ref;
  if (String(path).indexOf("ep:") === 0) path = String(path).slice(3);
  if (path.indexOf("http") === 0) path = pathFromUrl(path);
  path = path.replace(/\/temporada\/.*$/i, "").replace(/\/$/, "");
  path = path.split("#")[0];

  var html = "";
  try {
    html = await readPage(path, {
      fetchMs: 10000,
      browserMs: 10000,
      waitFor: "episodios",
    });
  } catch (e) {
    try {
      html = await get(path);
    } catch (e2) {
      html = "";
    }
  }
  if (!html) {
    throw kino.error("unavailable", "series page failed", {
      userMessage: "No se pudo cargar la lista de episodios.",
    });
  }

  var title = "";
  var tm = html.match(/<title>([^<]+)/i);
  if (tm) {
    title = strip(tm[1])
      .replace(/\s*-\s*FLIXLATAM.*$/i, "")
      .replace(/^Ver\s+/i, "")
      .replace(/\s+Online.*$/i, "")
      .replace(/&#39;/g, "'")
      .trim();
  }
  var poster = "";
  var pm = html.match(
    /class="poster"[\s\S]{0,400}?<img[^>]+src="([^"]+)"/i
  );
  if (!pm) pm = html.match(/property="og:image"\s+content="([^"]+)"/i);
  if (pm) poster = abs(pm[1]);
  var overview = "";
  var om = html.match(/class="wp-content"[^>]*>([\s\S]*?)<\/div>/i);
  if (!om) om = html.match(/property="og:description"\s+content="([^"]+)"/i);
  if (om) overview = strip(om[1]).slice(0, 600);

  var eps = [];
  var seen = {};

  function addEp(season, number, epTitle) {
    if (!season || !number || season < 1 || number < 1) return;
    var key = season + "x" + number;
    if (seen[key]) return;
    seen[key] = true;
    var full = episodePagePath(path, season, number);
    eps.push({
      season: season,
      number: number,
      ref: "ep:" + full,
      title: epTitle || "T" + season + "E" + number,
    });
  }

  // 1) Hash links: /anime/slug#s1-e2  or episode-link class
  var reHash =
    /href="((?:https:\/\/flixlatam\.com)?\/(?:serie|anime)\/[^"#?]+#s(\d+)-e(\d+))"[^>]*>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = reHash.exec(html)) !== null) {
    var epTitle = strip(m[4]).replace(/\s+/g, " ");
    if (!epTitle || epTitle.length > 80) epTitle = "Episodio " + m[3];
    addEp(parseInt(m[2], 10), parseInt(m[3], 10), epTitle);
  }

  // 2) numerando "1 - 2" blocks next to episode-link
  var reNum =
    /class="numerando"[^>]*>\s*(\d+)\s*[-–]\s*(\d+)\s*<\/div>[\s\S]{0,200}?class="episodiotitle"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = reNum.exec(html)) !== null) {
    addEp(parseInt(m[1], 10), parseInt(m[2], 10), strip(m[3]) || undefined);
  }

  // 3) Legacy full paths /temporada/N/capitulo/M
  var reLeg =
    /href="((?:https:\/\/flixlatam\.com)?(\/(?:serie|anime)\/[^"]+\/temporada\/(\d+)\/capitulo\/(\d+)))"/gi;
  while ((m = reLeg.exec(html)) !== null) {
    addEp(parseInt(m[3], 10), parseInt(m[4], 10), "T" + m[3] + "E" + m[4]);
  }

  // 4) data-season panels: count episode-link inside each season
  if (eps.length === 0) {
    var rePanel =
      /data-season="(\d+)"[\s\S]*?<ul class="episodios"[^>]*>([\s\S]*?)<\/ul>/gi;
    while ((m = rePanel.exec(html)) !== null) {
      var season = parseInt(m[1], 10);
      var lis = m[2].match(/<li[\s\S]*?<\/li>/gi) || [];
      for (var i = 0; i < lis.length; i++) {
        var nm = lis[i].match(/class="numerando"[^>]*>\s*\d+\s*[-–]\s*(\d+)/i);
        var number = nm ? parseInt(nm[1], 10) : i + 1;
        var tm2 = lis[i].match(/<a[^>]*class="[^"]*episode-link[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
        addEp(season, number, tm2 ? strip(tm2[1]) : "Episodio " + number);
      }
    }
  }

  eps.sort(function (a, b) {
    if (a.season !== b.season) return a.season - b.season;
    return a.number - b.number;
  });

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

  if (eps.length === 0) {
    throw kino.error("not_found", "no episodes parsed", {
      userMessage: "No hay episodios disponibles por ahora.",
    });
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
  var preferLang = "LAT";
  var preferServer = "auto";
  try {
    if (kino.config) {
      preferLang = kino.config.preferLang || preferLang;
      preferServer = kino.config.preferServer || preferServer;
    }
  } catch (e) {}

  // Lazy alternative: play:<urlencoded embed url>
  if (String(ref).indexOf("play:") === 0) {
    var embedUrl = decodeURIComponent(String(ref).slice(5));
    var one = await extractStreamFromEmbed({
      url: embedUrl,
      server: serverLabel(embedUrl),
      serverRaw: "",
      lang: "Audio",
    });
    if (one && one.url) {
      return {
        url: one.url,
        mime: one.mime,
        headers: one.headers || { Referer: embedUrl, "User-Agent": UA },
        label: one.label,
      };
    }
    // try as embed69 page
    var fromPage = await resolvePlayerPage(embedUrl);
    if (fromPage.length) {
      return {
        url: fromPage[0].url,
        mime: fromPage[0].mime,
        headers: fromPage[0].headers || {
          Referer: embedUrl,
          "User-Agent": UA,
        },
        label: fromPage[0].label,
      };
    }
    throw kino.error("unavailable", "lazy failed", {
      userMessage: "Este servidor no respondió. Prueba otra fuente.",
    });
  }

  var path = ref;
  if (String(ref).indexOf("ep:") === 0) path = String(ref).slice(3);
  if (path.indexOf("http") === 0 && path.indexOf("flixlatam.com") >= 0) {
    path = pathFromUrl(path);
  }

  var pagePath = String(path).replace(/\/$/, "");
  var html = "";
  try {
    html = await readPage(pagePath, {
      fetchMs: 10000,
      browserMs: 10000,
      waitFor: "iframe",
    });
  } catch (e) {
    html = "";
  }
  if (!html) {
    throw kino.error("unavailable", "page load failed", {
      userMessage:
        "No se pudo cargar la página del título. El sitio puede estar caído; inténtalo más tarde.",
    });
  }
  var players = parsePlayers(html);

  if (!players.length) {
    // Legacy /vidurl/ or direct embed69.org iframe
    var vm = html.match(/\/vidurl\/[A-Za-z0-9_/.-]+/);
    if (vm) players.push({ name: "Embed69", url: abs(vm[0]) });
    var em = html.match(
      /https?:\/\/(?:www\.)?embed69\.org\/[fve]?\/?[A-Za-z0-9_./-]+/i
    );
    if (em) players.push({ name: "Embed69", url: em[0] });
  }
  if (!players.length) {
    throw kino.error("unavailable", "no players", {
      userMessage: "No hay servidores disponibles para este título.",
    });
  }

  var allStreams = [];
  var embedAlts = [];

  for (var p = 0; p < players.length; p++) {
    var player = players[p];
    try {
      var streams = await resolvePlayerPage(player.url);
      for (var s = 0; s < streams.length; s++) {
        allStreams.push(streams[s]);
      }
      embedAlts.push({
        ref: "play:" + encodeURIComponent(player.url),
        label: "Embed · " + serverLabel(player.name),
      });
    } catch (e) {}
  }

  // Last resort: capture media from the player iframe URL itself
  if (!allStreams.length) {
    for (var p2 = 0; p2 < players.length && allStreams.length < 2; p2++) {
      try {
        var cap = await captureEmbedStream(
          players[p2].url,
          players[p2].name || "Embed69"
        );
        if (cap && cap.url) allStreams.push(cap);
      } catch (e) {}
    }
  }

  if (!allStreams.length) {
    throw kino.error("unavailable", "extract failed", {
      userMessage:
        "No se pudo obtener el video (bloqueo anti-bot en el servidor). Abre el título de nuevo o prueba más tarde.",
    });
  }

  allStreams.sort(function (a, b) {
    return (
      preferScore(b.label, preferLang, preferServer) -
      preferScore(a.label, preferLang, preferServer)
    );
  });

  var primary = allStreams[0];
  var alternatives = [];
  for (var i = 1; i < allStreams.length; i++) {
    alternatives.push({
      url: allStreams[i].url,
      mime: allStreams[i].mime,
      headers: allStreams[i].headers,
      label: allStreams[i].label,
    });
  }
  // append embed fallbacks not already covered
  for (var a = 0; a < embedAlts.length; a++) {
    alternatives.push(embedAlts[a]);
  }

  return {
    url: primary.url,
    mime: primary.mime || "application/x-mpegURL",
    headers: primary.headers || { "User-Agent": UA },
    label: primary.label,
    alternatives: alternatives.length ? alternatives : undefined,
  };
}
