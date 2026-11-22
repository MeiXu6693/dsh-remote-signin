# Changelog

Versions are what the `dsh-unraid` image pins, so a tag here is a deployment there.

## 0.2.5 — 2026-11-22

* **The panel completes a sign-in again on dsh 0.2.3 and later.** Upstream replaced its
  `/oauth/callback` route with a request listener that accepts only a request whose `Host`
  is the claimed loopback origin (`attempt.origin`) — measured 2026-11-22 on
  `dsh-deepseek-account` 0.2.3-alpha.2, which compares
  `new URL('http://' + req.headers.host)` against that origin. A browser that is not on
  this machine can never present that Host, which is the reason this plugin exists: the
  panel's same-origin `fetch()` fell through to DSH's 404 and the code never reached the
  waiting attempt. Measured against the alpha: the panel's callback answered **404** with
  0.2.4 and answers **400** (upstream's own one-time `state` check, i.e. the request
  arrived) with this version. The plugin now replays exactly that path to DSH's own
  listener with the claimed `Host` and relays the answer — status and headers included —
  back to the panel.
* The replay is marked, so a request nobody consumed ends as DSH's ordinary `404` instead
  of being replayed again; the bridge is a request listener rather than a route, so it
  cannot collide with the exact route upstream 0.2.2 and earlier register for the same
  path; and it fails soft (one log line, `502`/`503` to the panel) when the listener is
  unreachable. Upstream's one-time `state` comparison and its PKCE exchange are untouched.

## 0.2.4 — 2026-11-16

* **The paste panel appears again on dsh 0.2.2 and later.** Upstream 0.2.2 returns the
  account state as soon as the attempt is created (`return this.getState()` right after
  `this.attempt = attempt`) instead of keeping the `startSignIn` promise pending until
  the attempt ends. The plugin counted pending calls, so `/remote-signin/state` answered
  `204` for an attempt that was in fact `waiting-browser`: measured on this host
  2026-11-16, a login started 09:19:53 was answered with `204` at 09:24 and the attempt
  survived until upstream reported `expired` at 09:29:53. The panel therefore never
  appeared, and the browser that came back from the login page had nowhere to paste the
  callback address. The state route now asks `deepseekAccount.getState()` for the
  attempt phase once a sign-in call has been seen; a positive pending-call count still
  answers synchronously on 0.2.1 and earlier, and a service without `getState` fails
  soft to `204` instead of inventing an attempt.
* An idle page still costs nothing: the phase is read only after a sign-in call, and the
  reads stop as soon as the attempt is no longer active.

## 0.2.3 — 2026-10-30

* **An idle page no longer makes a failing request every three seconds.** The panel used
  to poll upstream's `/oauth/callback` on a timer and read `404` as "nothing is waiting".
  That answer is correct, but it left a 404 in the browser console every three seconds for
  as long as DSH stayed open — measured on this host: 16 977 of them in one access log,
  none of which was an event. The plugin now serves `/remote-signin/state`: `200` while
  one of upstream's sign-in attempts is in flight, `204` otherwise. The panel reads the
  callback only after a `200`, so an idle page makes no request a devtools would flag.
* The state route reports what the wrapper can actually see — the in-flight `startSignIn`
  promise, which settles when the attempt ends — rather than a guess with an expiry, so
  the answer returns to `204` by itself.
* A server build without the route answers `404` and the panel falls back to probing the
  callback itself, so an older server half keeps the newer panel working (and vice versa).
* A live profile reload that re-applies the plugin reuses the counter the installed
  wrapper moves; a fresh one would have read `204` forever.

## 0.2.2 — 2026-10-30

* **The panel no longer appears by itself and claims a sign-in it did not see.** Behind
  an SSO or reverse proxy (this deployment: SWAG + Authelia) an unauthenticated request
  is answered with a redirect, and a browser's `fetch(…, redirect: "manual")` reports any
  redirect as an opaque one. The probe read that as "another tab just finished the
  sign-in", so whenever the operator's proxy session had lapsed the panel popped up with
  "Signed in — you can close this." although nobody had pressed Sign in. Measured on this
  host: 171 `302`s on `GET /oauth/callback` in the SWAG access log, and **zero** `400`s
  (the only answer that means an attempt is waiting) since 2026-10-25. A redirect is now
  read as "cannot see the sign-in state", i.e. not waiting; only `400` shows the panel.
* A pasted code whose completion is answered by a redirect is now confirmed with one more
  probe: if the callback route redirects that probe too, the request never reached DSH
  (the proxy answered) and the panel says so instead of reporting success.
* A new attempt starts with an empty status line; it used to inherit the previous
  attempt's answer, so a completed sign-in's "you can close this" could reappear later.

## 0.2.1 — 2026-10-16

* The panel is styled from the harness design tokens (`--dsw-*`, declared by
  `@deepseek-ai/dsh-client-ui-theme`) instead of a palette of its own: layer-2 surface,
  `--dsw-radius-lg`, `--dsw-shadow-lv3`, the theme's label/state colours and its primary
  button fill — the same conventions the harness uses for its own small floating cards.
  The panel now follows the app's light/dark setting (the old build keyed off the OS
  preference, which is not what the app themes with), and a future restyle reaches it for
  free. A test pins that: tokens with fallbacks, no hard-coded colour, no
  `prefers-color-scheme`.

## 0.2.0 — 2026-10-16

* **The standalone page at `/remote-login` is gone.** The panel that the DSH document
  injects is the one way back: it appears by itself while a sign-in waits, and a second
  page asked the operator to know a URL the feature exists to make unnecessary. The
  plugin now serves exactly one path (`/remote-signin/inpage.js`) and the panel no longer
  links to a page that is not there.

## 0.1.0 — 2026-10-16

First release, extracted from the `dsh-unraid` image so it can be maintained on its own.

* Claims a loopback `redirect_uri` (`http://127.0.0.1:47821` by default) so the DeepSeek
  platform accepts an `auth_init` from a remote browser.
* Injects a panel into the DSH page that appears by itself while a sign-in waits, takes
  the pasted `127.0.0.1` callback address, and reports the server's answer in place.
* Serves the same thing as a standalone page at `/remote-login`.
* Fails soft: an unusable claim, a missing asset or an upstream rename leaves DSH running
  with upstream behaviour and one log line.

## 0.1.1 — 2026-10-16

* The activation line names the loaded version (`[remote-signin] active — v0.1.1, …`), so a
  support log says which build an image carries without inspecting it.
