import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDom, settle } from "../test-support/dom.mjs";

const SOURCE = readFileSync(new URL("../assets/inpage.js", import.meta.url), "utf8");

/** Everything the panel creates lives under a single element with this id. */
const PANEL_ID = "dsh-remote-signin-panel";

/** Depth-first walk over the stub tree. */
function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

const find = (root, predicate) => {
  let hit = null;
  walk(root, (node) => {
    if (hit === null && predicate(node)) hit = node;
  });
  return hit;
};

const panel = (document) => document.body.findById(PANEL_ID);
const textarea = (document) => find(panel(document), (node) => node.tagName === "TEXTAREA");
const submitButton = (document) => find(panel(document), (node) => node.tagName === "BUTTON" && node.className !== "rs-close");
const statusLine = (document) => find(panel(document), (node) => node.className === "rs-status");
const hint = (document) => find(panel(document), (node) => node.tagName === "P");

/** Boot the panel with a scripted sequence of fetch answers. */
async function boot(answers, { lang = "zh" } = {}) {
  const queue = [...answers];
  const dom = createDom({
    lang,
    fetch: () => queue.shift() ?? { status: 404, type: "basic" },
  });
  dom.run(SOURCE);
  await settle();
  await settle();
  return dom;
}

test("the panel stays away while no sign-in is waiting", async () => {
  const dom = await boot([{ status: 404, type: "basic" }]);
  assert.equal(panel(dom.document), null, "a 404 from /oauth/callback must not build the panel");
  assert.equal(dom.calls[0].url, "/oauth/callback");
  assert.equal(dom.calls[0].init.credentials, "same-origin");
  assert.equal(dom.calls[0].init.redirect, "manual");
  assert.equal(dom.timers.length, 1, "the panel keeps exactly one poll scheduled");
});

test("the panel appears by itself while a sign-in waits", async () => {
  const dom = await boot([{ status: 400, type: "basic" }]);
  const root = panel(dom.document);
  assert.ok(root, "a waiting sign-in (400 from the callback route) must show the panel");
  assert.notEqual(root.style.display, "none");
  assert.match(hint(dom.document).textContent, /127\.0\.0\.1/);
  assert.match(textarea(dom.document).placeholder, /127\.0\.0\.1/);
});

test("the panel hides again once the attempt is gone", async () => {
  const dom = await boot([{ status: 400, type: "basic" }, { status: 404, type: "basic" }]);
  assert.notEqual(panel(dom.document).style.display, "none");
  await dom.flushTimers();
  assert.equal(panel(dom.document).style.display, "none", "the panel must disappear when nothing waits");
});

test("an attempt later on shows the panel again, dismissal and all", async () => {
  const dom = await boot([
    { status: 400, type: "basic" }, // attempt 1
    { status: 404, type: "basic" }, // it ends
    { status: 400, type: "basic" }, // attempt 2
  ]);
  const close = find(panel(dom.document), (node) => node.className === "rs-close");
  close.click();
  assert.equal(panel(dom.document).style.display, "none");
  await dom.flushTimers(); // → 404: the attempt ended, so the dismissal is cleared
  await dom.flushTimers(); // → 400: a new attempt
  assert.notEqual(panel(dom.document).style.display, "none", "a new attempt must show the panel again");
});

test("a redirect from the proxy in front of DSH is not a sign-in, let alone a finished one", async () => {
  // SWAG/Authelia answer an unauthenticated request with a 302 to the SSO page; the
  // browser's `redirect: "manual"` fetch sees only an opaque redirect. Reading that as
  // "somebody completed the sign-in" is what made this panel appear unasked.
  const dom = await boot([{ status: 0, type: "opaqueredirect" }]);
  assert.equal(panel(dom.document), null, "a proxy redirect must not build the panel");
  assert.equal(dom.calls.length, 1, "nothing else is fetched to decide it");
});

test("a redirect while an attempt waited hides the panel instead of claiming success", async () => {
  const dom = await boot([{ status: 400, type: "basic" }, { status: 0, type: "opaqueredirect" }]);
  assert.notEqual(panel(dom.document).style.display, "none");
  await dom.flushTimers();
  assert.equal(panel(dom.document).style.display, "none", "a redirect is 'cannot see', not 'signed in'");
  assert.doesNotMatch(statusLine(dom.document).textContent, /登录完成/);
});

test("a new attempt starts with a clean status line", async () => {
  const dom = await boot([
    { status: 400, type: "basic" }, // attempt 1 waits
    { status: 400, type: "basic" }, // its code was rejected
    { status: 404, type: "basic" }, // the attempt ends
    { status: 400, type: "basic" }, // attempt 2
  ]);
  textarea(dom.document).value = "http://127.0.0.1:47821/oauth/callback?code=abc&state=def";
  submitButton(dom.document).click();
  await settle();
  assert.match(statusLine(dom.document).textContent, /state 不匹配/);
  await dom.flushTimers(); // → 404: nothing waits any more
  await dom.flushTimers(); // → 400: a new attempt
  assert.notEqual(panel(dom.document).style.display, "none");
  assert.equal(statusLine(dom.document).textContent, "", "the previous attempt's answer must not carry over");
});

