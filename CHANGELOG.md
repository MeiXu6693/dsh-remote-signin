# Changelog

Versions are what the `dsh-unraid` image pins, so a tag here is a deployment there.

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
