// Unit tests for /auth/confirm-lib.js (email-link routing + open-redirect guard).
// Run: deno test -A groundwork/_backend/web-tests/
import { assertEquals } from "jsr:@std/assert@1";
// @ts-ignore plain JS module served by the site
import { appUrl, parseLink, resolveNext, webUrl } from "../../../auth/confirm-lib.js";

const O = "https://lostpinescreative.com";

Deno.test("next: our portals and the app are allowed", () => {
  assertEquals(resolveNext("https://lostpinescreative.com/groundwork/portal/", O),
    { kind: "web", url: "https://lostpinescreative.com/groundwork/portal/" });
  assertEquals(resolveNext("https://www.lostpinescreative.com/desmitdesigns/portal/", O).kind, "web");
  assertEquals(resolveNext("/desmitdesigns/portal/", O), { kind: "web", url: O + "/desmitdesigns/portal/" });
  assertEquals(resolveNext("https://lostpinescreative.com/auth/app", O),
    { kind: "app", url: "https://lostpinescreative.com/auth/app" });
  assertEquals(resolveNext("https://www.lostpinescreative.com/auth/app", O).kind, "app");
});

Deno.test("next: a custom scheme never receives a token (any app can claim lostpines://)", () => {
  for (const bad of ["lostpines://auth", "lostpines://evil", "LOSTPINES://auth", "lostpines://auth?x=1"]) {
    assertEquals(resolveNext(bad, O), { kind: "web", url: O + "/" }, bad);
  }
});

Deno.test("next: anything else falls back to home (no open redirect)", () => {
  for (const bad of [
    "https://evil.example/", "//evil.example/x", "/\\evil.example", "http://lostpinescreative.com/",
    "https://lostpinescreative.com.evil.example/", "javascript:alert(1)", "", "https://localhost/",
  ]) assertEquals(resolveNext(bad, O), { kind: "web", url: O + "/" }, bad);
});

Deno.test("next: localhost only when the page itself is on localhost", () => {
  assertEquals(resolveNext("http://localhost:8080/groundwork/portal/", "http://localhost:8080").kind, "web");
  assertEquals(resolveNext("http://localhost:8080/x", O).url, O + "/");
});

Deno.test("app hand-off carries the token untouched; recovery opens the set-password view", () => {
  assertEquals(appUrl("https://lostpinescreative.com/auth/app", "abc123", "recovery"),
    "https://lostpinescreative.com/auth/app?token_hash=abc123&type=recovery");
  assertEquals(webUrl(O + "/groundwork/portal/#old", "recovery"), O + "/groundwork/portal/#lpc-recovery");
  assertEquals(webUrl(O + "/groundwork/portal/", "magiclink"), O + "/groundwork/portal/");
});

Deno.test("malformed links are rejected", () => {
  assertEquals(parseLink("?token_hash=abc123def&type=recovery&next=/x")?.type, "recovery");
  assertEquals(parseLink("?token_hash=abc123def&type=sms"), null);
  assertEquals(parseLink("?type=recovery"), null);
  assertEquals(parseLink("?token_hash=<script>&type=signup"), null);
});
