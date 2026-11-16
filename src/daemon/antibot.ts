// Group `antibot`: is this a challenge page, and what does a page see of us (05, 07).
// The server solves nothing: on a challenge page the agent hands over to the user,
// who can solve it in the visible window.
import { evalWithin } from "./navigation.js";
import type { Tab } from "./tabs.js";

interface Probe {
  title: string;
  url: string;
  textLen: number;
  text: string;
  marks: Record<string, boolean>;
}

const PROBE_JS = `(function () {
  function has(sel) { try { return !!document.querySelector(sel); } catch (e) { return false; } }
  var body = document.body, text = body ? (body.innerText || "") : "";
  return JSON.stringify({
    title: document.title || "",
    url: location.href,
    textLen: text.length,
    text: text.slice(0, 3000).toLowerCase(),
    marks: {
      cfChallenge: has("#challenge-form, #challenge-running, #cf-challenge-running, #challenge-stage, #challenge-error-text, .cf-turnstile-wrapper, script[src*='/cdn-cgi/challenge-platform/h/'][src*='orchestrate']") || (typeof window._cf_chl_opt !== "undefined"),
      cfScript: has("script[src*='/cdn-cgi/challenge-platform/']"),
      turnstile: has("iframe[src*='challenges.cloudflare.com'], .cf-turnstile, script[src*='challenges.cloudflare.com/turnstile']"),
      datadome: has("iframe[src*='captcha-delivery.com'], script[src*='captcha-delivery.com'], script[src*='ct.captcha-delivery.com']"),
      px: has("#px-captcha, [id^='px-captcha'], script[src*='/captcha/captcha.js'], iframe[src*='px-cdn.net'], iframe[src*='px-cloud.net']"),
      incapsula: has("iframe[src*='_Incapsula_Resource'], script[src*='_Incapsula_Resource']"),
      akamai: has("script[src*='akam/'], script[src*='/_bm/']"),
      recaptcha: has("iframe[src*='recaptcha'], .g-recaptcha, #recaptcha"),
      hcaptcha: has("iframe[src*='hcaptcha.com'], .h-captcha"),
      arkose: has("iframe[src*='arkoselabs.com'], iframe[src*='funcaptcha.com']"),
      awsWaf: has("script[src*='awswaf.com'], #captcha-container awswaf-captcha, awswaf-captcha"),
      geetest: has(".geetest_holder, script[src*='geetest.com']"),
    },
  });
})()`;

export interface Finding {
  /** A page that stands between the agent and the site. */
  challenge: string | null;
  /** Protection or captcha widgets present on an otherwise normal page. */
  present: string[];
  evidence: string[];
}

