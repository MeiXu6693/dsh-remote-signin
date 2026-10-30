/**
 * dsh-remote-signin — the in-page panel.
 *
 * Injected into the DSH document by the plugin (`webserver/index-inject`). It watches
 * for a waiting sign-in and, when there is one, offers the paste step right where the
 * operator already is: no jump to another page, no second tab, nothing to remember.
 *
 * How "a sign-in is waiting" is detected: the plugin serves `/remote-signin/state`, which
 * answers `200` while one of upstream's sign-in attempts is in flight and `204` otherwise.
 * Only when it says `200` does this panel look at upstream's `/oauth/callback`, which
 * answers `400` for a request without `code`/`state` exactly while the attempt waits (and
 * `404` once it is gone). Asking the callback directly, every three seconds from an idle
 * page, was correct but made the browser console report a failed request forever; the
 * state route answers the same question without producing one.
 *
 * A redirect is deliberately never read as state: upstream answers the request that
 * carries the code with its own redirect, and neither of these probes carries one, so a
 * redirect comes from whatever sits in front of DSH (an SSO or reverse proxy answering an
 * unauthenticated request). Treating that as "somebody finished the sign-in" made the
 * panel appear unasked, claiming the login was done, whenever the proxy session lapsed.
 *
 * The extraction and the status vocabulary are exercised by test/inpage.test.mjs, which
 * runs this file against a small DOM stub: no browser, no build step.
 */
