import { Context, Probot } from 'probot';
import JiraApi from 'jira-client';
import fetch, { RequestInit } from 'node-fetch';
import fs from 'fs-extra';
const metadata = require('probot-metadata');

const metaKey_jiraIssue = 'jira-issue';

const logEvent = async (context: Context) => {
  context.log.debug(`${context.name}.${context.payload?.action}`);
  if (context.log.level === 'debug') {
    await fs.ensureDir('./log');
    await fs.writeJson('./log/last_payload.json', context.payload);
  }
};

const getJiraCfg = async (context: Context) => {
  const defaults = {
    host: '',
    protocol: 'https',
    projectKey: '',
    apiVersion: 'latest',
    userMap: {} as { [gitHubUser: string]: string },
  };
  const config = await context.config('jira.yml', {
    jira: defaults,
  });
  return config?.jira || defaults;
};

const getJira = async (context: Context) => {
  const { host, protocol, projectKey, apiVersion, ...rest } = await getJiraCfg(context);
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
    apiVersion,
  });

  const url = `${protocol}://${host}`;

  // sadly the JiraApi is incomplete, so here's a fetch wrapper
  const fetchWrapper = (route: string, options?: RequestInit) =>
    fetch(`${route.startsWith(url) ? route : `${url}/rest/api/${apiVersion}/${route}`}`, {
      ...options,
      headers: {
        ...options?.headers,
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    }).then(async (r) => {
      if (r.ok) {
        if (r.status !== 204) {
          return r.json();
        }
        return null;
      }
      throw new Error(`${r.status}: ${await r.text()}`);
    });

  return {
    ...rest,
    host,
    protocol,
    projectKey,
    api,
    url,
    fetch: fetchWrapper,
    issueLinkMd: (issue: string) => `[${issue}](${url}/browse/${issue})`,
  };
};

const writeComment = async (context: Context, comment: string) =>
  context.octokit.issues.createComment(
    context.issue({
      body: comment,
    }),
  );

export = (app: Probot) => {
  app.on('issues.opened', async (context) => {
    await logEvent(context);
    const jira = await getJira(context);
    if (!jira) {
      return;
    }
    // TODO: actually create the Jira issue and close the GitHub issue
    await writeComment(context, `Please create issues in [Jira](${jira.url}).`);
  });

  app.on(['pull_request.opened', 'pull_request.edited'], async (context) => {
    await logEvent(context);
    const {
      payload: { action },
      payload,
    } = context;
    if (action === 'edited' && !(payload as any).changes?.title) {
      app.log.debug('Title unchanged by edit, ignoring.');
      return;
    }
    const jira = await getJira(context);
    if (!jira) {
      return;
    }
    const { title: prTitle, html_url: prUrl, number: prId } = context.payload.pull_request;
    const [, matchedKey, prTitleText] =
      prTitle.match(new RegExp(`^(${jira.projectKey}-\\d+):\\s*(.+)\\s*$`, 'i')) || [];
    const detectedIssue = (matchedKey || '').toUpperCase();
    const existingIssue =
      action === 'opened' ? null : (await metadata(context).get(metaKey_jiraIssue)) || '';

    if (detectedIssue === existingIssue) {
      // issue hasn't changed, nothing to do
      app.log.debug(`Issue unchanged: ${existingIssue || '<empty>'}`);
      return;
    }

    if (existingIssue) {
      // remove the old reference
      app.log.debug(`Removing existing issue: ${existingIssue}`);
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
      app.log.debug(`Adding new issue: ${detectedIssue}`);
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
        await writeComment(
          context,
          `Successfully linked this PR to Jira: ${jira.issueLinkMd(detectedIssue)}`,
        );
      } catch (err) {
        app.log.debug('Error contacting Jira, consider issue not found', err);
        await writeComment(
          context,
          `The specified issue \`${detectedIssue}\` could not be found in Jira.`,
        );
      }
    } else {
      await writeComment(
        context,
        `Warning: no Jira issue is associated with this PR. Prefix the PR title with \`${jira.projectKey}-0:\`.`,
      );
    }

    // Record the change
    await metadata(context).set(metaKey_jiraIssue, detectedIssue);
  });

  app.on('pull_request.assigned', async (context) => {
    await logEvent(context);
    const { assignee } = context.payload.pull_request;
    if (!assignee) {
      app.log.warn('Unexpected, assignee is empty');
      return;
    }
    const { login } = assignee;
    if (!login) {
      app.log.warn('Unexpected, login is empty');
      return;
    }
    app.log.info({ login });

    const issue = (await metadata(context).get(metaKey_jiraIssue)) || '';
    if (!issue) {
      app.log.warn('Cannot update assignee, no issue associated.');
      return;
    }
    const jira = await getJira(context);
    if (!jira) {
      return;
    }
    const jiraUsers = await jira.fetch(`user/search?query=${jira.userMap[login] || login}`);
    if (jiraUsers.length !== 1) {
      await writeComment(
        context,
        `Could not update assignee for ${jira.issueLinkMd(
          issue,
        )}, user mapping required for \`${login}\`. Please update manually.`,
      );
    }
    const [{ accountId, displayName }] = jiraUsers;
    try {
      await jira.fetch(`issue/${issue}/assignee`, {
        method: 'PUT',
        body: JSON.stringify({ accountId }),
      });
      await writeComment(
        context,
        `Jira ticket ${jira.issueLinkMd(issue)} has been assigned to ${displayName}`,
      );
    } catch (err) {
      app.log.error(`Failed to call Jira issue assign: ${err.message}`);
      console.error(err);
      await writeComment(
        context,
        `Warning: failed to update assignee for ${jira.issueLinkMd(
          issue,
        )}, please update manually.`,
      );
    }
  });
};