test("a pasted callback address is sent to the same origin and reported", async () => {
  const good = "http://127.0.0.1:47821/oauth/callback?code=abc&state=def";
  const cases = [
    [{ status: 0, type: "opaqueredirect" }, "登录完成", "ok"],
    [{ status: 404, type: "basic" }, "没有正在等待的登录", "error"],
    [{ status: 400, type: "basic" }, "state 不匹配", "error"],
    [{ status: 410, type: "basic" }, "已经提交过", "error"],
    [{ status: 401, type: "basic" }, "还没有 DSH 的会话", "error"],
    [new Error("network down"), "没有到达 DSH", "error"],
  ];
  for (const [answer, needle, kind] of cases) {
    // The probe, the submitted code, then the confirmation probe a redirect triggers
    // (the queue's fallback 404 answers it: the route is gone, so DSH completed it).
    const dom = await boot([{ status: 400, type: "basic" }, answer]);
    textarea(dom.document).value = good;
    submitButton(dom.document).click();
    await settle();
    await settle();
    const status = statusLine(dom.document);
    assert.match(status.textContent, new RegExp(needle), `expected ${needle} for ${JSON.stringify(answer)}`);
    assert.equal(status.dataset.kind, kind);
    assert.match(dom.calls[1].url, /^\/oauth\/callback\?code=abc&state=def$/);
  }
});

test("a redirect answered by the proxy is reported as not having reached DSH", async () => {
  // The submitted request and the confirmation probe are both redirected: the proxy in
  // front of DSH answered, so the code never arrived and the panel must not say "done".
  const dom = await boot([
    { status: 400, type: "basic" },
    { status: 0, type: "opaqueredirect" },
    { status: 0, type: "opaqueredirect" },
  ]);
  textarea(dom.document).value = "http://127.0.0.1:47821/oauth/callback?code=abc&state=def";
  submitButton(dom.document).click();
  await settle();
  await settle();
  const status = statusLine(dom.document);
  assert.match(status.textContent, /代理或 SSO/);
  assert.equal(status.dataset.kind, "error");
  assert.doesNotMatch(status.textContent, /登录完成/);
});

test("the panel refuses anything that is not this sign-in's callback address", async () => {
  const dom = await boot([{ status: 400, type: "basic" }]);
  const input = textarea(dom.document);
  const button = submitButton(dom.document);
  const refused = [
    "",
    "https://evil.example/oauth/callback?code=a&state=b",
    "http://127.0.0.1:47821/oauth/callback?code=a",
    "code=a&state=b&code=c",
    "http://192.168.3.2:47821/oauth/callback?code=a&state=b",
  ];
  for (const value of refused) {
    input.value = value;
    button.click();
    await settle();
    assert.match(
      statusLine(dom.document).textContent,
      /不是本次登录的回调地址/,
      `expected a refusal for ${JSON.stringify(value)}`,
    );
  }
  assert.equal(dom.calls.length, 1, "nothing but the probe may have been fetched");
});

test("the panel is styled from the harness design tokens, not a second look", async () => {
  const dom = await boot([{ status: 400, type: "basic" }]);
  const style = dom.document.head.children.find((node) => node.tagName === "STYLE");
  assert.ok(style, "the panel injects its own stylesheet");
  const css = style.textContent;

  // Surface, radius, elevation, colours and button fill all come from the running theme
  // (@deepseek-ai/dsh-client-ui-theme defines them on :root), so the panel follows the
  // app's light/dark setting and any future restyle instead of a look of its own.
  for (const token of [
    "--dsw-radius-lg",
    "--dsw-alias-bg-layer-2",
    "--dsw-shadow-lv3",
    "--dsw-alias-bg-layer-1",
    "--dsw-alias-border-l3",
    "--dsw-alias-label-primary",
    "--dsw-alias-label-secondary",
    "--dsw-alias-button-primary-fill",
    "--dsw-alias-button-primary-hover",
    "--dsw-alias-interactive-bg-hover",
    "--dsw-alias-state-error-primary",
    "--dsw-alias-state-success-primary",
    "--dsw-font-family",
  ]) {
    assert.match(css, new RegExp(`${token}\\s*,`), `${token} must be used, with a fallback`);
  }

  // Every colour is a token fallback, never a palette of its own: strip the var()
  // expressions (including nested ones) and nothing coloured may be left.
  let stripped = css;
  for (let pass = 0; pass < 5; pass += 1) stripped = stripped.replace(/var\([^()]*\)/g, "var()");
  assert.doesNotMatch(stripped, /#[0-9a-f]{3,8}\b/i, "colours must come from the theme, not from here");
  // The app's theme is a setting applied to the document; the OS preference is not it.
  assert.doesNotMatch(css, /prefers-color-scheme/, "follow the app theme, not the OS preference");
});

test("english locale renders english copy", async () => {
  const dom = await boot([{ status: 400, type: "basic" }], { lang: "en" });
  assert.match(hint(dom.document).textContent, /127\.0\.0\.1/);
  assert.equal(submitButton(dom.document).textContent, "Finish sign-in");
});
