# DSH remote account sign-in plugin

[中文](README.md) · **English**

When you use [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) from a browser on another device, this plugin helps you complete **DeepSeek account sign-in**. It works with DSH accessed over a LAN, Tailscale, or a reverse proxy.

During sign-in, paste the address of an unreachable callback page back into DSH. The plugin displays the paste panel automatically. An API key does not require this step.

## When you need it

When DSH runs on a server or NAS and the browser runs on another device, account sign-in may fail before the login page opens. DeepSeek account authorization currently requires a local callback address; the remote browser and the DSH server have different local machines.

The [dsh-docker image](https://github.com/MeiXu6693/dsh-docker) already includes this plugin and enables it by default, so no separate installation is needed. The same applies when installing the DSH app on Unraid.

## How to use it

1. Open DSH in your remote browser and choose **Sign in with a DeepSeek account**.
2. Complete sign-in on the DeepSeek login page.
3. Your browser is redirected to an address beginning with `http://127.0.0.1:47821/`, which normally cannot load. Copy the full address from the address bar.
4. Return to the original DSH tab, paste the address into the panel that appeared automatically, and submit it.
5. DSH performs its own validation and finishes sign-in. An attempt typically expires after about 10 minutes; start again after a timeout or container recreation.

The callback address contains sensitive sign-in information. Paste it only into the panel on your own DSH page; do not share it or put it in logs or support requests. The default port `47821` does not need to be opened; make sure no other program on your machine is listening there, or it could receive the callback.

## Installation and disabling

**dsh-docker image:** the plugin is already installed and `REMOTE_SIGNIN` defaults to `on`. Set it to `off` and recreate the container to disable the plugin and restore upstream remote sign-in behavior. For another image, first check whether the plugin is already included.

**Other DSH installations:** install the plugin in the DSH web profile:

```bash
dsh plugin --profile web add github:MeiXu6693/dsh-remote-signin
```

Alternatively, when the installed package can be resolved by Node, load it as a patch overlay:

```bash
dsh --profile web --patch "$(node -p "require.resolve('dsh-remote-signin/cordis.patch.yml')")"
```

## Troubleshooting

| Symptom | What to do |
|---|---|
| Account sign-in still fails when clicked | Verify the plugin is installed and enabled. Check `docker logs <container> \| grep remote-signin` for an active message or the reason it did not load. |
| Sign-in ends at an unreachable local address | Return to the original DSH tab and paste the full address from the browser address bar into the panel. |
| No paste panel appears in DSH | Check whether the plugin is active. Without the panel this plugin cannot complete the callback; use an API key or an SSH tunnel in the meantime. |
| The panel reports no pending sign-in or a state mismatch | The attempt may have expired, the container may have been recreated, or the address may belong to another attempt. Start sign-in again from the current DSH page and use the new address. |

## How it works and security

The plugin registers a loopback address with DeepSeek so a remote sign-in can start. The panel extracts `code` and `state` from the pasted address and sends them only to the current DSH site's own `/oauth/callback`. DSH's existing one-time state check and PKCE validation still perform verification and token exchange; the plugin does not store or log the code, state or tokens.

The plugin does not open a listening port. Browsers already accessing DSH through `127.0.0.1` keep upstream behavior. If a required service or asset is unavailable, the plugin reports it and falls back to upstream behavior while DSH continues to start. The panel reads only `400` (a sign-in waits) and `404` (idle) as state; **a redirect is not state** — DSH redirects only the request that carries the code, which the panel's probe never does, so a redirect there came from the SSO or reverse proxy in front of DSH and says nothing about the sign-in.

In a platform test on 2026-10-16, `http://127.0.0.1:47821/oauth/callback` was accepted while a public HTTPS callback was rejected. This records upstream behavior at that time; platform rules may change.

## Advanced configuration

The default claimed address is `http://127.0.0.1:47821` and normally needs no change. A patch entry's `config.claimOrigin` takes precedence; otherwise the plugin reads `REMOTE_SIGNIN_ORIGIN`. The address must use `http://`, a loopback host (`127.0.0.1`, `localhost` or `[::1]`), and an explicit port. Do not choose a port already used by a local program.

When loading a patch by package name, the plugin must resolve from the dependencies of the DSH installation or the profile's `node_modules`. If installed elsewhere, use an absolute `file://` URL for the plugin entry; the dsh-docker image does this.

## Development and compatibility checks

```bash
node --test
```

The unit suite uses Node's built-in test runner and a DOM stub; it needs no network, browser or installed dependencies. CI also periodically pulls `ghcr.io/meixu6693/dsh:latest` and checks both the bundled plugin and the current repository code against that image, including plugin loading, the authentication gate, panel injection and assets, idle callback behavior, disabling and edge Origin checks. CI does not use a real DeepSeek account or complete platform authorization; browser interactions are covered by the dependency-free unit suite.

Checks are scheduled hourly and also run on pushes, PRs and manual dispatch. GitHub scheduled workflows may be delayed; notifications follow the repository's existing Actions notification settings. View results in [Actions](https://github.com/MeiXu6693/dsh-remote-signin/actions).

MIT licensed; see [CHANGELOG.md](CHANGELOG.md) for version history.
