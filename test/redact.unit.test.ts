// Secret masking: unmasked values would land in transcripts.
import { expect, test } from "vitest";
import { maskBody, maskHeaders, maskUrl, scrubErrorText } from "../src/daemon/redact.js";
import { validateProfileName } from "../src/paths.js";

test("URLs: credentials in query, fragment and userinfo are masked, the rest is untouched", () => {
  expect(maskUrl("https://api.example.com/v1/items?page=2&access_token=abc123&q=shoes")).toBe("https://api.example.com/v1/items?page=2&access_token=***(6 chars)&q=shoes");
  expect(maskUrl("https://user:pa55@example.com/x")).toBe("https://***@example.com/x");
  expect(maskUrl("https://example.com/cb#id_token=eyJhbGciOi.xyz&state=1")).toMatch(/#id_token=\*\*\*\(\d+ chars\)&state=\*\*\*/);
  expect(maskUrl("https://example.com/oauth?code=4/0AbCd&scope=email")).toBe("https://example.com/oauth?code=***(7 chars)&scope=email");
  expect(maskUrl("https://example.com/plain?page=3")).toBe("https://example.com/plain?page=3");
});

test("headers: cookies, authorization and set-cookie values are masked, names kept", () => {
  const h = maskHeaders({
    cookie: "sessionid=abcdef; theme=dark",
    authorization: "Bearer abcdefghijkl",
    "set-cookie": "sid=SECRET1; Path=/; HttpOnly\nother=SECRET2; Secure",
    "x-api-key": "k-123456",
    "content-type": "application/json",
    location: "https://example.com/next?token=zzz",
  });
  expect(h.cookie).toBe("sessionid=***(6 chars); theme=***(4 chars)");
  expect(h.authorization).not.toContain("abcdefghijkl");
  expect(h["set-cookie"]).toBe("sid=***(7 chars); Path=/; HttpOnly\nother=***(7 chars); Secure");
  expect(h["x-api-key"]).toBe("***(8 chars)");
  expect(h["content-type"]).toBe("application/json");
  expect(h.location).toBe("https://example.com/next?token=***(3 chars)");
});

test("bodies: JSON fields, form fields, bearer values and JWTs", () => {
  const json = JSON.parse(maskBody(JSON.stringify({ user: "ann", password: "hunter2", nested: { accessToken: "tok", list: [{ api_key: "k" }] }, note: "Bearer abcdefgh12345 inside text" })));
  expect(json.user).toBe("ann");
  expect(json.password).toBe("***(7 chars)");
  expect(json.nested.accessToken).toBe("***(3 chars)");
  expect(json.nested.list[0].api_key).toBe("***(1 chars)");
  expect(json.note).toBe("Bearer *** inside text");
  expect(maskBody("username=ann&password=hunter2&csrf_token=xyz")).toBe("username=ann&password=***(7 chars)&csrf_token=***(3 chars)");
  expect(maskBody("<p>token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl here</p>")).toBe("<p>token ***(jwt) here</p>");
});

test("error text quoting an element does not leak its value", () => {
  expect(scrubErrorText(`locator resolved to <input type="password" value="hunter2" name="pw"/>`)).toContain('value="***"');
});

test("profile names cannot leave the profiles directory", () => {
  for (const ok of ["default", "github-bot", "a1", "0x"]) expect(validateProfileName(ok)).toBe(ok);
  for (const bad of ["", "..", "../x", "a/b", "A", "-a", "a_b", "a b", "a.b", "x".repeat(65), null, 5]) expect(() => validateProfileName(bad as any), String(bad)).toThrow();
});
