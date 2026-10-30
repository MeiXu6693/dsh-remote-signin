/**
 * dsh-remote-signin — finish a DeepSeek account sign-in from a browser that is not
 * running on the DSH machine.
 *
 * The plugin is two parts; this file is the server half.
 *
 *   src/index.js      this file: claims the loopback redirect, serves the panel script
 *                     and the attempt state it polls, and injects the panel into the
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
import { DEFAULT_CLAIM_ORIGIN, mapCallbackOrigin, normalizeClaimOrigin } from "./claim.js";

export const name = "remote-signin";
/** Upstream service the claim wraps; the plugin stays inactive without it. */
export const inject = ["deepseekAccount"];

export { DEFAULT_CLAIM_ORIGIN, isLoopbackCallbackOrigin, mapCallbackOrigin, normalizeClaimOrigin } from "./claim.js";

/** Marks the wrapper so the startup check can find it through a tracing accessor. */
const WRAPPER = Symbol.for("dsh.remote-signin.wrapper");

/** The counter the live wrapper moves, found again when a profile reload re-applies. */
const ATTEMPTS = Symbol.for("dsh.remote-signin.attempts");

/** The panel script the document injects. */
export const PANEL_PATH = "/remote-signin/inpage.js";

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
 * It reports what this plugin can actually see: `startSignIn` is async and its promise
 * settles when the attempt ends (code accepted, expired, or failed), so the number of
 * in-flight calls is exactly "an attempt may be waiting". Nothing sensitive is involved
 * — the answer says only that a sign-in is in progress.
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

/**
 * Count sign-ins that are in flight.
 *
 * Upstream's `startSignIn` is async and resolves only when the attempt finishes, so a
 * counter moved on entry and on settle is the panel's cheapest honest answer to "may one
 * be waiting?". A non-promise return (an upstream that stops being async) is counted for
 * one poll only: the panel then falls back to reading the callback route itself, which
 * is what it did before this route existed.
 *
 * @returns `{ begin, end, waiting }`.
 */
function createAttempts() {
  let inFlight = 0;
  return {
    begin() {
      inFlight += 1;
    },
    end() {
      inFlight = Math.max(0, inFlight - 1);
    },
    waiting() {
      return inFlight > 0;
    },
  };
}

/**
 * Answer `/remote-signin/state`: `200` while an attempt is in flight, `204` when none is.
 *
 * Status alone carries the answer, so the panel never parses a body and a proxy cannot
 * turn an idle page into a console error.
 *
 * @param attempts - the in-flight counter from {@link createAttempts}.
 * @returns a webServer route handler.
 */
function serveState(attempts) {
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" }).end();
      return;
    }
    res.writeHead(attempts.waiting() ? 200 : 204, {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end();
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
 * @returns the in-flight counter when the wrapper is in place, null when it is not.
 */
function claimSignIn(ctx, claim) {
  const attempts = createAttempts();
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

  const prototype = Object.getPrototypeOf(service);
  const original = typeof prototype?.startSignIn === "function" ? prototype.startSignIn : service.startSignIn;
  // Profiles reload their patches live, so this plugin can be applied again in the
  // same process. The wrapper is installed on a prototype, which is per-import and
  // therefore per-process: a second apply must not wrap the wrapper (double log lines
  // for nothing), and it must still go on to serve the panel, because the previous
  // apply's route may already have been disposed with its plugin instance.
  if (original?.[WRAPPER] === true) {
    console.log(`[remote-signin] the account service is already claimed (${claim}); keeping the existing wrapper`);
    // The live wrapper counts into the counter it was installed with, so a second apply
    // (a profile reload, which replaces this plugin instance and would otherwise create a
    // fresh counter) must serve *that* one — a new counter would always read zero.
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
 * Serve the panel script, the attempt state it polls, and inject the panel into the DSH
 * document. The injection is what makes the flow automatic: the panel appears on its own
 * while a sign-in waits, so the operator never has to know a URL.
 *
 * @param ctx - Cordis context.
 * @param panel - the panel script, read once at apply time.
 * @param attempts - the in-flight counter the patched `startSignIn` moves.
 */
function serveAndInject(ctx, panel, attempts) {
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
  serveAndInject(ctx, panel, attempts);
  console.log(`[remote-signin] active — v${VERSION}, claim ${claim}, panel at ${PANEL_PATH}`);
}

export default { name, inject, apply };
