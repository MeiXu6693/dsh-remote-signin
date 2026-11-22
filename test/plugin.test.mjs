import assert from "node:assert/strict";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import { BRIDGE_HEADER, CALLBACK_PATH, PANEL_PATH, STATE_PATH, apply, bridgeCallback } from "../src/index.js";

/**
 * A Cordis context stub recording everything the plugin touches.
 *
 * The fake service class is created per context on purpose: the plugin patches the
 * *prototype*, and a prototype is per-import (i.e. per-process) in the real thing — a
 * module-level class would leak one test's wrapper into the next, which is exactly the
 * bug this harness should not have.
 */
function fakeContext() {
  class FakeAccount {
    constructor() {
      this.calls = [];
      /** Set to a promise to model an attempt that is still in flight. */
      this.answer = undefined;
    }
    startSignIn(client, callbackOrigin, loginSource) {
      this.calls.push({ client, callbackOrigin, loginSource });
      return this.answer ?? { ok: true };
    }
    /** What upstream reports for /remote-signin/state; tests set the phase. */
    state = { status: "signed-out", attempt: null };
    getState() {
      return this.state;
    }
  }
  const service = new FakeAccount();
  const routes = new Map();
  const effects = [];
  const listeners = new Map();
  const webServer = {
    port: 3080,
    protocol: "http:",
    getOrigin() {
      return `http://127.0.0.1:${this.port}`;
    },
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
  const webCtx = {
    webServer,
    effect(factory, label) {
      effects.push({ label, dispose: factory() });
      return () => {};
    },
    on(event, handler) {
      (listeners.get(event) ?? listeners.set(event, []).get(event)).push(handler);
      return () => {};
    },
  };
  const ctx = {
    deepseekAccount: service,
    inject(names, callback) {
      assert.deepEqual(names, ["webServer"]);
      callback(webCtx);
    },
    on(event, handler) {
      (listeners.get(event) ?? listeners.set(event, []).get(event)).push(handler);
    },
    emit(event, table) {
      for (const handler of listeners.get(event) ?? []) handler(table);
    },
  };
  return { ctx, service, routes, effects, listeners, webServer };
}

/**
 * Minimal ServerResponse stand-in: a real Writable so the bridge can `pipe` the listener's
 * body into it, with the recording the assertions read.
 */
class FakeResponse extends Writable {
  constructor() {
    super();
    this.written = { status: 0, headers: {}, body: undefined, ended: false, destroyed: false };
    this.finished = new Promise((resolve) => {
      this.once("finish", resolve);
      this.once("close", resolve);
    });
  }

  get headersSent() {
    return this.written.status !== 0;
  }

  writeHead(status, headers) {
    this.written.status = status;
    this.written.headers = headers ?? {};
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.written.body = (this.written.body ?? "") + String(chunk);
    callback();
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = undefined;
    }
    if (chunk !== undefined && chunk !== null) this.written.body = (this.written.body ?? "") + String(chunk);
    this.written.ended = true;
    // The chunk was recorded above; handing it to the Writable again would double it.
    return super.end(undefined, undefined, callback);
  }

  destroy(error) {
    this.written.destroyed = true;
    return super.destroy(error);
  }
}

function fakeResponse() {
  return new FakeResponse();
}

test("apply claims a remote origin, leaves loopback alone, and serves the panel", () => {
  const { ctx, service, routes } = fakeContext();
  apply(ctx, { claimOrigin: "http://127.0.0.1:47821" });

  // The claim: only a browser that is not already on loopback is rewritten.
  service.startSignIn({ locale: "zh-CN" }, "https://dsh.example.com", "web");
  service.startSignIn({ locale: "zh-CN" }, "http://127.0.0.1:3081", "web");
  assert.deepEqual(
    service.calls.map((call) => call.callbackOrigin),
    ["http://127.0.0.1:47821", "http://127.0.0.1:3081"],
  );

  // The panel script and the attempt state it polls: nothing else is served.
  assert.deepEqual([...routes.keys()].sort(), [PANEL_PATH, STATE_PATH].sort());

  const panel = fakeResponse();
  routes.get(PANEL_PATH).handler({ method: "GET" }, panel);
  assert.equal(panel.written.status, 200);
  assert.match(panel.written.headers["content-type"], /^application\/javascript/);
  assert.equal(panel.written.headers["cache-control"], "no-store");
  assert.match(panel.written.body, /remote-signin-panel/);
  assert.match(panel.written.body, /oauth\/callback/, "the panel is the only way back, so it must carry the paste logic");

  // HEAD carries the headers but no body; anything else is refused.
  const head = fakeResponse();
  routes.get(PANEL_PATH).handler({ method: "HEAD" }, head);
  assert.equal(head.written.status, 200);
  assert.equal(head.written.body, undefined);
  const post = fakeResponse();
  routes.get(PANEL_PATH).handler({ method: "POST" }, post);
  assert.equal(post.written.status, 405);
});

