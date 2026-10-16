// Browser fingerprint the whole library impersonates. The User-Agent is sent on
// every HTTP call AND serialized into each protobuf request
// (ProductContext.user_agent / device_os), so it lives in exactly one place.
// Chrome major re-synced 2026-10-16 (155); re-check against Chrome Stable when
// revisiting.
const SIMULATED_BROWSER = {
  agent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  platform: "Windows",
  uaBrands: '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
  language: "en-US",
  // A real tab reports its own zone, and the model uses it for anything
  // time-related ("what's the date?"), so report the host's instead of pinning.
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
};

// Headers for meta.ai's own HTTP endpoints (HTML, GraphQL, uploads).
function buildBrowserHeaders({accept = "application/json", referer = "https://www.meta.ai/"} = {}) {
  return {
    accept,
    "accept-language": SIMULATED_BROWSER.language,
    origin: "https://www.meta.ai",
    referer,
    "user-agent": SIMULATED_BROWSER.agent,
    "sec-ch-ua": SIMULATED_BROWSER.uaBrands,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"${SIMULATED_BROWSER.platform}"`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };
}

module.exports = {SIMULATED_BROWSER, buildBrowserHeaders};