export async function detect(tab: Tab): Promise<Finding> {
  const raw = await evalWithin<string>(tab.page, PROBE_JS, 3000);
  const finding: Finding = { challenge: null, present: [], evidence: [] };
  if (!raw) return finding;
  const p: Probe = JSON.parse(raw);
  const title = p.title.toLowerCase();
  const says = (...needles: string[]) => needles.some((n) => p.text.includes(n) || title.includes(n));
  // The response the document itself came with.
  let pageUrl = p.url.split("#")[0];
  const doc = [...tab.requests].reverse().find((r) => r.resourceType === "document" && r.url.split("#")[0] === pageUrl);
  const status = doc?.status ?? null;
  const h = doc?.responseHeaders ?? {};
  const blockedStatus = status !== null && [401, 403, 429, 503].includes(status);
  const thin = p.textLen < 1500;
  const m = p.marks;
  const set = (vendor: string, why: string) => {
    if (!finding.challenge) finding.challenge = vendor;
    finding.evidence.push(why);
  };

  if (h["cf-mitigated"] === "challenge") set("Cloudflare", "response header cf-mitigated: challenge");
  if (m.cfChallenge && (thin || blockedStatus)) set("Cloudflare", "Cloudflare challenge elements on a page with almost no content");
  if ((title.includes("just a moment") || title.includes("attention required")) && (m.cfScript || /cloudflare/i.test(h["server"] || ""))) set("Cloudflare", `title ${JSON.stringify(p.title)}`);
  if (says("verifying you are human", "checking your browser before accessing", "verify you are human by completing the action below") && thin) set("Cloudflare", "interstitial text");
  if (m.datadome && (thin || blockedStatus)) set("DataDome", "captcha-delivery.com frame on a page with almost no content");
  if (h["x-datadome"] && blockedStatus) set("DataDome", `x-datadome header with status ${status}`);
  if (m.px && (thin || blockedStatus || says("press & hold", "press and hold"))) set("HUMAN (PerimeterX)", "px-captcha on a page with almost no content");
  if (says("access to this page has been denied") && thin) set("HUMAN (PerimeterX)", "block page text");
  if (m.incapsula && thin) set("Imperva (Incapsula)", "_Incapsula_Resource on a page with almost no content");
  if (says("incapsula incident id")) set("Imperva (Incapsula)", "incident id on the page");
  if (blockedStatus && thin && says("access denied") && (says("errors.edgesuite.net", "reference #") || /akamai/i.test(h["server"] || ""))) set("Akamai", `access denied page with status ${status}`);
  if (m.awsWaf && thin) set("AWS WAF", "awswaf captcha on a page with almost no content");
  if (/google\.[a-z.]+\/sorry\//.test(p.url) || (says("unusual traffic from your computer network") && thin)) set("Google", "unusual-traffic page");
  if (m.arkose && thin) set("Arkose Labs", "FunCaptcha frame on a page with almost no content");
  if (!finding.challenge && thin && (m.recaptcha || m.hcaptcha || m.geetest) && (blockedStatus || says("are you a robot", "are you human", "verify you are human", "not a robot", "security check"))) {
    set(m.hcaptcha ? "hCaptcha" : m.geetest ? "GeeTest" : "reCAPTCHA", "a captcha is all there is on the page");
  }
  if (!finding.challenge && blockedStatus && thin && says("captcha", "verify you are human", "are you a robot", "bot detection", "automated access", "unusual activity")) {
    set("unknown vendor", `status ${status} and a page that asks for verification`);
  }

  const widgets: [boolean, string][] = [
    [m.turnstile, "Cloudflare Turnstile widget"],
    [m.cfScript && !finding.challenge, "Cloudflare bot management script"],
    [m.recaptcha, "reCAPTCHA"],
    [m.hcaptcha, "hCaptcha"],
    [m.datadome && finding.challenge !== "DataDome", "DataDome script"],
    [m.px && finding.challenge !== "HUMAN (PerimeterX)", "HUMAN (PerimeterX) script"],
    [m.akamai, "Akamai Bot Manager script"],
    [m.arkose, "Arkose Labs"],
    [m.geetest, "GeeTest"],
    [m.incapsula && !finding.challenge, "Imperva script"],
  ];
  for (const [on, name] of widgets) if (on && name !== finding.challenge) finding.present.push(name);
  if (status !== null) finding.evidence.push(`document status ${status}`);
  return finding;
}

/** The line navigate / click replies carry on a challenge page, so the agent stops instead of retrying (07). */
export async function challengeLine(tab: Tab): Promise<string | null> {
  const f = await detect(tab).catch(() => null);
  if (!f?.challenge) return null;
  return `challenge page (${f.challenge}): hand over to the user - they can solve it in the profile's window; do not retry or try to solve it.`;
}

export const AUDIT_JS = `(async function () {
  var out = {};
  function grab(name, fn) { try { out[name] = fn(); } catch (e) { out[name] = "error: " + (e && e.message); } }
  grab("userAgent", function () { return navigator.userAgent; });
  grab("platform", function () { return navigator.platform; });
  grab("oscpu", function () { return navigator.oscpu; });
  grab("vendor", function () { return navigator.vendor; });
  grab("languages", function () { return Array.prototype.slice.call(navigator.languages || []); });
  grab("language", function () { return navigator.language; });
  grab("hardwareConcurrency", function () { return navigator.hardwareConcurrency; });
  grab("deviceMemory", function () { return navigator.deviceMemory; });
  grab("maxTouchPoints", function () { return navigator.maxTouchPoints; });
  grab("webdriver", function () { return navigator.webdriver; });
  grab("cookieEnabled", function () { return navigator.cookieEnabled; });
  grab("doNotTrack", function () { return navigator.doNotTrack; });
  grab("globalPrivacyControl", function () { return navigator.globalPrivacyControl; });
  grab("pdfViewerEnabled", function () { return navigator.pdfViewerEnabled; });
  grab("plugins", function () { return navigator.plugins.length; });
  grab("screen", function () { return { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth }; });
  grab("window", function () { return { innerWidth: innerWidth, innerHeight: innerHeight, outerWidth: outerWidth, outerHeight: outerHeight, screenX: screenX, screenY: screenY, devicePixelRatio: devicePixelRatio }; });
  grab("timezone", function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; });
  grab("timezoneOffset", function () { return new Date().getTimezoneOffset(); });
  grab("intlLocale", function () { return Intl.DateTimeFormat().resolvedOptions().locale; });
  grab("visibility", function () { return document.visibilityState; });
  grab("hasFocus", function () { return document.hasFocus(); });
  grab("webgl", function () {
    var c = document.createElement("canvas"), gl = c.getContext("webgl") || c.getContext("experimental-webgl");
    if (!gl) return null;
    var ext = gl.getExtension("WEBGL_debug_renderer_info");
    return { vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR), renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
  });
  grab("prefersColorScheme", function () { return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; });
  grab("pointer", function () { return matchMedia("(pointer: fine)").matches ? "fine" : matchMedia("(pointer: coarse)").matches ? "coarse" : "none"; });
  grab("automationGlobals", function () { return Object.getOwnPropertyNames(window).filter(function (k) { return /^(__playwright|__pw|__puppeteer|_phantom|callPhantom|__nightmare|domAutomation|_selenium|__webdriver|cdc_)/i.test(k); }); });
  try { var perm = await navigator.permissions.query({ name: "notifications" }); out.notifications = { permission: typeof Notification !== "undefined" ? Notification.permission : null, query: perm.state }; } catch (e) { out.notifications = null; }
  return JSON.stringify(out);
})()`;

/** Contradictions a fingerprinting script could notice. */
export function contradictions(fp: any, requestHeaders: Record<string, string> | null): string[] {
  const out: string[] = [];
  const ua = String(fp.userAgent || "");
  const uaOs = /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /Linux|X11/.test(ua) ? "Linux" : "unknown";
  const platform = String(fp.platform || "");
  const platOs = /^Win/.test(platform) ? "Windows" : /^Mac/.test(platform) ? "macOS" : /Linux|X11/.test(platform) ? "Linux" : "unknown";
  if (uaOs !== "unknown" && platOs !== "unknown" && uaOs !== platOs && !(uaOs === "Android" && platOs === "Linux")) out.push(`user agent says ${uaOs}, navigator.platform says ${platform}`);
  if (fp.oscpu && uaOs === "Windows" && !/Windows/.test(fp.oscpu)) out.push(`user agent says Windows, navigator.oscpu says ${fp.oscpu}`);
  if (fp.webdriver === true) out.push("navigator.webdriver is true");
  if (Array.isArray(fp.automationGlobals) && fp.automationGlobals.length) out.push(`automation globals on window: ${fp.automationGlobals.join(", ")}`);
  const w = fp.window || {}, sc = fp.screen || {};
  if (w.outerWidth && w.innerWidth > w.outerWidth) out.push(`innerWidth ${w.innerWidth} is larger than outerWidth ${w.outerWidth}`);
  if (w.outerHeight && w.innerHeight > w.outerHeight) out.push(`innerHeight ${w.innerHeight} is larger than outerHeight ${w.outerHeight}`);
  if (sc.width && w.outerWidth > sc.width) out.push(`the window (${w.outerWidth} wide) is larger than the screen (${sc.width})`);
  if (sc.height && w.outerHeight > sc.height) out.push(`the window (${w.outerHeight} high) is larger than the screen (${sc.height})`);
  if (sc.availWidth > sc.width || sc.availHeight > sc.height) out.push("the available screen is larger than the screen");
  if (w.outerWidth === 0 || w.outerHeight === 0) out.push("outer window size is 0 (a headless tell)");
  if (Array.isArray(fp.languages)) {
    if (!fp.languages.length) out.push("navigator.languages is empty");
    else if (fp.language && fp.languages[0] !== fp.language) out.push(`navigator.language ${fp.language} is not the first of navigator.languages (${fp.languages[0]})`);
  }
  if (fp.webgl && typeof fp.webgl.renderer === "string") {
    const r = fp.webgl.renderer;
    if (/SwiftShader|llvmpipe|Software/i.test(r)) out.push(`WebGL renderer is a software renderer (${r})`);
    if (uaOs === "macOS" && /Direct3D|ANGLE \(.*D3D/i.test(r)) out.push(`user agent says macOS, WebGL renderer is ${r}`);
    if (uaOs === "Windows" && /Apple|Metal/i.test(r)) out.push(`user agent says Windows, WebGL renderer is ${r}`);
  } else if (fp.webgl === null) out.push("WebGL is unavailable");
  if (fp.notifications && fp.notifications.permission === "denied" && fp.notifications.query === "prompt") out.push("Notification.permission is denied while the permission query says prompt (a headless tell)");
  if (typeof fp.hardwareConcurrency === "number" && (fp.hardwareConcurrency < 1 || fp.hardwareConcurrency > 128)) out.push(`implausible hardwareConcurrency ${fp.hardwareConcurrency}`);
  if (requestHeaders) {
    const sent = requestHeaders["user-agent"];
    if (sent && sent !== ua) out.push("the User-Agent header differs from navigator.userAgent");
    const al = requestHeaders["accept-language"];
    if (al && Array.isArray(fp.languages) && fp.languages[0] && !al.toLowerCase().startsWith(String(fp.languages[0]).toLowerCase())) {
      out.push(`Accept-Language (${al}) does not start with navigator.languages[0] (${fp.languages[0]})`);
    }
  }
  return out;
}
