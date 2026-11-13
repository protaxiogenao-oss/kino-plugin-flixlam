/// <reference path="./kino.d.ts" />
/**
 * FlixLatam plugin for Kino — v1.2.3
 * Hecho por Hotaru Yume. Series, películas y anime en latino (flixlatam.com)
 * Resolve: Embed69 AES (LINK_CHALLENGE) → Vidhide (prioridad) / Streamwish / Filemoon
 * v1.2.3: nuevo cifrado Embed69 (sin PoW), prioriza Vidhide, evita VOE (captcha)
 * v1.2.2: home anti-timeout + cache
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
  // Cloudflare interstitial / origin errors / empty shells
  if (/just a moment|cf-chl|attention required|error code:\s*50[123]|502 bad gateway|503 service|origin is unreachable/i.test(html))
    return true;
  return false;
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
    });
    if (!r.ok) return "";
    var text = await r.text();
    if (isChallengeOrEmpty(text)) return "";
    return text;
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
    var m = String(u).match(/flixlatam\.com(\/[^?#]*)/i);
    if (m) return m[1];
    if (u.charAt(0) === "/") return u.split("?")[0];
  } catch (e) {}
  return u;
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
    var badge = "";
    var bm = path.match(/\/temporada\/(\d+)\/capitulo\/(\d+)/i);
    if (bm) badge = "T" + bm[1] + "E" + bm[2];
    if (title && badge && title.indexOf(badge) < 0 && !/T\d+/.test(title)) {
      title = title + " — " + badge;
    }
    if (!title) title = alt || path;
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

/** From a vidurl/embed69 player page → list of playable streams */
async function resolvePlayerPage(playerUrl) {
  var html = await getSoft(playerUrl, BASE + "/");
  if (!html) {
    // CF / empty: try hidden browser once
    try {
      if (kino.browser && typeof kino.browser.page === "function") {
        var page = await kino.browser.page(playerUrl, {
          waitFor: "dataLink",
          timeoutMs: 12000,
        });
        if (page && page.html) html = page.html;
      }
    } catch (e) {}
  }
  if (!html) return [];
  var embeds = decryptEmbed69Page(html);
  if (!embeds.length) {
    var direct = findStreamInText(html);
    if (direct) return [direct];
    return [];
  }

  // Prefer Vidhide / Streamwish; push VOE to the end (captcha)
  embeds.sort(function (a, b) {
    return preferScore(b.lang + " · " + b.server, "auto", "vidhide") -
      preferScore(a.lang + " · " + a.server, "auto", "vidhide");
  });

  var streams = [];
  var max = Math.min(embeds.length, 8);
  for (var i = 0; i < max; i++) {
    // Skip VOE unless we still have nothing after trying better servers
    if (/voe/i.test(embeds[i].server + embeds[i].serverRaw + embeds[i].url) && streams.length > 0) {
      continue;
    }
    try {
      var s = await extractStreamFromEmbed(embeds[i]);
      if (s && s.url) streams.push(s);
      // Stop early when we already have a solid non-VOE stream
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

  var CACHE_KEY = "home_html_v2";
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

  function sectionItems(label) {
    if (!html) return [];
    var idx = html.search(
      new RegExp("<h[12][^>]*>\\s*(?:<[^>]+>\\s*)*" + label, "i")
    );
    if (idx < 0) return [];
    return parseItems(html.slice(idx, idx + 30000));
  }

  function buildRows() {
    var out = [];
    seen = {};
    var latest = parseLatestEpisodes(html);
    if (latest.length) {
      out.push({
        id: "ultimos-episodios",
        title: "Últimos episodios",
        items: takeUnique(latest, 40),
        ref: "/?section=ultimos",
        genre: "series",
      });
    }
    var pelis = sectionItems("Películas");
    if (!pelis.length) pelis = sectionItems("Peliculas");
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
    var series = takeUnique(sectionItems("Series"), 40);
    if (series.length) {
      out.push({
        id: "series",
        title: "Series",
        items: series,
        ref: "/series",
        genre: "series",
      });
    }
    var anime = sectionItems("Anime");
    if (!anime.length) anime = sectionItems("Animes");
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
  if (path.indexOf("http") === 0) path = pathFromUrl(path);
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
  var pm = html.match(
    /class="poster"[\s\S]{0,400}?<img[^>]+src="([^"]+)"/i
  );
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
    // Some layouts put vidurl path only in scripts
    var vm = html.match(/\/vidurl\/[A-Za-z0-9_/.-]+/);
    if (vm) {
      players.push({ name: "Embed69", url: abs(vm[0]) });
    }
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
      // keep embed page as fallback alternative
      embedAlts.push({
        ref: "play:" + encodeURIComponent(player.url),
        label: "Embed · " + serverLabel(player.name),
      });
    } catch (e) {}
  }

  if (!allStreams.length) {
    throw kino.error("unavailable", "extract failed", {
      userMessage:
        "No se pudo obtener el video. Prueba otro servidor en el menú de fuentes.",
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
