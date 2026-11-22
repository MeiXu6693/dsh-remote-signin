/**
 * dsh-remote-signin — finish a DeepSeek account sign-in from a browser that is not
 * running on the DSH machine.
 *
 * The plugin is two parts; this file is the server half.
 *
 *   src/index.js      this file: claims the loopback redirect, serves the panel script
 *                     and the attempt state it polls, replays the callback the panel
 *                     collects to DSH's own listener, and injects the panel into the
 *                     DSH page.
 *   assets/inpage.js  the panel itself: appears while a sign-in waits, takes the pasted
 *                     callback address, and reports what the server answered.
 *
 * Why any of it is needed: upstream only accepts a loopback `redirect_uri`, so the
 * platform's answer is delivered to an address on the *operator's* machine, where
 * nothing listens. The claim passes that check; the code comes back out of band.
 *
 * Nothing about the flow's security is relaxed. The callback that completes it is
 * upstream's own route with upstream's one-time `state` check and the PKCE verifier it
 * keeps in memory; this plugin only chooses which loopback string is registered, and
 * gives the operator one place to hand the code back.
 */

import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { DEFAULT_CLAIM_ORIGIN, mapCallbackOrigin, normalizeClaimOrigin } from "./claim.js";

export const name = "remote-signin";
/** Upstream service the claim wraps; the plugin stays inactive without it. */
export const inject = ["deepseekAccount"];

export { DEFAULT_CLAIM_ORIGIN, isLoopbackCallbackOrigin, mapCallbackOrigin, normalizeClaimOrigin } from "./claim.js";

/** Marks the wrapper so the startup check can find it through a tracing accessor. */
const WRAPPER = Symbol.for("dsh.remote-signin.wrapper");

/** The tracker the live wrapper reports to, found again when a profile reload re-applies. */
const ATTEMPTS = Symbol.for("dsh.remote-signin.attempts");

/** The panel script the document injects. */
export const PANEL_PATH = "/remote-signin/inpage.js";

/** Upstream's completion route, on this origin, as the panel asks for it. */
export const CALLBACK_PATH = "/oauth/callback";

/**
 * Marks the replay the bridge sends to DSH's own listener, so the bridge can recognise
 * its own request and never replay it again.
 */
export const BRIDGE_HEADER = "x-dsh-remote-signin-bridge";

/**
 * "May a sign-in be waiting right now?" — the panel's quiet poll.
 *
 * The panel used to ask upstream's `/oauth/callback` every three seconds and read `404`
 * as idle. That answer is correct, but it is still a failed request in the browser's
 * console, once every three seconds for as long as the page is open — whether or not
 * anyone is signing in. This route answers the same question with `200` (an attempt is
 * in flight: go look at the callback) or `204` (nothing is), so an idle page makes no
 * request any devtools would flag.
 *
 * What it reports depends on the upstream it runs against. Up to dsh 0.2.1 the
 * `startSignIn` promise stayed pending for the whole attempt, so "a call is pending"
 * was the answer. dsh 0.2.2 returns the account state as soon as the attempt is
 * created (measured 2026-11-16, dsh-deepseek-account 0.2.2-rc.3: `return
 * this.getState()` right after `this.attempt = attempt`), so the promise settles
 * immediately and the call counter alone reads `204` for an attempt that is in fact
 * waiting — which is the bug this version fixes. Once a call has been seen, the route
 * therefore asks `deepseekAccount.getState()` for the attempt phase; `204` before any
 * call is seen, so an idle page still costs nothing. Nothing sensitive is involved —
 * the answer says only that a sign-in is in progress.
 */
export const STATE_PATH = "/remote-signin/state";

/** This package's version, read once so a support log says which build is loaded. */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

