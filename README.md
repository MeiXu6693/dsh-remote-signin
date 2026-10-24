**English** · [中文](README.zh-CN.md)

# dsh-remote-signin

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that
**lets a DeepSeek *account* sign-in finish in the browser in front of you** — over the
LAN, a reverse-proxied domain, or Tailscale. All it adds is one paste, into a box that
appears in the page by itself.

## What you are seeing

You open DSH on a machine that is **not** the one running it — `http://192.168.0.20:8080`,
`https://dsh.example.com`, `http://100.x.y.z:8080` — and then:

1. you open the account panel and press **Sign in with a DeepSeek account**;
2. **no login page ever appears**: the dialog fails instead, with something like
   *"Could not complete the operation. Try again."* — sometimes *"Could not complete the
   operation. It may be a network problem — check your connection and try again."*;
3. the same click works when the browser runs **on that machine**, or when you first
   tunnel the port to yourself with `ssh -L` and open `http://127.0.0.1:…`;
4. an **API key** is unaffected.

So the workarounds have always been: use an API key, or open a tunnel every time you sign
in. This plugin exists for that one step.

## What the plugin does

With it installed, a remote browser finishes an account sign-in as normal:

```
1. browser (https://dsh.example.com)  you press "Sign in with a DeepSeek account"
2. DSH host + this plugin             registers a 127.0.0.1 address instead of yours
3. platform.deepseek.com              accepts it, returns the login page
4. browser                            the login page opens (this is where it used to
                                      fail), you sign in there
5. browser                            the platform sends you to 127.0.0.1:47821 — a page
                                      that cannot load, but the address bar holds the
                                      authorization code (`code` and `state`)
6. DSH page                           a paste box has appeared by itself, bottom right:
                                      paste that address into it
7. DSH host                           completes the sign-in — the validation and the token
                                      exchange are DSH's own → the dialog turns green
```

**Why step 6 cannot be automatic:** the code has to be delivered to that `127.0.0.1`
address *by your browser*, and your browser is precisely the thing that cannot reach it.
(If it could, you would be on the machine already and would not need this plugin.) What
can be removed has been: no address to remember, no second page to open, no hosts file to
edit — the box shows up when it is needed.

## Why it cannot work without it

DSH hands the platform **the address you are browsing from** and asks it to deliver the
login there; the platform only accepts a *local* address (`127.0.0.1` and friends). So the
request is refused before a login page is ever opened — **nothing to do with your network,
firewall or reverse proxy**; it is an upstream restriction.

Measured 2026-10-16 against the real platform (`POST /auth-api/v0/dsh/auth_init`):

| callback address given to the platform | platform answer |
|---|---|
| `http://127.0.0.1:47821/oauth/callback` | `{"code":0, … "authorize_url": …}`, `expires_in: 600` |
| `https://dsh.example.com/oauth/callback` | `{"code":50005,"msg":"PAYLOAD_SCHEMA_MISMATCH"}` |

What the plugin splits is those two halves: the platform only validates a **string**, and
the only thing that has to reach the address in it is the **browser**. The plugin supplies
the string (a port on `127.0.0.1`, where **nothing listens**); you hand the code back.

## Install

