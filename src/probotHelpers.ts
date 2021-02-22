import { Context } from 'probot';
import fetch, { RequestInit } from 'node-fetch';
import fs from 'fs-extra';
const metadata = require('probot-metadata');

const metaKey_jiraIssue = 'jira-issue';

/**
 * Debug level logging of event and payload
 * @param context a Probot event Context
 * @returns a Promise<void>
 */
export const logEvent = async (context: Context) => {
  context.log.debug(`${context.name}.${context.payload?.action}`);
  if (context.log.level === 'debug') {
    await fs.ensureDir('./log');
    await fs.writeJson('./log/last_payload.json', context.payload);
  }
};

/**
 * Read Jira configuration from the repo, with defaults.
 * @param context a Probot event Context
 * @returns a Promise for the Jira config object
 */
export const getJiraCfg = async (context: Context) => {
  const defaults = {
    host: '',
    protocol: 'https',
    projectKey: '',
    apiVersion: 'latest',
    userMap: {} as { [gitHubUser: string]: string },
    fields: {
      reviewers: '',
    },
  };
  const config = await context.config('jira.yml', {
    jira: defaults,
  });
  return config?.jira || defaults;
};

/**
 * Get the Jira API helper for this repo.
 * Includes config values, JiraApi, and fetch wrapper
 * @param context a Probot event Context
 * @returns a Promise for the helper object
 */
export const getJira = async (context: Context) => {
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

  const url = `${protocol}://${host}`;
  const issuePrefixRegex = new RegExp(
    `^\\s*\\[?\\s*(${projectKey}-\\d+)\\s*\\]?\\s*(?:-|:)\\s*(.+)\\s*$`,
    'i',
  );

  return {
    ...rest,
    username,
    host,
    protocol,
    projectKey,
    url,
    issuePrefixRegex,

    /**
     * Given a title that may or may not be prefixed with an issue key,
     * Parse out the issue from the rest of the title.
     * @param title The issue prefixed title string
     * @returns an object containing the `issue` and `description`. If not found, values will be empty string.
     */
    parseTitle: (title: string) => {
      const [, matchedKey, description = ''] = title.match(issuePrefixRegex) || [];
      const issue = (matchedKey || '').toUpperCase();
      return { issue, description };
    },

    /**
     * Sadly the JiraApi is incomplete, so here is a wrapper around `fetch` to simplify requests to the API.
     * Makes some assumptions specify to the API to make it more convenient, such as parsing responses as JSON.
     * @param route The Jira API route to make a request to. Can be a complete URL, or just the route.
     * @param options Pass-through options to `fetch`. Authorization and Content-Type headers are automatically merged in.
     * @returns a Promise for the parsed JSON response, or `null` if no content was returned.
     */
    fetch: async (route: string, options?: RequestInit) =>
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
      }),

    /**
     * Generates markdown syntax for a link to a Jira issue
     * @param issue The issue key to link
     * @returns markdown string
     */
    issueLinkMd: (issue: string) => `[${issue}](${url}/browse/${issue})`,

    /**
     * Read the cached jira issue from the GitHub issue metadata
     * @param context a Probot event Context
     * @returns the Jira issue key, or empty string if not set
     */
    getCachedIssue: async (context: Context) =>
      (await metadata(context).get(metaKey_jiraIssue)) || '',

    /**
     * Write jira issue to the GitHub issue's metadata
     * @param context a Probot event Context
     * @param issue the Jira issue key string
     * @returns the Jira issue key, or empty string if not set
     */
    setCachedIssue: async (context: Context, issue: string) =>
      metadata(context).set(metaKey_jiraIssue, issue),

    /**
     * Gets Jira issue detail, null if not found
     * @param context a Probot event Context
     * @param issue the Jira issue key string
     */
    async getIssueDetail(context: Context, issue: string) {
      try {
        return await this.fetch(`issue/${issue}`);
      } catch (err) {
        context.log.debug(`Jira issue key '${issue}' not found.`);
        return null;
      }
    },

    /**
     * Set the jira issue assignee to match the given github login
     * @param context a Probot event Context
     * @param issue the Jira issue key string
     * @param login the GitHub username
     */
    async setAssignee(context: Context, issue: string, login: string) {
      // Lookup GH login in the configured user map, or fall back to searching for a match for the login directly
      const targetUser = this.userMap[login] || login;
      // Try an exact match
      let jiraUser = null;

      try {
        jiraUser = await this.fetch(`user?username=${targetUser}`);
      } catch (err) {
        context.log.warn(`No exact match for Jira user '${targetUser}', trying search`);
        const jiraUsers = await this.fetch(
          `user/search?query=${targetUser}&username=${targetUser}`,
        );
        if (jiraUsers.length !== 1) {
          context.log.debug(JSON.stringify({ targetUser, userMap: this.userMap, jiraUsers }));
          jiraUser = null;
        } else {
          jiraUser = jiraUsers[0];
        }
      }
      if (!jiraUser) {
        // If there's not exactly one match, consider it a failure
        await writeComment(
          context,
          `Could not update assignee for ${this.issueLinkMd(
            issue,
          )}, user mapping required for \`${login}\`. Please update manually.`,
        );
        return;
      }

      // Set the Jira assignee
      try {
        await this.fetch(`issue/${issue}/assignee`, {
          method: 'PUT',
          body: JSON.stringify(jiraUser),
        });
        await writeComment(
          context,
          `Jira ticket ${this.issueLinkMd(issue)} has been assigned to ${jiraUser.displayName}`,
        );
      } catch (err) {
        context.log.error(`Failed to call Jira issue assign: ${err.message}`);
        await writeComment(
          context,
          `Warning: failed to update assignee for ${this.issueLinkMd(
            issue,
          )}, please update manually.`,
        );
      }
    },

    /**
     * Set the jira issue reviewers to match the given github logins
     * @param context a Probot event Context
     * @param issue the Jira issue key string
     * @param logins the GitHub usernames
     */
    async setReviewers(context: Context, issue: string, logins: string[]) {
      if (!this.fields?.reviewers) {
        context.log.warn('Jira reviewers field not configured, skipping');
        return;
      }
      try {
        await this.fetch(`issue/${issue}`, {
          method: 'PUT',
          body: JSON.stringify({
            fields: {
              [this.fields.reviewers]: logins
                .map((r) => this.userMap[r])
                .filter((u) => !!u)
                .map((name) => ({ name })),
            },
          }),
        });
      } catch (err) {
        context.log.error(`Failed to set Jira reviewers: ${err.message}`);
        await writeComment(
          context,
          `Warning: failed to update reviewers for ${this.issueLinkMd(
            issue,
          )}, please update manually.`,
        );
      }
    },

    toGitHubUser(jiraUser: string): null | string {
      return Object.entries(this.userMap).find(([, j]) => j === jiraUser)?.[0] || null;
    },
  };
};

/**
 * Helper to simplify writing a comment to a GH issue (or PR)
 * @param context a Probot event Context
 * @param comment the comment message string
 */
export const writeComment = async (context: Context, comment: string) =>
  context.octokit.issues.createComment(
    context.issue({
      body: comment,
    }),
  );

/**
 * Helper to extract the primary assignee from a pull_request payload
 * @param context a Probot event Context
 */
export const getPrAssignee = (context: Context): string | null => {
  const { assignee, assignees } = context.payload.pull_request;
  return assignee?.login || assignees?.[0]?.login || null;
};
