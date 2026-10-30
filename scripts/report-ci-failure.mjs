#!/usr/bin/env node
/**
 * Leave a trace of a red `ci` run in this repository.
 *
 * The `ci` workflow runs hourly, so a failing run must not open a new issue every
 * hour. One issue per default branch is kept instead: a failure opens it (or refreshes
 * its body, which names the run, the commit and the failing jobs), and the next green
 * run closes it with a comment naming the run that recovered. Pull-request runs are
 * skipped — the pull request already carries their result.
 *
 * Inputs come from the `workflow_run` payload via the environment; see
 * `.github/workflows/ci-failure-issue.yml`:
 *
 *   GITHUB_TOKEN          token with `issues: write` (and `actions: read` for the jobs)
 *   GITHUB_REPOSITORY     owner/name
 *   GITHUB_API_URL        API base, defaults to https://api.github.com
 *   CI_EVENT              push | schedule | workflow_dispatch | pull_request
 *   CI_CONCLUSION         success | failure | timed_out | action_required | …
 *   CI_BRANCH             branch the run was for
 *   CI_DEFAULT_BRANCH     the branch whose red runs are tracked
 *   CI_RUN_ID, CI_RUN_URL, CI_RUN_ATTEMPT, CI_SHA
 */

const apiBase = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
const token = process.env.GITHUB_TOKEN ?? "";
const repo = process.env.GITHUB_REPOSITORY ?? "";

/** Conclusions that leave an issue open. */
const FAILING = new Set(["failure", "timed_out", "action_required"]);
/** Label attached to the issue this script owns. */
const LABEL = "ci-failure";

const log = (message) => console.log(`[ci-failure-issue] ${message}`);
const env = (name) => process.env[name] ?? "";
const repoPath = (suffix) => `/repos/${repo}${suffix}`;
const short = (sha) => (sha ? sha.slice(0, 7) : "unknown");

const SKIPPED = 0;

/**
 * Call the GitHub API.
 * @param method - HTTP method.
 * @param path - path below the API base.
 * @param body - JSON body, omitted when undefined.
 * @param tolerate - return undefined instead of throwing for the statuses this accepts.
 * @returns the parsed body, or undefined for an empty or tolerated response.
 */
async function request(method, path, body, tolerate = () => false) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "dsh-remote-signin-ci",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    if (tolerate(response.status)) return undefined;
    throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  }
  return text === "" ? undefined : JSON.parse(text);
}

/**
 * The open issue this script owns for a title, ignoring pull requests.
 * @param title - exact issue title.
 * @returns the issue, or undefined.
 */
async function openIssue(title) {
  const issues = await request("GET", repoPath("/issues?state=open&per_page=100"));
  return issues.find((issue) => issue.pull_request === undefined && issue.title === title);
}

/**
 * Names of the failed jobs of a run; empty when the API cannot list them, because a
 * missing detail must not stop the issue from being filed.
 * @param runId - the workflow run id.
 * @returns failed job names.
 */
async function failedJobs(runId) {
  try {
    const page = await request("GET", repoPath(`/actions/runs/${runId}/jobs?per_page=100`));
    return page.jobs.filter((job) => job.conclusion === "failure").map((job) => job.name);
  } catch (error) {
    log(`could not list the failed jobs: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

/**
 * Markdown body of the tracking issue.
 * @param context - run facts from the environment.
 * @param jobs - failed job names.
 * @returns the issue body.
 */
function issueBody(context, jobs) {
  const failed = jobs.length > 0 ? jobs.join(", ") : "not reported";
  return [
    `The \`ci\` workflow failed on \`${context.branch}\`.`,
    "",
    "| | |",
    "|---|---|",
    `| Run | [${context.runId}](${context.runUrl}) · attempt ${context.attempt} |`,
    `| Commit | \`${short(context.sha)}\` |`,
    `| Trigger | \`${context.event}\` |`,
    `| Failed jobs | ${failed} |`,
    `| Last failure | ${new Date().toISOString()} |`,
    "",
    "This issue is maintained by `.github/workflows/ci-failure-issue.yml`: the next failing",
    "run refreshes this body, and the next green run closes the issue. Rerunning the",
    "failed job is the way to a green run, not opening a second issue.",
  ].join("\n");
}

/**
 * Create the label the first time a failure is filed; GitHub answers 422 when it exists.
 * @returns nothing.
 */
async function ensureLabel() {
  await request(
    "POST",
    repoPath("/labels"),
    { name: LABEL, color: "d73a4a", description: "A ci run is failing" },
    (status) => status === 422,
  );
}

async function main() {
  if (token === "" || repo === "") throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY must be set");

  const event = env("CI_EVENT");
  if (event === "pull_request") {
    log("pull-request run: the pull request carries its own result, no issue");
    return SKIPPED;
  }

  const branch = env("CI_BRANCH");
  const defaultBranch = env("CI_DEFAULT_BRANCH");
  if (branch !== defaultBranch) {
    log(`run for ${JSON.stringify(branch)}: only ${JSON.stringify(defaultBranch)} is tracked, no issue`);
    return SKIPPED;
  }

  const conclusion = env("CI_CONCLUSION");
  const title = `ci failed on ${branch}`;
  const issue = await openIssue(title);
  const runUrl = env("CI_RUN_URL");

  if (conclusion === "success") {
    if (issue === undefined) {
      log("green again, and no issue is open: nothing to close");
      return;
    }
    await request("POST", repoPath(`/issues/${issue.number}/comments`), {
      body: `Recovered: [${env("CI_RUN_ID")}](${runUrl}) is green on \`${short(env("CI_SHA"))}\`.`,
    });
    await request("PATCH", repoPath(`/issues/${issue.number}`), { state: "closed", state_reason: "completed" });
    log(`closed #${issue.number}: green again`);
    return;
  }

  if (!FAILING.has(conclusion)) {
    log(`conclusion ${JSON.stringify(conclusion)}: nothing to report`);
    return SKIPPED;
  }

  const jobs = await failedJobs(env("CI_RUN_ID"));
  const body = issueBody(
    {
      branch,
      runId: env("CI_RUN_ID"),
      runUrl,
      attempt: env("CI_RUN_ATTEMPT") || "1",
      sha: env("CI_SHA"),
      event,
    },
    jobs,
  );

  if (issue !== undefined) {
    await request("PATCH", repoPath(`/issues/${issue.number}`), { body });
    log(`refreshed #${issue.number}: ${title}`);
    return;
  }

  await ensureLabel();
  const created = await request("POST", repoPath("/issues"), { title, body, labels: [LABEL] });
  log(`opened #${created.number}: ${title}`);
}

try {
  await main();
} catch (error) {
  console.error(`[ci-failure-issue] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