const JS_HEADERS = {
  "content-type": "application/javascript; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/**
 * Read the packaged panel script.
 * @returns its text, or null (with one error line) when it cannot be read.
 */
function readPanel() {
  try {
    return readFileSync(new URL("../assets/inpage.js", import.meta.url), "utf8");
  } catch (error) {
    console.error(`[remote-signin] cannot read assets/inpage.js: ${error?.message ?? error}`);
    return null;
  }
}

/**
 * Answer one request with the panel script.
 * @param body - response body.
 * @returns a webServer route handler.
 */
function servePanel(body) {
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" }).end();
      return;
    }
    res.writeHead(200, { ...JS_HEADERS, "content-length": String(Buffer.byteLength(body)) });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}

/** The phases upstream reports while an attempt may still be waiting for the browser. */
const ACTIVE_PHASES = new Set([
  "initializing",
  "waiting-browser",
  "exchanging",
  "committing",
]);

/**
 * Track whether a sign-in may be waiting.
 *
 * Two signals, because upstream changed shape underneath this plugin:
 *
 *   1. The `startSignIn` promise. dsh ≤ 0.2.1 keeps it pending until the attempt
 *      settles, so a positive count answers "yes" synchronously and costs nothing.
 *   2. `deepseekAccount.getState()` once a call has been seen. dsh 0.2.2 resolves the
 *      promise immediately, so the count is back to zero while the attempt is still
 *      waiting; the phase in the service state is then the only honest answer.
 *
 * The state is only read while armed (a call happened and the last read still showed an
 * active attempt), so a page that never signs in makes no extra work. A service without
 * `getState`, or a state read that throws, fails soft to `false`: the panel stays
 * hidden instead of claiming an attempt it cannot prove.
 *
 * @param service - the `deepseekAccount` service the wrapper was installed on.
 * @returns `{ begin, end, active, activeSync }`.
 */