**Unraid / the `dsh-unraid` image** — nothing to do; the image installs this plugin and
loads it through `REMOTE_SIGNIN` (default `on`; set `off` for upstream's behaviour).

**Any DSH profile** — install it into the profile, which picks up `cordis.patch.yml`
through the package's `dsh.bundle` declaration:

```bash
dsh plugin --profile web add github:MeiXu6693/dsh-remote-signin
```

**Or load it as a patch overlay** (no profile change):

```bash
dsh --profile web --patch "$(node -p "require.resolve('dsh-remote-signin/cordis.patch.yml')")"
```

## Settings

One setting: which `127.0.0.1` address to register. The default works; you rarely need to
touch it.

| Source | Meaning |
|---|---|
| `config.claimOrigin` in the patch entry | Highest priority. |
| `REMOTE_SIGNIN_ORIGIN` | Environment fallback. Must be `http://` + `127.0.0.1` / `localhost` / `[::1]` + an explicit port. |
| default | `http://127.0.0.1:47821` |

The port is deliberately an odd one: if something of yours did listen there, it would be
handed the authorization code — so do not point it at a port you use.

## What it deliberately does not do

* **It does not relax any validation.** The callback that completes the sign-in is DSH's
  own route, with its one-time `state` check and the PKCE verifier it keeps in memory;
  this plugin only chooses which loopback *string* is registered.
* **It does not touch a browser that is already on `127.0.0.1`** (`ssh -L`, the desktop
  app): those origins pass through untouched, exactly as upstream behaves.
* **It does not invent a look.** The panel is styled from the harness's own design tokens
  (`--dsw-*`: surface, radius, elevation, label and state colours, primary button fill),
  so it follows the app's theme — including a user-chosen dark mode — and any future
  restyle. A test fails if a hard-coded colour creeps back in.
* **It does not store or log the code, the state or the token.** One line per attempt,
  naming the address it registered. The pasted address is parsed in your browser, and only
  `code` and `state` are re-encoded and sent to *this origin's own* `/oauth/callback` —
  nowhere else, so the panel cannot be used as a redirector.
* **It does not open a port.** The registration is a string; nothing listens on it, on the
  server or on your machine.
* **It never becomes the reason a container will not start.** A missing asset, an unusable
  address, or a future upstream rename leaves DSH running with upstream behaviour and one
  line in the log.

## Troubleshooting

| Symptom | What it means |
|---|---|
| Still *"Could not complete the operation. Try again."* | The plugin is not active: `docker logs <container> \| grep remote-signin` says why (`off`, a missing package, `INACTIVE`). |
| The login page opens, but afterwards the dead `127.0.0.1` page has no paste box | The panel was not injected — same log line. The panel is the only way back; without it the sign-in cannot be finished. |
| The panel says **no sign-in is waiting** (`404`) | The attempt expired (~10 minutes), or it belonged to a **different DSH instance** — recreating the container throws it away, and a tab left open from the previous instance still *looks* like it is waiting. Press **Sign in** again in the tab you are actually using. |
| The panel says the state does not match (`400`) | The address came from a different attempt, or the code was already consumed. |
| You want upstream behaviour back | Remove the plugin (or set `REMOTE_SIGNIN=off` on the `dsh-unraid` image), and go back to an API key or a tunnel. |

## Development

```bash
node --test        # 16 tests, no dependencies, no browser
```

| File | Purpose |
|---|---|
| `src/index.js` | Server plugin: wraps `deepseekAccount.startSignIn` (a non-loopback browser origin becomes the registered loopback origin), serves the panel script, injects it into the DSH document. |
| `src/claim.js` | Pure functions: how an address is parsed and validated — testable without booting DSH. |
| `assets/inpage.js` | The panel. It appears only while a sign-in waits, which it learns from the status of `GET /oauth/callback` (`400` = waiting, `404` = idle) — no new endpoint. |
| `test/`, `test-support/` | The `node --test` suites and the small DOM stub they share (probe cadence, dismissal, address extraction and every status are covered). |

### One caveat about where the package lives

A patch entry's `name` is resolved from two anchors: the packages carried by the
`@deepseek-ai/dsh` **installation** (its dependency closure), and the **profile**
directory (`$DSH_HOME/profiles/<name>/node_modules`). A package installed anywhere else —
a dependency of your own runtime manifest, or a copy in an image — is in neither, and
`name: dsh-remote-signin` then fails with `ERR_MODULE_NOT_FOUND`. Two ways out:

* install into the profile (`dsh plugin … add …`, above), where the name resolves; or
* point the entry at the file, as the `dsh-unraid` image does:

  ```yaml
  - insert:
      - id: remote-signin
        name: file:///app/node_modules/dsh-remote-signin/src/index.js
  ```

Upstream is in developer preview. The plugin depends on two contracts only —
`deepseekAccount.startSignIn` and the web server's route/index APIs — and degrades rather
than breaks when either changes.

MIT licensed. See [CHANGELOG.md](CHANGELOG.md).
