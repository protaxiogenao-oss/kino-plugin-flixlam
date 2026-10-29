/// <reference path="./kino.d.ts" />
/**
 * FlixLatam plugin for Kino — v1.3.0
 * Series, películas y anime en latino (flixlatam.com)
 * Resolve: PoW + AES (Embed69) → Streamwish/Voe/Vidhide → m3u8
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

async function getSoft(url, referer) {
  try {
    var r = await kino.fetch(url, {
      headers: hdr(referer ? { Referer: referer } : null),
      timeoutMs: 18000,
    });
    if (!r.ok) return "";
    return await r.text();
  } catch (e) {
    return "";
  }
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

/**
 * FlixLatam casi solo publica pósters verticales (2:3) en listados.
 * Las stills 16:9 aparecen en páginas de episodio.
 * - verticalPoster: detalle / catálogo clásico
 * - horizontalBackdrop: filas de Inicio (Kino usa backdrop en tarjetas apaisadas)
 *   Misma imagen en w780: mejor nitidez; si la fuente es vertical Kino letterbox/ajusta
 *   sin un recorte extremo tipo thumbnail cuadrado.
 */
function tmdbSize(u, size) {
  if (!u) return undefined;
  var url = abs(u);
  if (/image\.tmdb\.org\/t\/p\//i.test(url)) {
    url = url.replace(
      /image\.tmdb\.org\/t\/p\/(?:original|w\d+|h\d+)\//i,
      "image.tmdb.org/t/p/" + size + "/"
    );
  }
  return url;
}
function verticalPoster(u) {
  return tmdbSize(u, "w500");
}
function horizontalBackdrop(u) {
  // w780 se acerca a ancho de tarjetas 16:9; original si no es TMDB
  var url = tmdbSize(u, "w780");
  if (url) return url;
  return abs(u) || undefined;
}
function applyImages(item, rawUrl, landscapeUrl) {
  var poster = verticalPoster(rawUrl);
  var back = horizontalBackdrop(landscapeUrl || rawUrl);
  if (poster) item.poster = poster;
  if (back) item.backdrop = back;
  return item;
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
    var kind = kindFromUrl(href);
    items.push(
      applyImages(
        {
          id: makeId(path.replace(/^\//, "").replace(/\//g, "-")),
          ref: path,
          title: title,
          kind: kind,
          genres: kind === "movie" ? ["movies"] : /\/anime\//i.test(href) ? ["anime"] : ["series"],
        },
        m[3]
      )
    );
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
      items.push(
        applyImages(
          {
            id: makeId(path2.replace(/^\//, "").replace(/\//g, "-")),
            ref: path2,
            title: title2,
            kind: kindFromUrl(href2),
          },
          m[2]
        )
      );
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
    items.push(
      applyImages(
        {
          id: makeId(path.replace(/^\//, "").replace(/\//g, "-")),
          ref: seriesPath,
          title: title,
          kind: "series",
          badges: badge ? [badge] : undefined,
          genres: /\/anime\//i.test(path) ? ["anime"] : ["series"],
        },
        m[2]
      )
    );
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
      items.push(
        applyImages(
          {
            id: makeId(path2.replace(/^\//, "").replace(/\//g, "-")),
            ref: series2,
            title: title2,
            kind: "series",
            badges: [badge2],
          },
          m[4]
        )
      );
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
  if (S !== "auto" && lab.indexOf(S) >= 0) s += 40;
  if (/vidhide/.test(lab)) s += 10;
  if (/streamwish/.test(lab)) s += 8;
  if (/filemoon/.test(lab)) s += 6;
  if (/voe/.test(lab)) s += 4;
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

/** Decrypt all embeds from an embed69/vidurl page */
function decryptEmbed69Page(html) {
  var pow = parsePoW(html);
  var data = parseDataLink(html);
  if (!pow || !data.length) return [];
  var keyHex = solvePoW(pow.challenge, pow.difficulty, pow.salt);
  if (!keyHex) return [];
  var out = [];
  for (var i = 0; i < data.length; i++) {
    var file = data[i];
    var lang = langLabel(file.video_language);
    var embeds = file.sortedEmbeds || [];
    for (var j = 0; j < embeds.length; j++) {
      var e = embeds[j];
      var url = decryptLink(e.link, keyHex);
      if (url && url.indexOf("http") === 0) {
        out.push({
          lang: lang,
          server: serverLabel(e.servername),
          serverRaw: e.servername,
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

/** Unpack common JS packers used by Streamwish / Vidhide / Filemoon */
function unpackPacker(html) {
  if (!html) return "";
  var out = "";

  // Format A: while(c--) if(k[c]) p.replace(RegExp('\\b'+c.toString(a)+'\\b'), k[c])
  var reA =
    /eval\(function\(p,a,c,k,e,d\)\{while\(c--\)if\(k\[c\]\)p=p\.replace\(new RegExp\('\\\\b'\+c\.toString\(a\)\+'\\\\b','g'\),k\[c\]\);return p\}\('((?:\\'|[^'])*)',(\d+),(\d+),'((?:\\'|[^'])*)'\.split\('\|'\)/i;
  var m = reA.exec(html);
  if (m) {
    try {
      var payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      var a = parseInt(m[2], 10);
      var c = parseInt(m[3], 10);
      var keywords = m[4].split("|");
      while (c--) {
        if (keywords[c]) {
          payload = payload.replace(
            new RegExp("\\b" + c.toString(a) + "\\b", "g"),
            keywords[c]
          );
        }
      }
      out += payload + "\n";
    } catch (e) {}
  }

  // Format B: classic Dean Edwards (toBase words)
  var reB =
    /\}\s*\(\s*'((?:\\'|[^'])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\'|[^'])*)'\s*\.split\s*\(\s*'\|'\s*\)/;
  m = reB.exec(html);
  if (!m) {
    reB =
      /\}\s*\(\s*"((?:\\"|[^"])*)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*"((?:\\"|[^"])*)"\s*\.split\s*\(\s*"\|"\s*\)/;
    m = reB.exec(html);
  }
  if (m) {
    try {
      var payload2 = m[1]
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
      var a2 = parseInt(m[2], 10);
      var c2 = parseInt(m[3], 10);
      var keywords2 = m[4].split("|");
      var d = {};
      while (c2--) {
        if (keywords2[c2]) d[toBase(c2, a2)] = keywords2[c2];
      }
      out +=
        payload2.replace(/\b\w+\b/g, function (w) {
          return d[w] != null ? d[w] : w;
        }) + "\n";
    } catch (e) {}
  }

  return out;
}

function findStreamInTextfunction findStreamInText(text) {
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
  var html = await getSoft(embedUrl, "https://embed69.org/");
  if (!html) return null;
  var stream = findStreamInText(html);
  if (stream) return stream;
  // voe often stores obfuscated source
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
  // prompt('...') pattern
  var p = html.match(/prompt\s*\(\s*['"]([A-Za-z0-9+/=]+)['"]/);
  if (p) {
    try {
      stream = findStreamInText(atob(p[1]));
      if (stream) return stream;
    } catch (e) {}
  }
  return null;
}

async function extractFromGeneric(embedUrl) {
  var html = await getSoft(embedUrl, "https://embed69.org/");
  if (!html || html.length < 400) return null;
  // unpack first (vidhide/filemoon hide links inside packer)
  var unpacked = unpackPacker(html);
  if (unpacked) {
    var stream = findStreamInText(unpacked);
    if (stream) return stream;
    // links.hls / links.hls2 patterns after unpack
    var hls = unpacked.match(
      /(?:hls\d*|file)\s*:\s*["'](https?:\/\/[^"']+m3u8[^"']*)["']/i
    );
    if (!hls)
      hls = unpacked.match(
        /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i
      ) || unpacked.match(/https?:\/\/[^"'\s<>]+m3u8[^"'\s<>]*/i);
    if (hls) {
      var u = (hls[1] || hls[0]).replace(/\u0026/g, "&").replace(/\/g, "");
      return { url: u, mime: "application/x-mpegURL" };
    }
  }
  return findStreamInText(html);
}

async function extractFromVidhide(embedUrl) {
  return await extractFromGeneric(embedUrl);
}

async function extractStreamFromEmbed(embed) {
  var url = embed.url;
  var host = "";
  try {
    host = url.split("/")[2] || "";
  } catch (e) {}
  var stream = null;
  var tag = (host + " " + (embed.serverRaw || "") + " " + (embed.server || "")).toLowerCase();
  if (/vidhide|hide|morencius|earnvids|pixeldrain/i.test(tag) || /morencius|vidhide/i.test(url)) {
    stream = await extractFromVidhide(url);
  } else if (/streamwish|hglink|swhoi|strwish|wish/i.test(tag) || /hglink|swhoi|strwish|streamwish/i.test(url)) {
    stream = await extractFromStreamwish(url);
    if (!stream) stream = await extractFromGeneric(url);
  } else if (/voe/i.test(tag) || /voe\.sx/i.test(url)) {
    stream = await extractFromVoe(url);
    if (!stream) stream = await extractFromGeneric(url);
  } else {
    stream = await extractFromGeneric(url);
    if (!stream && /wish|hglink|swhoi/i.test(url)) {
      stream = await extractFromStreamwish(url);
    }
  }
  if (stream) {
    stream.label = embed.lang + " · " + embed.server;
    stream.headers = {
      Referer: url,
      "User-Agent": UA,
    };
  }
  return stream;
}

/** From a vidurl/embed69 player page → list of playable streams */
async function resolvePlayerPage(playerUrl) {
  var html = await getSoft(playerUrl, BASE + "/");
  if (!html) return [];
  var embeds = decryptEmbed69Page(html);
  // also if page is already an intermediate without POW (rare)
  if (!embeds.length) {
    var direct = findStreamInText(html);
    if (direct) return [direct];
  }
  var streams = [];
  // limit to avoid blowing request budget (60 max)
  var max = Math.min(embeds.length, 6);
  for (var i = 0; i < max; i++) {
    try {
      var s = await extractStreamFromEmbed(embeds[i]);
      if (s && s.url) streams.push(s);
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
  var html = await get(path);
  var parsed = parsePageItems(html, path);
  var items = rank(parsed.items, q);
  if (parsed.next) return { items: items, next: parsed.next };
  return items;
}

export async function home() {
  var used = {};
  function take(list, n) {
    var out = [];
    for (var i = 0; i < list.length && out.length < n; i++) {
      var it = list[i];
      var key = it.ref || it.id;
      if (used[key]) continue;
      used[key] = true;
      out.push(it);
    }
    return out;
  }

  async function loadPath(path, n) {
    try {
      var html = await get(path);
      return take(parseItems(html), n || 20);
    } catch (e) {
      return [];
    }
  }

  var rows = [];
  var html = await get("/");

  var latest = take(parseLatestEpisodes(html), 20);
  if (latest.length) {
    rows.push({
      id: "ultimos-episodios",
      title: "Últimos episodios",
      items: latest,
      ref: "/?section=ultimos",
      genre: "series",
    });
  }

  function sectionItems(label) {
    var idx = html.search(
      new RegExp("<h[12][^>]*>\\s*(?:<[^>]+>\\s*)*" + label, "i")
    );
    if (idx < 0) return [];
    return parseItems(html.slice(idx, idx + 25000));
  }

  var pelisHome = take(sectionItems("Películas"), 20);
  if (!pelisHome.length) pelisHome = await loadPath("/peliculas", 20);
  if (pelisHome.length) {
    rows.push({
      id: "peliculas",
      title: "Películas recientes",
      items: pelisHome,
      ref: "/peliculas",
      genre: "peliculas",
    });
  }

  var seriesHome = take(sectionItems("Series"), 20);
  if (!seriesHome.length) seriesHome = await loadPath("/series", 20);
  if (seriesHome.length) {
    rows.push({
      id: "series",
      title: "Series recientes",
      items: seriesHome,
      ref: "/series",
      genre: "series",
    });
  }

  var animeHome = take(sectionItems("Anime"), 20);
  if (!animeHome.length) animeHome = await loadPath("/animes", 20);
  if (animeHome.length) {
    rows.push({
      id: "anime",
      title: "Anime reciente",
      items: animeHome,
      ref: "/animes",
      genre: "anime",
    });
  }

  var extras = [
    { id: "pelis-pop", title: "Películas populares", path: "/peliculas/populares", genre: "peliculas" },
    { id: "series-pop", title: "Series populares", path: "/series/populares", genre: "series" },
    { id: "anime-pop", title: "Anime popular", path: "/animes/populares", genre: "anime" },
    { id: "doramas", title: "Doramas", path: "/generos/dorama", genre: "series" },
    { id: "accion", title: "Acción", path: "/generos/accion", genre: "peliculas" },
    { id: "comedia", title: "Comedia", path: "/generos/comedia", genre: "peliculas" },
    { id: "terror", title: "Terror", path: "/generos/terror", genre: "peliculas" },
    { id: "drama", title: "Drama", path: "/generos/drama", genre: "series" },
    { id: "ciencia-ficcion", title: "Ciencia ficción", path: "/generos/ciencia-ficcion", genre: "peliculas" },
    { id: "romance", title: "Romance", path: "/generos/romance", genre: "series" },
    { id: "suspense", title: "Suspense", path: "/generos/suspense", genre: "peliculas" },
    { id: "fantasia", title: "Fantasía", path: "/generos/fantasia", genre: "peliculas" },
    { id: "animacion", title: "Animación", path: "/generos/animacion", genre: "peliculas" },
    { id: "crimen", title: "Crimen", path: "/generos/crimen", genre: "series" },
    { id: "misterio", title: "Misterio", path: "/generos/misterio", genre: "series" },
    { id: "year-2026", title: "Estrenos 2026", path: "/year/2026", genre: "peliculas" },
    { id: "year-2025", title: "Del 2025", path: "/year/2025", genre: "peliculas" },
  ];

  for (var e = 0; e < extras.length; e++) {
    var ex = extras[e];
    var items = await loadPath(ex.path, 18);
    if (items.length >= 3) {
      rows.push({
        id: ex.id,
        title: ex.title,
        items: items,
        ref: ex.path,
        genre: ex.genre,
      });
    }
  }

  if (!rows.length) {
    var any = take(parseItems(html), 20);
    if (any.length)
      rows.push({ id: "inicio", title: "Inicio", items: any, ref: "/" });
  }
  return rows;
}

export async function browse(ref, cursor) {
  var path = ref || "/";
  if (cursor) path = cursor;
  if (path.indexOf("http") === 0) path = pathFromUrl(path);
  if (path === "/?section=ultimos") {
    return { items: parseLatestEpisodes(await get("/")), next: null };
  }
  var html = await get(path);
  var parsed = parsePageItems(html, path);
  return { items: parsed.items, next: parsed.next || undefined };
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
  if (pm) poster = verticalPoster(pm[1]);

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

  // Buscar still horizontal (16:9) en la página para backdrop de la serie
  var backdrop = undefined;
  var allImgs = html.match(/https:\/\/image\.tmdb\.org\/t\/p\/[^"'\s<>]+/g) || [];
  // En fichas de episodio el póster del header suele ser still 16:9; en serie casi todo es vertical
  if (/\/capitulo\//i.test(path) && allImgs.length) {
    backdrop = horizontalBackdrop(allImgs[0]);
  } else if (poster) {
    backdrop = horizontalBackdrop(poster);
  }

  return {
    series: {
      title: title || undefined,
      poster: poster || undefined,
      backdrop: backdrop,
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
  var html = await get(pagePath);
  var players = parsePlayers(html);

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