test("the state route reports an attempt only while a sign-in is in flight", async () => {
  const { ctx, service, routes } = fakeContext();
  apply(ctx, { claimOrigin: "http://127.0.0.1:47821" });
  const state = routes.get(STATE_PATH);

  const idle = fakeResponse();
  await state.handler({ method: "GET" }, idle);
  assert.equal(idle.written.status, 204, "no attempt in flight answers 204, so an idle page has nothing to log");
  assert.equal(idle.written.headers["cache-control"], "no-store");

  let settle;
  service.answer = new Promise((resolve) => {
    settle = resolve;
  });
  const inFlight = service.startSignIn({}, "https://dsh.example.com", "web");
  const waiting = fakeResponse();
  await state.handler({ method: "GET" }, waiting);
  assert.equal(waiting.written.status, 200, "an attempt in flight makes the panel read the callback");

  settle({ ok: true });
  await inFlight;
  const after = fakeResponse();
  await state.handler({ method: "GET" }, after);
  assert.equal(after.written.status, 204, "the attempt ended, so the answer goes back to 204");

  const post = fakeResponse();
  await state.handler({ method: "POST" }, post);
  assert.equal(post.written.status, 405);
});

test("the state route sees an attempt that outlives a resolved startSignIn promise", async () => {
  // dsh 0.2.2 returns the account state as soon as the attempt exists, so the promise
  // settles while the attempt is still waiting. Counting pending calls alone would
  // answer 204 and the paste panel would never appear — the bug this test pins.
  const { ctx, service, routes } = fakeContext();
  apply(ctx, { claimOrigin: "http://127.0.0.1:47821" });
  const state = routes.get(STATE_PATH);

  let phase = "waiting-browser";
  service.getState = async () => ({ status: "signed-out", attempt: { id: "attempt-1", phase } });
  service.answer = Promise.resolve({ ok: true });
  await service.startSignIn({}, "https://dsh.example.com", "web");

  const waiting = fakeResponse();
  await state.handler({ method: "GET" }, waiting);
  assert.equal(waiting.written.status, 200, "a resolved startSignIn must not hide the waiting attempt");

  phase = "expired";
  const after = fakeResponse();
  await state.handler({ method: "GET" }, after);
  assert.equal(after.written.status, 204, "the attempt ended, so the answer goes back to 204");

  const post = fakeResponse();
  await state.handler({ method: "POST" }, post);
  assert.equal(post.written.status, 405);
});

test("a service without getState fails soft instead of claiming an attempt", async () => {
  const { ctx, service, routes } = fakeContext();
  apply(ctx, { claimOrigin: "http://127.0.0.1:47821" });
  delete service.getState;
  service.answer = Promise.resolve({ ok: true });
  await service.startSignIn({}, "https://dsh.example.com", "web");
  const state = fakeResponse();
  await routes.get(STATE_PATH).handler({ method: "GET" }, state);
  assert.equal(state.written.status, 204, "no state to read means no claim, and no page error");
});

test("a live profile reload keeps the counter the installed wrapper moves", async () => {
  const { ctx, service, routes } = fakeContext();
  apply(ctx, { claimOrigin: "http://127.0.0.1:47821" });
  apply(ctx, { claimOrigin: "http://127.0.0.1:47821" });

  let settle;
  service.answer = new Promise((resolve) => {
    settle = resolve;
  });
  const inFlight = service.startSignIn({}, "https://dsh.example.com", "web");
  const state = fakeResponse();
  await routes.get(STATE_PATH).handler({ method: "GET" }, state);
  assert.equal(state.written.status, 200, "a fresh counter in the second apply would always read 204");
  settle({ ok: true });
  await inFlight;
});

test("apply injects the panel into the DSH document", () => {
  const { ctx } = fakeContext();
  apply(ctx, { claimOrigin: "http://127.0.0.1:47821" });
  const table = [];
  ctx.emit("webserver/index-inject", table);
  assert.deepEqual(table, [{ kind: "script-src", src: PANEL_PATH, placement: "body" }]);
});

