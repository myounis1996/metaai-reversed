const fs = require("fs");

// name → value, loaded from a browser cookie export (JSON array of
// {name, value, domain, …}) or a Cookie header string.
// meta.ai only needs `datr` + `ecto_1_sess` (plus `abra_sess` in some regions),
// but every exported cookie is sent, exactly as the browser would.
class CookieJar {
  constructor(entries = []) {
    this._map = new Map();
    for (const entry of entries) {
      if (entry && typeof entry.name === "string") this._map.set(entry.name, entry.value);
    }
  }

  static fromFile(filePath) {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(parsed)) {
      throw new Error(`Cookie file must contain a JSON array, got ${typeof parsed}`);
    }
    return new CookieJar(parsed);
  }

  static fromHeader(headerString) {
    if (typeof headerString !== "string") {
      throw new Error(`CookieJar.fromHeader expected a string, got ${typeof headerString}`);
    }
    const jar = new CookieJar();
    for (const pair of headerString.split(/;\s*/)) {
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return jar;
  }

  // Accepts every shape the auth clients take: CookieJar | array | JSON string
  // | Cookie header string, or a path via `cookiesPath`. A string starting with
  // `[`/`{` is JSON, anything else is a header.
  static resolve({cookies, cookiesPath} = {}) {
    if (cookies instanceof CookieJar) return cookies;
    if (Array.isArray(cookies)) return new CookieJar(cookies);
    if (typeof cookies === "string") {
      const trimmed = cookies.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch (err) {
          throw new Error(`\`cookies\` looked like JSON but failed to parse: ${err.message}`);
        }
        if (!Array.isArray(parsed)) throw new Error("`cookies` JSON must decode to an array of cookie objects");
        return new CookieJar(parsed);
      }
      return CookieJar.fromHeader(trimmed);
    }
    if (typeof cookiesPath === "string") return CookieJar.fromFile(cookiesPath);
    throw new Error(
      "Auth client requires `cookies` (CookieJar | array | JSON string | Cookie header string) or `cookiesPath`"
    );
  }

  get(name) {
    return this._map.get(name);
  }

  set(name, value) {
    this._map.set(name, value);
    return this;
  }

  has(name) {
    return this._map.has(name);
  }

  // Read Set-Cookie header(s) into the jar; an expired/zero max-age cookie is
  // a deletion.
  absorb(setCookieList) {
    for (const raw of [].concat(setCookieList || [])) {
      const parts = String(raw).split(";");
      const eq = parts[0].indexOf("=");
      if (eq < 1) continue;
      const name = parts[0].slice(0, eq).trim();
      const attrs = parts.slice(1).map((p) => p.trim().toLowerCase());
      const maxAge = attrs.find((a) => a.startsWith("max-age="));
      const expires = attrs.find((a) => a.startsWith("expires="));
      const deleted =
        (maxAge && Number(maxAge.slice(8)) <= 0) || (expires && Date.parse(expires.slice(8)) <= Date.now());
      if (deleted) this._map.delete(name);
      else this._map.set(name, parts[0].slice(eq + 1).trim());
    }
    return this;
  }

  toHeader() {
    return [...this._map].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  get size() {
    return this._map.size;
  }
}

module.exports = {CookieJar};