function createAttempts(service) {
  let inFlight = 0;
  let armed = false;
  return {
    begin() {
      inFlight += 1;
      armed = true;
    },
    end() {
      // dsh 0.2.2 settles here right after the attempt was created: keep `armed`,
      // the phase read is what ends the attempt now.
      inFlight = Math.max(0, inFlight - 1);
    },
    /** The synchronous answer for the pending-call shape (dsh ≤ 0.2.1). */
    activeSync() {
      return inFlight > 0;
    },
    /** The asynchronous answer for the resolved-call shape (dsh 0.2.2+). */
    async active() {
      if (inFlight > 0) return true;
      if (!armed) return false;
      try {
        const state = await service.getState();
        const active = ACTIVE_PHASES.has(state?.attempt?.phase);
        if (!active) armed = false;
        return active;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Answer `/remote-signin/state`: `200` while an attempt is in flight, `204` when none is.
 *
 * Status alone carries the answer, so the panel never parses a body and a proxy cannot
 * turn an idle page into a console error.
 *
 * @param attempts - the tracker from {@link createAttempts}.
 * @returns a webServer route handler.
 */
function serveState(attempts) {
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" }).end();
      return;
    }
    const answer = (waiting) => {
      res.writeHead(waiting ? 200 : 204, {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end();
    };
    if (attempts.activeSync()) {
      answer(true);
      return;
    }
    return attempts.active().then(answer, () => answer(false));
  };
}

/**
 * Wrap `startSignIn` on the live account service so a non-loopback browser origin is
 * replaced by the claim.
 *
 * The prototype is the patch point because that is where every resolution path ends,
 * including the per-access tracing view Cordis hands back from `ctx.deepseekAccount`.
 * Reachability through that accessor is then verified with a marker and reported once:
 * a silent no-op is the one failure an operator could not diagnose from the UI, since
 * the symptom (a remote browser failing to sign in) is what the plugin exists to cure.
 *
 * @param ctx - Cordis context carrying the account service.
 * @param claim - normalized claim origin.
 * @returns the attempt tracker when the wrapper is in place, null when it is not.
 */
function claimSignIn(ctx, claim) {
  let service;
  try {
    service = ctx.deepseekAccount;
  } catch {
    service = undefined;
  }
  if (service === undefined || typeof service.startSignIn !== "function") {
    console.error("[remote-signin] the deepseekAccount service is unavailable; remote sign-in stays off");
    return null;
  }
  const attempts = createAttempts(service);

  const prototype = Object.getPrototypeOf(service);
  const original = typeof prototype?.startSignIn === "function" ? prototype.startSignIn : service.startSignIn;
  // Profiles reload their patches live, so this plugin can be applied again in the
  // same process. The wrapper is installed on a prototype, which is per-import and
  // therefore per-process: a second apply must not wrap the wrapper (double log lines
  // for nothing), and it must still go on to serve the panel, because the previous
  // apply's route may already have been disposed with its plugin instance.
  if (original?.[WRAPPER] === true) {
    console.log(`[remote-signin] the account service is already claimed (${claim}); keeping the existing wrapper`);
    // The live wrapper reports through the tracker it was installed with, so a second
    // apply (a profile reload, which replaces this plugin instance and would otherwise
    // create a fresh tracker) must serve *that* one — a fresh one would read 204.
    return original[ATTEMPTS] ?? attempts;
  }

  const wrapped = function startSignIn(client, callbackOrigin, loginSource) {
    const mapped = mapCallbackOrigin(callbackOrigin, claim);
    if (mapped !== callbackOrigin) {
      // The origin is not a secret; the code, state and tokens that follow are, and
      // none of them is ever logged here.
      console.log(`[remote-signin] claiming ${claim} for browser origin ${JSON.stringify(callbackOrigin)}`);
    }
    attempts.begin();
    let result;
    try {
      result = original.call(this, client, mapped, loginSource);
    } catch (error) {
      attempts.end();
      throw error;
    }
    if (result !== null && typeof result?.then === "function") {
      // Settles when the attempt ends; handled on both sides so a rejection the caller
      // also observes never becomes an unhandled one.
      result.then(attempts.end, attempts.end);
    } else {
      attempts.end();
    }
    return result;
  };
  wrapped[WRAPPER] = true;
  wrapped[ATTEMPTS] = attempts;

  try {
    prototype.startSignIn = wrapped;
  } catch (error) {
    console.error(`[remote-signin] could not patch the account service: ${error?.message ?? error}`);
    return null;
  }

  // Identity comparison is deliberately NOT the check: `ctx.deepseekAccount` hands out
  // a per-access tracing view whose prototype is this one, so the honest test is that
  // the marker is reachable through the accessor the API controller uses. The first
  // "claiming" line is what proves the call really lands in the wrapper.
  let reachable = false;
  try {
    const view = ctx.deepseekAccount;
    const marker = (value) => Boolean(value) && value[WRAPPER] === true;
    reachable = marker(view?.startSignIn) || marker(Object.getPrototypeOf(view)?.startSignIn);
  } catch {
    reachable = false;
  }
  if (!reachable) {
    console.error("[remote-signin] INACTIVE — the account service does not resolve the patched startSignIn; remote sign-in stays off");
    return null;
  }
  return attempts;
}

/**
 * Where DSH's own listener answers: the loopback address the panel's request has to reach
 * as a *server-side* request, because the browser's own Host can never be the claimed one.
 *
 * `getOrigin()` is preferred (it carries the listener's protocol and assigned port, even
 * when the port came from the OS); a wildcard bind is dialled through loopback because a
 * connect to 0.0.0.0/:: is not portable.
 *
 * @param webServer - the `webServer` service.
 * @returns `{ protocol, hostname, port }`, or undefined when the listener is unknown.
 */
function listenerTarget(webServer) {
  try {
    if (typeof webServer?.getOrigin === "function") {
      const origin = new URL(webServer.getOrigin());
      const wildcard = ["0.0.0.0", "::", "[::]", ""].includes(origin.hostname);
      return {
        protocol: origin.protocol,
        hostname: wildcard ? "127.0.0.1" : origin.hostname,
        port: origin.port === "" ? (origin.protocol === "https:" ? 443 : 80) : origin.port,
      };
    }
  } catch {
    // fall through to the port
  }
  const port = webServer?.port;
  if (typeof port !== "number" || port <= 0) return undefined;
  return { protocol: webServer?.protocol === "https:" ? "https:" : "http:", hostname: "127.0.0.1", port: String(port) };
}

/**
 * The one socket call the bridge makes. Named and swappable so the tests stay offline:
 * everything else about the bridge is decided before this runs (`bridgeCallback` builds
 * the options and relays whatever comes back).
 *
 * @param options - `{ protocol, hostname, port, method, path, headers }`.
 * @param onResponse - receives the listener's response stream.
 * @returns the client request, which the caller ends.
 */
export function replayRequest(options, onResponse) {
  const client = options.protocol === "https:" ? https : http;
  return client.request(options, onResponse);
}

/**
 * Replay the panel's callback to DSH's own listener with the *claimed* Host.
 *
 * Upstream 0.2.3 stopped registering a `/oauth/callback` route. It registers a
 * `webserver/request` listener while an attempt waits, and that listener accepts only a
 * request whose `Host` is the claimed loopback origin (`attempt.origin`). A browser never
 * sends that Host — claiming a loopback address for a browser that cannot reach it is the
 * entire reason this plugin exists — so without a replay the panel's own `fetch()` would
 * fall through to DSH's 404 and the code would never reach the waiting attempt.
 * Measured 2026-11-22 against dsh-deepseek-account 0.2.3-alpha.2: the dispatch compares
 * `new URL('http://' + req.headers.host)` with `attempt.origin`, so the replay below is
 * exactly the shape it accepts. Upstream 0.2.2 and earlier ignored the Host on their
 * exact route, which the same replay also satisfies — one bridge, both shapes.
 *
 * It is a middleware rather than a route on purpose: a route at this path would collide
 * with upstream's own registration on 0.2.2 ("duplicate (kind, path)") and break the
 * sign-in it is supposed to help. The replay carries a marker; a marked request falls
 * through instead of being replayed again, so an attempt that has already ended ends as
 * DSH's ordinary 404 instead of an endless loop.
 *
 * Nothing about upstream's validation is touched: the replayed request still has to pass
 * its one-time `state` comparison and its PKCE exchange, and the answer — including its
 * error codes — is relayed to the panel unchanged.
 *
 * @param claim - normalized loopback claim origin, e.g. `http://127.0.0.1:47821`.
 * @param webServer - the `webServer` service, for the listener address.
 * @param request - transport, injectable for tests.
 * @returns a `webserver/request` listener.
 */
export function bridgeCallback(claim, webServer, request = replayRequest) {
  let claimHost;
  try {
    claimHost = new URL(claim).host;
  } catch {
    claimHost = undefined;
  }
  return (req, res, next) => {
    let url;
    try {
      url = new URL(req.url ?? "", "http://dsh.invalid");
    } catch {
      return next();
    }
    if (claimHost === undefined || url.pathname !== CALLBACK_PATH) return next();
    // The replay itself. Upstream's listener owns it when an attempt waits, and DSH's own
    // routing answers 404 when none does; either way it must not come back here.
    if (req.headers?.[BRIDGE_HEADER] !== undefined) return next();
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" }).end();
      return;
    }
    const target = listenerTarget(webServer);
    if (target === undefined) {
      res.writeHead(503, { "cache-control": "no-store" }).end();
      return;
    }
    let upstream;
    try {
      upstream = request(
        {
          ...target,
          method: req.method,
          // Only the path this middleware already matched: never a URL from the request.
          path: `${url.pathname}${url.search}`,
          headers: {
            host: claimHost,
            accept: req.headers?.accept ?? "*/*",
            [BRIDGE_HEADER]: "1",
          },
        },
        (answer) => {
          const headers = { ...answer.headers };
          // The body is relayed as it arrives; the client re-frames or closes it.
          delete headers.connection;
          delete headers["keep-alive"];
          delete headers["transfer-encoding"];
          res.writeHead(answer.statusCode ?? 502, headers);
          answer.pipe(res);
          answer.on("error", () => res.destroy?.());
        },
      );
    } catch (error) {
      console.error(`[remote-signin] the callback replay could not start: ${error?.message ?? error}`);
      res.writeHead(502, { "cache-control": "no-store" }).end();
      return;
    }
    upstream.on("error", (error) => {
      // Measured shape of the failure an operator would otherwise read as "the sign-in is
      // broken": the listener is gone, or this process is being replaced.
      if (res.headersSent) {
        res.destroy?.();
        return;
      }
      res
        .writeHead(502, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" })
        .end(`remote-signin: the sign-in callback did not reach DSH (${error?.code ?? "error"})\n`);
    });
    upstream.end();
  };
}

/**
 * Serve the panel script, the attempt state it polls, and inject the panel into the DSH
 * document. The injection is what makes the flow automatic: the panel appears on its own
 * while a sign-in waits, so the operator never has to know a URL.
 *
 * @param ctx - Cordis context.
 * @param panel - the panel script, read once at apply time.
 * @param attempts - the tracker the patched `startSignIn` reports to.
 * @param claim - the claimed loopback origin, for the callback bridge.
 */
function serveAndInject(ctx, panel, attempts, claim) {
  ctx.inject(["webServer"], (webCtx) => {
    // Routes are a composition-level contract and a duplicate (kind, path) throws. A
    // duplicate means another instance of this plugin already serves the panel (a live
    // profile reload can briefly have both), which is fine — and one failed
    // registration must never take the boot down with it.
    for (const [path, handler] of [
      [PANEL_PATH, servePanel(panel)],
      [STATE_PATH, serveState(attempts)],
    ]) {
      try {
        webCtx.effect(
          () => webCtx.webServer.register({ kind: "exact", path, handler }),
          `remote-signin: ${path}`,
        );
      } catch (error) {
        if (/duplicate/i.test(String(error?.message ?? error))) {
          console.log(`[remote-signin] ${path} is already served; leaving that instance in place`);
        } else {
          console.error(`[remote-signin] could not serve ${path}: ${error?.message ?? error}`);
        }
      }
    }

    // The callback bridge (see `bridgeCallback`). Fail soft like everything else here:
    // without it the panel still appears and still reports what it gets, so a listener
    // that cannot be registered costs one log line, never the boot.
    try {
      webCtx.effect(
        () => webCtx.on("webserver/request", bridgeCallback(claim, webCtx.webServer)),
        `remote-signin: ${CALLBACK_PATH} bridge`,
      );
    } catch (error) {
      console.error(
        `[remote-signin] could not bridge ${CALLBACK_PATH}: ${error?.message ?? error}; ` +
          "a first-party browser can still finish the sign-in on this machine",
      );
    }
  });

  // One row per document render; the panel is inert until a sign-in waits, so it is
  // injected unconditionally while the plugin is loaded.
  ctx.on("webserver/index-inject", (table) => {
    table.push({ kind: "script-src", src: PANEL_PATH, placement: "body" });
  });
}

/**
 * Plugin entry point.
 * @param ctx - Cordis context.
 * @param config - `{ claimOrigin }` from the patch entry, overridden by nothing else.
 */
export function apply(ctx, config = {}) {
  const configured = config?.claimOrigin ?? process.env.REMOTE_SIGNIN_ORIGIN ?? DEFAULT_CLAIM_ORIGIN;
  const claim = normalizeClaimOrigin(configured);
  if (claim === null) {
    console.error(
      `[remote-signin] ${JSON.stringify(configured)} is not a loopback http origin with an explicit port` +
        ` (expected e.g. ${DEFAULT_CLAIM_ORIGIN}); remote sign-in stays off`,
    );
    return;
  }

  // The panel is required: without it there would be no way to bring the code back, and
  // claiming a loopback origin would only turn a clear local failure into a dead end on
  // the operator's machine.
  const panel = readPanel();
  if (panel === null) {
    console.error("[remote-signin] the panel script is missing; remote sign-in stays off");
    return;
  }

  const attempts = claimSignIn(ctx, claim);
  if (attempts === null) return;
  serveAndInject(ctx, panel, attempts, claim);
  console.log(`[remote-signin] active — v${VERSION}, claim ${claim}, panel at ${PANEL_PATH}`);
}

export default { name, inject, apply };