test("applying twice stays one wrapper, so a live profile reload cannot double it", () => {
  const { ctx, service } = fakeContext();
  apply(ctx, { claimOrigin: "http://127.0.0.1:47821" });
  apply(ctx, { claimOrigin: "http://127.0.0.1:47821" });
  service.startSignIn({}, "https://dsh.example.com", "web");
  assert.deepEqual(
    service.calls.map((call) => call.callbackOrigin),
    ["http://127.0.0.1:47821"],
  );
});

test("an unusable claim leaves upstream behaviour and serves nothing", () => {
  for (const claimOrigin of ["https://127.0.0.1:47821", "http://192.168.3.2:47821", "http://127.0.0.1", "nonsense"]) {
    const { ctx, service, routes } = fakeContext();
    apply(ctx, { claimOrigin });
    assert.equal(routes.size, 0, `expected no routes for ${claimOrigin}`);
    assert.equal(
      Object.getPrototypeOf(service).startSignIn.name,
      "startSignIn",
      `expected the service to stay unpatched for ${claimOrigin}`,
    );
    service.startSignIn({}, "https://dsh.example.com", "web");
    // Unpatched means upstream would reject this — the point is that we did not touch it.
    assert.deepEqual(service.calls.map((call) => call.callbackOrigin), ["https://dsh.example.com"]);
  }
});

test("REMOTE_SIGNIN_ORIGIN is honoured and config wins over it", () => {
  const previous = process.env.REMOTE_SIGNIN_ORIGIN;
  process.env.REMOTE_SIGNIN_ORIGIN = "http://localhost:44444";
  try {
    const fromEnv = fakeContext();
    apply(fromEnv.ctx, {});
    fromEnv.service.startSignIn({}, "https://dsh.example.com", "web");
    assert.equal(fromEnv.service.calls[0].callbackOrigin, "http://localhost:44444");

    const fromConfig = fakeContext();
    apply(fromConfig.ctx, { claimOrigin: "http://127.0.0.1:47821" });
    fromConfig.service.startSignIn({}, "https://dsh.example.com", "web");
    assert.equal(fromConfig.service.calls[0].callbackOrigin, "http://127.0.0.1:47821");
  } finally {
    if (previous === undefined) delete process.env.REMOTE_SIGNIN_ORIGIN;
    else process.env.REMOTE_SIGNIN_ORIGIN = previous;
  }
});

test("apply registers the callback bridge as a listener, never as a route", () => {
  const { ctx, routes, listeners } = fakeContext();
  apply(ctx, { claimOrigin: "http://127.0.0.1:47821" });
  // A route at this path would collide with upstream's own registration on 0.2.2
  // ("duplicate (kind, path)") and break the sign-in this plugin exists to rescue.
  assert.deepEqual([...routes.keys()].sort(), [PANEL_PATH, STATE_PATH].sort());
  assert.equal(
    (listeners.get("webserver/request") ?? []).length,
    1,
    "the bridge has to be a webserver/request listener",
  );
});

/** A fake listener response stream, relayed by the bridge. */
function fakeAnswer({ status = 400, headers = { "cache-control": "no-store" }, body = "invalid state" } = {}) {
  const answer = Readable.from([Buffer.from(body)]);
  answer.statusCode = status;
  answer.headers = headers;
  return answer;
}

/** A fake transport recording the options the bridge builds. */
function fakeTransport({ answer = fakeAnswer(), fail } = {}) {
  const calls = [];
  const transport = (options, onResponse) => {
    calls.push(options);
    const handlers = new Map();
    return {
      on(event, handler) {
        handlers.set(event, handler);
        return this;
      },
      end() {
        if (fail !== undefined) {
          handlers.get("error")?.(fail);
          return;
        }
        onResponse(answer);
      },
    };
  };
  return { transport, calls };
}

/** Dispatch one request through the bridge the way the web server would. */
function dispatch(bridge, request) {
  const response = fakeResponse();
  let nextCalls = 0;
  bridge(request, response, () => {
    nextCalls += 1;
  });
  return { response, next: () => nextCalls };
}

const CLAIM = "http://127.0.0.1:47821";