(function () {
  "use strict";

  var CALLBACK = "/oauth/callback";
  var STATE = "/remote-signin/state";
  var IDLE_MS = 3000;
  var WAITING_MS = 2000;
  var zh = /^zh/i.test((navigator && navigator.language) || "en");
  var t = function (en, cn) { return zh ? cn : en; };

  var root = null;      // the panel element
  var status = null;    // status line inside it
  var input = null;     // the paste box
  var button = null;
  var waiting = false;
  var dismissed = false;
  var succeeded = false;
  var stateKnown = true; // false once a server without /remote-signin/state says 404

  /**
   * Pull `code` and `state` out of whatever was pasted: a full URL, a bare query
   * string, or either with surrounding whitespace. Everything else is dropped, so the
   * only address this ever requests is `/oauth/callback` on this same origin.
   */
  function extract(raw) {
    var text = String(raw || "").trim();
    if (text.length === 0 || text.length > 4096) return null;
    var query = text;
    var mark = query.indexOf("?");
    if (mark !== -1) {
      var head = query.slice(0, mark);
      query = query.slice(mark + 1);
      var hash = query.indexOf("#");
      if (hash !== -1) query = query.slice(0, hash);
      if (head.indexOf("127.0.0.1") === -1 && head.indexOf("localhost") === -1 && head.indexOf("[::1]") === -1) return null;
      if (head.indexOf("/oauth/callback") === -1) return null;
    }
    var params = new URLSearchParams(query);
    var code = params.get("code");
    var state = params.get("state");
    if (!code || !state) return null;
    if (params.getAll("code").length !== 1 || params.getAll("state").length !== 1) return null;
    return { code: code, state: state };
  }

  /** Turn one HTTP status into something the operator can act on. */
  function describe(code) {
    if (code === 404) {
      return {
        kind: "error",
        text: t(
          "This server has no sign-in waiting: it expired (about 10 minutes), or it was started against a different DSH instance. Press Sign in again.",
          "这台服务器上没有正在等待的登录：已过期（约 10 分钟），或者它是在另一个 DSH 实例上发起的。重新点一次登录。",
        ),
      };
    }
    if (code === 400) {
      return {
        kind: "error",
        text: t(
          "That address is not the callback of a waiting sign-in: its state does not match, it is truncated, or it was already used.",
          "这个地址不是某个等待中登录的回调地址：state 不匹配、地址被截断，或者已经用过了。",
        ),
      };
    }
    if (code === 410) {
      return {
        kind: "error",
        text: t("That code was already delivered once.", "这个 code 已经提交过一次了。"),
      };
    }
    if (code === 401 || code === 403) {
      return {
        kind: "error",
        text: t("This browser is not signed in to DSH.", "这个浏览器还没有 DSH 的会话。"),
      };
    }
    return {
      kind: "error",
      text: t(
        "The server answered HTTP " + code + ". See the container log: docker logs <container> | grep remote-signin",
        "服务器返回 HTTP " + code + "。看容器日志：docker logs <容器名> | grep remote-signin",
      ),
    };
  }

  function setStatus(text, kind) {
    if (status === null) return;
    status.textContent = text;
    status.dataset.kind = kind || "";
  }

  /** Is this answer a redirect? `redirect: "manual"` hides it behind an opaque type. */
  function isRedirect(response) {
    return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
  }

  /**
   * Nothing is waiting (or nothing can be seen): forget a dismissal and hide. A panel
   * that is showing the completion message owns the screen until its own timer hides it.
   */
  function goIdle() {
    if (succeeded) return;
    if (waiting) {
      waiting = false;
      dismissed = false;
    }
    hide();
  }

  /** Build the panel once; later calls only toggle it. */
  function build() {
    // Styled entirely from the harness design tokens (`--dsw-*`, defined on :root by
    // @deepseek-ai/dsh-client-ui-theme): the surface, radius, elevation, label colours,
    // button fill and state colours all come from the running theme. The conventions are
    // the harness's own small floating card — layer-2 surface, radius-lg, shadow-lv3,
    // 12px 16px padding, 14px/22px text — so the panel follows the user's light/dark
    // setting and any future restyle instead of hard-coding a second look. Fallbacks keep
    // it readable if the theme has not loaded; there is deliberately no
    // prefers-color-scheme query — the app's theme is a setting, not the OS preference.
    var style = document.createElement("style");
    style.textContent = [
      "#dsh-remote-signin-panel{position:fixed;right:16px;bottom:16px;z-index:2147483000;",
      "box-sizing:border-box;width:min(420px,calc(100vw - 32px));padding:12px 16px 14px;",
      "border-radius:var(--dsw-radius-lg,16px);",
      "background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#fff));",
      "box-shadow:var(--dsw-shadow-lv3,0 0 1px rgba(0,0,0,.2),0 12px 32px rgba(0,0,0,.08));",
      "color:var(--dsw-alias-label-primary,#0f1115);font-family:var(--dsw-font-family,inherit);",
      "font-size:14px;line-height:22px}",
      "#dsh-remote-signin-panel h2{margin:0 0 2px;font-size:14px;line-height:22px;font-weight:600;color:inherit}",
      "#dsh-remote-signin-panel p{margin:0 0 10px;font-size:13px;line-height:20px;",
      "color:var(--dsw-alias-label-secondary,#61666b)}",
      "#dsh-remote-signin-panel textarea{display:block;width:100%;box-sizing:border-box;min-height:60px;",
      "margin:0 0 12px;padding:8px 10px;",
      "font-family:var(--dsh-font-family-code,var(--dsh-font-family-code-default,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace));",
      "font-size:12px;line-height:18px;color:inherit;background:var(--dsw-alias-bg-layer-1,transparent);",
      "border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:var(--dsw-radius-sm,8px);",
      "resize:vertical;outline:none}",
      "#dsh-remote-signin-panel textarea:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}",
      "#dsh-remote-signin-panel .rs-actions{display:flex;gap:8px;align-items:center}",
      "#dsh-remote-signin-panel button{font:inherit;font-size:13px;font-weight:500;border:0;cursor:pointer;",
      "height:32px;padding:0 12px;border-radius:var(--dsw-radius-sm,8px);",
      "background:var(--dsw-alias-button-primary-fill,#4d6bfe);color:var(--dsw-alias-label-primary-foreground,#fff)}",
      "#dsh-remote-signin-panel button:hover{background:var(--dsw-alias-button-primary-hover,#3f5ae0)}",
      "#dsh-remote-signin-panel button[disabled]{opacity:.5;cursor:default}",
      "#dsh-remote-signin-panel .rs-close{margin-left:auto;width:28px;height:28px;padding:0;font-weight:400;",
      "background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);border-radius:var(--dsw-radius-sm,8px)}",
      "#dsh-remote-signin-panel .rs-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));",
      "color:var(--dsw-alias-label-primary,#0f1115)}",
      "#dsh-remote-signin-panel .rs-status{margin-top:10px;min-height:20px;font-size:12px;line-height:18px;",
      "color:var(--dsw-alias-label-caption,#81858c)}",
      "#dsh-remote-signin-panel .rs-status[data-kind=error]{color:var(--dsw-alias-state-error-primary,#d92d20)}",
      "#dsh-remote-signin-panel .rs-status[data-kind=ok]{color:var(--dsw-alias-state-success-primary,#12b76a)}",
    ].join("");
    document.head.appendChild(style);

    root = document.createElement("section");
    root.id = "dsh-remote-signin-panel";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", t("Finish the DeepSeek sign-in", "完成 DeepSeek 账号登录"));

    var title = document.createElement("h2");
    title.textContent = t("Finish the DeepSeek sign-in", "完成 DeepSeek 账号登录");

    var hint = document.createElement("p");
    hint.textContent = t(
      "The login tab ends on a dead 127.0.0.1 page. Copy its address and paste it here (within ~10 minutes).",
      "登录标签页会停在一个打不开的 127.0.0.1 页面上。把它地址栏里的地址复制到这里粘贴（约 10 分钟内有效）。",
    );

    input = document.createElement("textarea");
    input.spellcheck = false;
    input.autocomplete = "off";
    input.placeholder = "http://127.0.0.1:47821/oauth/callback?code=…&state=…";

    var actions = document.createElement("div");
    actions.className = "rs-actions";
    button = document.createElement("button");
    button.type = "button";
    button.textContent = t("Finish sign-in", "完成登录");

    var close = document.createElement("button");
    close.type = "button";
    close.className = "rs-close";
    close.title = t("Hide until the next sign-in", "隐藏（下次登录再出现）");
    close.textContent = "✕";
    close.addEventListener("click", function () {
      dismissed = true;
      hide();
    });

    status = document.createElement("div");
    status.className = "rs-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    actions.appendChild(button);
    actions.appendChild(close);
    root.appendChild(title);
    root.appendChild(hint);
    root.appendChild(input);
    root.appendChild(actions);
    root.appendChild(status);
    document.body.appendChild(root);

    button.addEventListener("click", submit);
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    });
  }

  function show() {
    if (root === null) build();
    root.style.display = "";
  }

  function hide() {
    if (root !== null) root.style.display = "none";
  }

  /** Send the pasted code to upstream's own callback on this origin, and read the answer. */
  function submit() {
    var pairs = extract(input.value);
    if (pairs === null) {
      setStatus(
        t(
          "That does not look like the callback address of this sign-in (it must contain code= and state=).",
          "这个地址看起来不是本次登录的回调地址（必须包含 code= 与 state=）。",
        ),
        "error",
      );
      return;
    }
    button.disabled = true;
    setStatus(t("Finishing the sign-in…", "正在完成登录…"), "ok");
    var target = new URLSearchParams();
    target.set("code", pairs.code);
    target.set("state", pairs.state);
    // Same origin, upstream's own callback path: the one-time `state` authorises it.
    // Fetched rather than navigated to, so the answer can be read and explained.
    fetch(CALLBACK + "?" + target.toString(), {
      credentials: "same-origin",
      redirect: "manual",
      headers: { accept: "text/html" },
    })
      .then(function (response) {
        if (isRedirect(response)) {
          // Ambiguous, and `redirect: "manual"` hides what the redirect pointed at: this
          // is either the platform completing the sign-in or the proxy/SSO in front of
          // DSH answering before the request arrived. One more probe decides it.
          confirmCompleted();
          return;
        }
        if (response.status >= 200 && response.status < 300) {
          setStatus(
            t(
              "The server took the code (HTTP " + response.status + "). Check the DSH tab: if it still says waiting, that attempt had already ended.",
              "服务器已接收授权码（HTTP " + response.status + "）。请看 DSH：若仍停在“等待登录”，说明那次尝试已经结束。",
            ),
            "ok",
          );
          button.disabled = false;
          return;
        }
        var described = describe(response.status);
        setStatus(described.text, described.kind);
        button.disabled = false;
      })
      .catch(function () {
        setStatus(t("The request did not reach DSH.", "请求没有到达 DSH。"), "error");
        button.disabled = false;
      });
  }

  /**
   * Tell a completion redirect apart from a proxy one.
   *
   * Upstream registers `/oauth/callback` exactly while an attempt waits, so a probe that
   * is redirected too means that route was never reached: the redirect came from the SSO
   * or reverse proxy in front of DSH, the code went nowhere, and claiming success would
   * be a lie. A probe that answers at all (400 while the attempt is still being disposed,
   * 404 once it is gone) means DSH itself answered the completion.
   */
  function confirmCompleted() {
    fetch(CALLBACK, { method: "GET", credentials: "same-origin", redirect: "manual", cache: "no-store" })
      .then(function (response) {
        if (isRedirect(response)) {
          setStatus(
            t(
              "The request was answered by the proxy or SSO in front of DSH, not by DSH: the sign-in did not go through. Reload the page (sign in to the proxy again if it asks), then retry.",
              "这次请求是 DSH 前面的代理或 SSO 应答的，没有到过 DSH，登录没有完成。刷新页面（按提示重新过一遍代理登录）后重试。",
            ),
            "error",
          );
          button.disabled = false;
          return;
        }
        succeeded = true;
        setStatus(t("Signed in — you can close this.", "登录完成——可以关掉了。"), "ok");
        setTimeout(hide, 6000);
      })
      .catch(function () {
        setStatus(t("The request did not reach DSH.", "请求没有到达 DSH。"), "error");
        button.disabled = false;
      });
  }

  /**
   * Ask this plugin's own state route whether an attempt may be waiting, and read
   * upstream's callback only when it says one might be.
   *
   * The state route answers `200` (an attempt is in flight) or `204` (nothing is) and
   * never an error, so an idle page makes no request a devtools console would flag — the
   * old design asked `/oauth/callback` every three seconds and got a `404` each time,
   * which is correct but reads as a broken page. A `404` from the state route means a
   * server build without it: fall back to reading the callback itself, which is what this
   * panel did before the route existed.
   */
  function probeState() {
    return fetch(STATE, { method: "GET", credentials: "same-origin", redirect: "manual", cache: "no-store" }).then(
      function (response) {
        if (isRedirect(response)) {
          // The SSO or reverse proxy in front of DSH answered, not DSH: nothing is known.
          goIdle();
          return IDLE_MS;
        }
        if (response.status === 200) return probeCallback();
        if (response.status === 404) {
          stateKnown = false;
          return probeCallback();
        }
        // 204, and anything else: no attempt is waiting.
        goIdle();
        return IDLE_MS;
      },
    );
  }

  /**
   * Upstream's own answer for "is an attempt waiting": `400` means the callback route is
   * registered and rejected a request without `code`/`state`; `404` means it is not
   * registered at all. Anything else — a redirect in particular — says nothing about the
   * sign-in and is read as "not waiting", never as "signed in".
   *
   * @returns a promise of how long to wait before the next poll.
   */
  function probeCallback() {
    return fetch(CALLBACK, { method: "GET", credentials: "same-origin", redirect: "manual", cache: "no-store" }).then(
      function (response) {
        if (isRedirect(response)) {
          // Upstream answers the request carrying the code with its redirect; this probe
          // carries none, so an SSO or reverse proxy in front of DSH answered instead.
          // Nothing happened to the sign-in: keep the panel out of the way.
          goIdle();
          return IDLE_MS;
        }
        if (response.status === 400) {
          if (!waiting) {
            waiting = true;
            dismissed = false;
            succeeded = false;
            if (input !== null) input.value = "";
            // A new attempt must not inherit the previous attempt's answer.
            setStatus("", "");
          }
          if (!dismissed) show();
          return WAITING_MS;
        }
        // 404 and anything else: no attempt is waiting.
        goIdle();
        return IDLE_MS;
      },
    );
  }

  /** One poll: settle the attempt state first, then look at the callback if it may wait. */
  function probe() {
    if (document.visibilityState === "hidden") {
      schedule(IDLE_MS);
      return;
    }
    var next = stateKnown ? probeState() : probeCallback();
    next.then(schedule, function () {
      goIdle();
      schedule(IDLE_MS);
    });
  }

  var timer = null;
  function schedule(ms) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(probe, ms);
  }

  function start() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", start, { once: true });
      return;
    }
    try {
      probe();
    } catch (error) {
      // The panel is a convenience; a failure here must never disturb the page.
      if (globalThis.console) console.debug("[remote-signin] panel disabled:", error);
    }
  }

  start();
})();
