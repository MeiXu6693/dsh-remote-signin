import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/report-ci-failure.mjs', import.meta.url));
const RUN_URL = 'https://github.com/o/r/actions/runs/42';

/**
 * A stub of the slice of the GitHub API the reporter uses.
 * @param options - seed issues, job list, or an API that refuses the jobs listing.
 * @returns the server, its recorded state, and a close function.
 */
async function startApi({ issues = [], jobs = [], failJobs = false } = {}) {
  const state = {
    issues: issues.map((issue) => ({ state: 'open', labels: [], ...issue })),
    comments: [],
    requests: [],
    next: 100,
    labelCreated: false,
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text === '' ? undefined : JSON.parse(text);
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    state.requests.push({ method: req.method, path: pathname, body });

    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload === undefined ? '' : JSON.stringify(payload));
    };

    if (req.method === 'GET' && pathname === '/repos/o/r/issues') {
      return send(200, state.issues.filter((issue) => issue.state === 'open'));
    }
    if (req.method === 'POST' && pathname === '/repos/o/r/issues') {
      const issue = { ...body, number: state.next++, state: 'open' };
      state.issues.push(issue);
      return send(201, issue);
    }
    if (req.method === 'POST' && pathname === '/repos/o/r/labels') {
      if (state.labelCreated) return send(422, { message: 'Validation Failed' });
      state.labelCreated = true;
      return send(201, { name: body.name });
    }
    const issueMatch = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)$/);
    if (req.method === 'PATCH' && issueMatch !== null) {
      const issue = state.issues.find((candidate) => candidate.number === Number(issueMatch[1]));
      Object.assign(issue, body);
      return send(200, issue);
    }
    const commentMatch = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments$/);
    if (req.method === 'POST' && commentMatch !== null) {
      state.comments.push({ number: Number(commentMatch[1]), body: body.body });
      return send(201, { id: state.comments.length });
    }
    const labelMatch = pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/labels$/);
    if (req.method === 'POST' && labelMatch !== null) {
      return send(200, body.labels ?? []);
    }
    if (req.method === 'GET' && pathname === '/repos/o/r/actions/runs/42/jobs') {
      if (failJobs) return send(500, { message: 'boom' });
      return send(200, { jobs });
    }
    return send(404, { message: `unexpected ${req.method} ${pathname}` });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Run the reporter against a stub API.
 * @param apiUrl - base URL of the stub.
 * @param overrides - environment overrides.
 * @returns the child's output.
 */
async function report(apiUrl, overrides = {}) {
  return execFileAsync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      GITHUB_TOKEN: 'test-token',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_API_URL: apiUrl,
      CI_EVENT: 'schedule',
      CI_CONCLUSION: 'failure',
      CI_BRANCH: 'main',
      CI_DEFAULT_BRANCH: 'main',
      CI_RUN_ID: '42',
      CI_RUN_URL: RUN_URL,
      CI_RUN_ATTEMPT: '1',
      CI_SHA: '0123456789abcdef',
      ...overrides,
    },
  });
}

test('a failed run opens one issue naming the run, the commit and the failing jobs', async () => {
  const api = await startApi({
    issues: [{ number: 7, title: 'ci failed on main', pull_request: { url: 'https://example.test/pr/7' } }],
    jobs: [
      { name: 'node 22', conclusion: 'success' },
      { name: 'DSH latest image compatibility', conclusion: 'failure' },
    ],
  });
  try {
    const { stdout } = await report(api.url);
    assert.match(stdout, /opened #100: ci failed on main/);
    assert.equal(api.state.issues.filter((issue) => issue.pull_request === undefined).length, 1);
    const issue = api.state.issues.find((candidate) => candidate.number === 100);
    assert.equal(issue.title, 'ci failed on main');
    assert.deepEqual(issue.labels, ['ci-failure']);
    assert.match(issue.body, /\[42\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/42\) · attempt 1/);
    assert.match(issue.body, /`0123456`/);
    assert.match(issue.body, /DSH latest image compatibility/);
    assert.doesNotMatch(issue.body, /node 22/);
    assert.deepEqual(
      api.state.requests.map(({ method, path }) => `${method} ${path}`),
      ['GET /repos/o/r/issues', 'GET /repos/o/r/actions/runs/42/jobs', 'POST /repos/o/r/labels', 'POST /repos/o/r/issues'],
    );
  } finally {
    await api.close();
  }
});

test('a later failure refreshes the same issue instead of opening a second one', async () => {
  const api = await startApi({
    issues: [{ number: 7, title: 'ci failed on main' }],
    jobs: [{ name: 'node 24', conclusion: 'failure' }],
  });
  try {
    const { stdout } = await report(api.url);
    assert.match(stdout, /refreshed #7: ci failed on main/);
    assert.equal(api.state.issues.length, 1);
    assert.match(api.state.issues[0].body, /node 24/);
    assert.equal(api.state.requests.filter(({ method, path }) => method === 'POST' && path === '/repos/o/r/issues').length, 0);
    assert.equal(api.state.requests.filter(({ path }) => path === '/repos/o/r/labels').length, 0);
  } finally {
    await api.close();
  }
});

test('a green run comments on the open issue and closes it', async () => {
  const api = await startApi({ issues: [{ number: 7, title: 'ci failed on main' }] });
  try {
    const { stdout } = await report(api.url, { CI_CONCLUSION: 'success' });
    assert.match(stdout, /closed #7: green again/);
    assert.equal(api.state.issues[0].state, 'closed');
    assert.equal(api.state.issues[0].state_reason, 'completed');
    assert.equal(api.state.comments.length, 1);
    assert.match(api.state.comments[0].body, /Recovered: \[42\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/42\)/);
  } finally {
    await api.close();
  }
});

test('a green run with nothing open writes nothing', async () => {
  const api = await startApi();
  try {
    const { stdout } = await report(api.url, { CI_CONCLUSION: 'success' });
    assert.match(stdout, /nothing to close/);
    assert.deepEqual(api.state.requests.map(({ method }) => method), ['GET']);
  } finally {
    await api.close();
  }
});

test('pull-request runs and other branches are not tracked', async () => {
  for (const overrides of [{ CI_EVENT: 'pull_request' }, { CI_BRANCH: 'feature/x' }]) {
    const api = await startApi();
    try {
      const { stdout } = await report(api.url, overrides);
      assert.match(stdout, /no issue/);
      assert.deepEqual(api.state.requests, []);
    } finally {
      await api.close();
    }
  }
});

test('an unreadable job list still files the issue', async () => {
  const api = await startApi({ failJobs: true });
  try {
    const { stdout } = await report(api.url);
    assert.match(stdout, /could not list the failed jobs/);
    assert.match(stdout, /opened #100/);
    assert.match(api.state.issues[0].body, /not reported/);
  } finally {
    await api.close();
  }
});
