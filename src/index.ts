import { Context, Probot } from 'probot';
import JiraApi from 'jira-client';
import fetch, { RequestInit } from 'node-fetch';
const metadata = require('probot-metadata');

const metaKey_jiraIssue = 'jira-issue';

const getJiraCfg = async (context: Context) => {
  const defaults = { host: '', protocol: 'https', projectKey: '' };
  const config = await context.config('jira.yml', {
    jira: defaults,
  });
  return config?.jira || defaults;
};

const getJira = async (context: Context) => {
  const { host, protocol, projectKey, ...rest } = await getJiraCfg(context);
  if (!host) {
    context.log.warn(`No Jira host defined for ${context.payload.repository.name}`);
    return null;
  }
  if (!projectKey) {
    context.log.warn(`No Jira projectKey defined for ${context.payload.repository.name}`);
    return null;
  }
  const username = process.env.JIRA_USER;
  const password = process.env.JIRA_PASS;
  const api = new JiraApi({
    host,
    protocol,
    username,
    password,
  });

  const url = `${protocol}://${host}`;

  // sadly the JiraApi is incomplete, so here's a fetch wrapper
  const fetchWrapper = (route: string, options?: RequestInit) =>
    fetch(`${route.startsWith(url) ? route : `${url}/rest/api/3/${route}`}`, {
      ...options,
      headers: {
        ...options?.headers,
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      },
    }).then(async (r) => {
      if (r.ok) {
        if (r.size) {
          return r.json();
        }
        return null;
      }
      throw new Error(`${r.status}: ${await r.text()}`);
    });

  return { ...rest, host, protocol, projectKey, api, url, fetch: fetchWrapper };
};

export = (app: Probot) => {
  app.on('issues.opened', async (context) => {
    const jira = await getJira(context);
    if (!jira) {
      return;
    }
    // TODO: actually create the Jira issue and close the GitHub issue
    const issueComment = context.issue({
      body: `Please create issues in [Jira](${jira.url}).`,
    });
    await context.octokit.issues.createComment(issueComment);
  });

  app.on(['pull_request.opened', 'pull_request.edited'], async (context) => {
    const jira = await getJira(context);
    if (!jira) {
      return;
    }
    const { title: prTitle, html_url: prUrl, number: prId } = context.payload.pull_request;
    const existingIssue = (await metadata(context).get(metaKey_jiraIssue)) || '';
    const [, matchedKey, prTitleText] =
      prTitle.match(new RegExp(`^(${jira.projectKey}-\\d+):\\s*(.+)\\s*$`, 'i')) || [];
    const detectedIssue = (matchedKey || '').toUpperCase();

    if (detectedIssue === existingIssue) {
      // issue hasn't changed, nothing to do
      return;
    }

    if (existingIssue) {
      // remove the old reference
      try {
        const issue = await jira.api.findIssue(existingIssue);
        const existingLinks = ((await jira.api.getRemoteLinks(issue.id)) as any[]).filter(
          (link) => link?.object?.url === prUrl,
        );
        await Promise.all(
          existingLinks.map(async ({ self }) => {
            app.log.info(`Deleting link ${self}`);
            await jira.fetch(self, { method: 'DELETE' });
          }),
        );
      } catch (err) {
        app.log.info(`Removing existing link from Jira issue failed`, err);
      }
    }

    if (detectedIssue) {
      try {
        const issue = await jira.api.findIssue(detectedIssue);
        const existingLinks = (await jira.api.getRemoteLinks(issue.id)) as any[];
        if (!existingLinks.some((link) => link?.object?.url === prUrl)) {
          await jira.api.createRemoteLink(issue.id, {
            object: {
              url: prUrl,
              title: `GitHub PR #${prId} - ${prTitleText}`,
            },
          });
        } else {
          app.log.info(`Jira issue already has link to PR #${prId}`);
        }
        await context.octokit.issues.createComment(
          context.issue({
            body: `Successfully linked this PR to Jira: [${detectedIssue}](${jira.url}/browse/${detectedIssue})`,
          }),
        );
      } catch (err) {
        await context.octokit.issues.createComment(
          context.issue({
            body: `The specified issue \`${detectedIssue}\` could not be found in Jira.`,
          }),
        );
      }
    } else {
      await context.octokit.issues.createComment(
        context.issue({
          body: `Warning: no Jira issue is associated with this PR. Prefix the PR title with \`${jira.projectKey}-0:\`.`,
        }),
      );
    }

    // Record the change
    await metadata(context).set(metaKey_jiraIssue, detectedIssue);
  });
};
