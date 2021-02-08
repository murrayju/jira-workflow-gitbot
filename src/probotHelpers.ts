import { Context } from 'probot';
import JiraApi from 'jira-client';
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
  const api = new JiraApi({
    host,
    protocol,
    username,
    password,
    apiVersion,
  });

  const url = `${protocol}://${host}`;
  const issuePrefixRegex = new RegExp(
    `^\\s*\\[?\\s*(${projectKey}-\\d+)\\s*\\]?\\s*(?:-|:)\\s*(.+)\\s*$`,
    'i',
  );

  return {
    ...rest,
    host,
    protocol,
    projectKey,
    api,
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