test("the bridge replays the browser's callback with the claimed Host and relays the answer", async () => {
  const { webServer } = fakeContext();
  const { transport, calls } = fakeTransport({ answer: fakeAnswer({ status: 410, body: "gone" }) });
  const bridge = bridgeCallback(CLAIM, webServer, transport);

  const request = dispatch(bridge, {
    method: "GET",
    url: "/oauth/callback?code=abc&state=def",
    headers: { host: "dsh.example.com", accept: "text/html" },
  });
  await request.response.finished;

  assert.equal(calls.length, 1, "the callback has to be replayed exactly once");
  assert.deepEqual(calls[0], {
    protocol: "http:",
    hostname: "127.0.0.1",
    port: "3080",
    method: "GET",
    // The panel's own path and query, never a URL taken from the request.
    path: "/oauth/callback?code=abc&state=def",
    headers: { host: "127.0.0.1:47821", accept: "text/html", [BRIDGE_HEADER]: "1" },
  });
  // The listener's answer reaches the panel unchanged, status and headers included.
  assert.equal(request.response.written.status, 410);
  assert.equal(request.response.written.headers["cache-control"], "no-store");
  assert.equal(request.response.written.body, "gone");
  assert.equal(request.next(), 0, "the bridge owns the callback response");
});

test("the bridge falls through for its own replay, for other paths, and for wrong methods", async () => {
  const { webServer } = fakeContext();

  // A replay that nobody consumed: falling through lets DSH answer its own 404 instead of
  // looping, which is what an idle page has to see.
  const replay = fakeTransport();
  const replayBridge = bridgeCallback(CLAIM, webServer, replay.transport);
  const marked = dispatch(replayBridge, {
    method: "GET",
    url: "/oauth/callback?code=abc&state=def",
    headers: { host: "127.0.0.1:47821", [BRIDGE_HEADER]: "1" },
  });
  assert.equal(marked.next(), 1, "a replay must never be replayed again");
  assert.equal(replay.calls.length, 0);

  const other = fakeTransport();
  const otherBridge = bridgeCallback(CLAIM, webServer, other.transport);
  for (const url of ["/", "/api/settings.describe", "/remote-signin/inpage.js", "/notoauth/callback"]) {
    assert.equal(dispatch(otherBridge, { method: "GET", url, headers: {} }).next(), 1, `expected ${url} to fall through`);
  }
  assert.equal(other.calls.length, 0);

  const post = fakeTransport();
  const postBridge = bridgeCallback(CLAIM, webServer, post.transport);
  const refused = dispatch(postBridge, { method: "POST", url: "/oauth/callback", headers: {} });
  assert.equal(refused.response.written.status, 405);
  assert.equal(refused.response.written.headers.allow, "GET, HEAD");
  assert.equal(post.calls.length, 0, "only GET and HEAD are replayed");
});

test("the bridge fails soft when the listener is gone or unknown", async () => {
  const { webServer } = fakeContext();

  const refused = fakeTransport({
    fail: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3080"), { code: "ECONNREFUSED" }),
  });
  const bridge = bridgeCallback(CLAIM, webServer, refused.transport);
  const failed = dispatch(bridge, { method: "GET", url: "/oauth/callback?code=a&state=b", headers: {} });
  await failed.response.finished;
  assert.equal(failed.response.written.status, 502, "a dead listener is a bad gateway, not a thrown boot");
  assert.match(failed.response.written.body, /ECONNREFUSED/);
  assert.equal(failed.next(), 0);

  // A webServer that cannot say where it listens answers 503 instead of guessing.
  const unknown = bridgeCallback(CLAIM, {}, fakeTransport().transport);
  const guessed = dispatch(unknown, { method: "GET", url: "/oauth/callback?code=a&state=b", headers: {} });
  assert.equal(guessed.response.written.status, 503);
});

test("the bridge dials a wildcard bind through loopback and falls back to the port", async () => {
  const wildcard = fakeContext().webServer;
  wildcard.getOrigin = () => "http://0.0.0.0:3080";
  const first = fakeTransport();
  dispatch(bridgeCallback(CLAIM, wildcard, first.transport), {
    method: "HEAD",
    url: "/oauth/callback?code=a&state=b",
    headers: {},
  });
  assert.equal(first.calls[0].hostname, "127.0.0.1", "a connect to 0.0.0.0 is not portable");
  assert.equal(first.calls[0].method, "HEAD");

  // No getOrigin (an older webServer): the port alone is enough.
  const second = fakeTransport();
  dispatch(bridgeCallback(CLAIM, { port: 3099 }, second.transport), {
    method: "GET",
    url: "/oauth/callback?code=a&state=b",
    headers: {},
  });
  assert.deepEqual(
    { protocol: second.calls[0].protocol, hostname: second.calls[0].hostname, port: second.calls[0].port },
    { protocol: "http:", hostname: "127.0.0.1", port: "3099" },
  );
});
