import { Probot } from 'probot';
import { logEvent, getJira, writeComment } from './probotHelpers';

/**
 * The Probot library acts as the entrypoint, and handles much of the application logic for us.
 * Here we export a function, which is loaded by Probot as middleware.
 */
export = (app: Probot) => {
  /**
   * When an issue is opened, write a comment instructing the user to use Jira instead.
   */
  app.on('issues.opened', async (context) => {
    await logEvent(context);
    const jira = await getJira(context);
    if (!jira) {
      // Jira is not configured for this project, do nothing
      return;
    }
    // TODO: actually create the Jira issue and close the GitHub issue
    await writeComment(context, `Please create issues in [Jira](${jira.url}).`);
  });

  /**
   * When a PR is created/edited, check for a corresponding Jira issue key in the title.
   * Comments are written with links when successful, or with error messages for failures or incorrect use.
   */
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
      // Jira is not configured for this project, do nothing
      return;
    }
    const { title: prTitle, html_url: prUrl, number: prId } = context.payload.pull_request;
    const { issue: detectedIssue, description: prTitleText } = jira.parseTitle(prTitle);
    const existingIssue = action === 'opened' ? null : await jira.getCachedIssue(context);

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

    // Record the new issue in the metadata
    await jira.setCachedIssue(context, detectedIssue);
  });

  /**
   * When a PR is assigned, update the linked Jira issue to match
   */
  app.on('pull_request.assigned', async (context) => {
    await logEvent(context);
    const login = context.payload.pull_request.assignee?.login;
    if (!login) {
      app.log.warn('Unexpected, login is empty');
      return;
    }

    const jira = await getJira(context);
    if (!jira) {
      // Jira is not configured for this project, do nothing
      return;
    }
    const issue = await jira.getCachedIssue(context);
    if (!issue) {
      app.log.warn('Cannot update assignee, no issue associated.');
      return;
    }

    // Lookup GH login in the configured user map, or fall back to searching for a match for the login directly
    const jiraUsers = await jira.fetch(`user/search?query=${jira.userMap[login] || login}`);
    if (jiraUsers.length !== 1) {
      // If there's not exactly one match, consider it a failure
      await writeComment(
        context,
        `Could not update assignee for ${jira.issueLinkMd(
          issue,
        )}, user mapping required for \`${login}\`. Please update manually.`,
      );
      return;
    }
    const [{ accountId, displayName }] = jiraUsers;

    // Set the Jira assignee
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
