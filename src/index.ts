import { Probot } from 'probot';
import _ from 'lodash';
import { logEvent, getJira, writeComment, getPrAssignee } from './probotHelpers';
import { markdownToJira } from './j2m';

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
    await writeComment(
      context,
      `Please create issues in [Jira](${jira.url}/browse/${jira.projectKey}).`,
    );
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
    if (
      action === 'edited' &&
      !((payload as any).changes?.title || (payload as any).changes?.body)
    ) {
      app.log.debug('Title and body unchanged by edit, ignoring.');
      return;
    }
    const jira = await getJira(context);
    if (!jira) {
      // Jira is not configured for this project, do nothing
      return;
    }
    const {
      title: prTitle,
      html_url: prUrl,
      number: prId,
      body: prBody,
      requested_reviewers: prReviewers,
      user: prUser,
    } = context.payload.pull_request;
    const { issue: detectedIssue, description: prTitleText } = jira.parseTitle(prTitle);
    const existingIssue = action === 'opened' ? null : await jira.getCachedIssue(context);
    const issueDetail = detectedIssue ? await jira.getIssueDetail(context, detectedIssue) : null;

    if (detectedIssue === existingIssue) {
      // issue hasn't changed, nothing to do
      app.log.debug(`Issue unchanged: ${existingIssue || '<empty>'}`);
    } else {
      if (existingIssue) {
        // remove the old reference
        app.log.debug(`Removing existing issue: ${existingIssue}`);
        try {
          const existingLinks = ((await jira.fetch(
            `issue/${existingIssue}/remotelink`,
          )) as any[]).filter((link) => link?.object?.url === prUrl);
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
        if (issueDetail) {
          app.log.debug(`Adding new issue: ${detectedIssue}`);
          const existingLinks = (await jira.fetch(`issue/${detectedIssue}/remotelink`)) as any[];
          if (!existingLinks.some((link) => link?.object?.url === prUrl)) {
            await jira.fetch(`issue/${detectedIssue}/remotelink`, {
              method: 'POST',
              body: JSON.stringify({
                object: {
                  url: prUrl,
                  title: `GitHub PR #${prId} - ${prTitleText}`,
                },
              }),
            });
            await writeComment(
              context,
              `Successfully linked this PR to Jira: ${jira.issueLinkMd(detectedIssue)}`,
            );
          } else {
            app.log.info(`Jira issue already has link to PR #${prId}`);
          }
        } else {
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
    }

    // sync PR + Jira detail
    if (detectedIssue && issueDetail) {
      // Jira comment containing PR link and description
      const prefix = 'Linked to GitHub PR';
      const body = `${prefix} [#${prId} - ${prTitleText}|${prUrl}]\n----\n${markdownToJira(
        prBody
          .split('\n')
          .filter((l) => !l.startsWith('<!--'))
          .join('\n'),
      )}`;
      const existingComment = (issueDetail.fields?.comment?.comments || []).find(
        (c: any) => c.author.name === jira.username && c.body.startsWith(prefix),
      );
      try {
        if (existingComment) {
          await jira.fetch(`issue/${detectedIssue}/comment/${existingComment.id}`, {
            method: 'PUT',
            body: JSON.stringify({ body }),
          });
        } else {
          await jira.fetch(`issue/${detectedIssue}/comment`, {
            method: 'POST',
            body: JSON.stringify({ body }),
          });
        }
      } catch (err) {
        app.log.error(`Failed to add Jira comment: ${err.message}`);
      }

      // Sync the assignee, if not already set
      const login = getPrAssignee(context);
      if (!login && issueDetail.fields?.assignee?.name) {
        const ghUser = jira.toGitHubUser(issueDetail.fields?.assignee?.name);
        if (ghUser) {
          await context.octokit.issues.addAssignees(
            context.issue({
              assignees: [ghUser],
            }),
          );
        }
      } else if (login && !issueDetail.fields?.assignee) {
        await jira.setAssignee(context, detectedIssue, login);
      }

      // Sync reviewers
      if (jira.fields.reviewers) {
        const existingPrReviewers = prReviewers.map((r) => r.login);
        const existingJiraReviewers = (issueDetail.fields?.[jira.fields.reviewers] || []).map(
          (r: any) => r.name,
        );

        const toAddToPr = _.difference(
          existingJiraReviewers
            .map((j: string) => jira.toGitHubUser(j))
            .filter((u: string | null) => !!u),
          existingPrReviewers,
          [prUser.login],
        );
        if (toAddToPr.length) {
          try {
            await context.octokit.pulls.requestReviewers(
              context.pullRequest({
                reviewers: toAddToPr,
              }),
            );
          } catch (err) {
            app.log.error(`Failed to set PR reviewers: ${err.message}`);
          }
        }

        const toAddToJira = _.difference(
          existingPrReviewers.map((g: string) => jira.userMap[g]).filter((u) => !!u),
          existingJiraReviewers,
        );
        if (toAddToJira) {
          try {
            await jira.fetch(`issue/${detectedIssue}`, {
              method: 'PUT',
              body: JSON.stringify({
                fields: {
                  [jira.fields.reviewers]: _.union(
                    toAddToJira,
                    existingJiraReviewers,
                  ).map((name) => ({ name })),
                },
              }),
            });
          } catch (err) {
            app.log.error(`Failed to set Jira reviewers: ${err.message}`);
          }
        }
      }
    }
  });

  /**
   * When a PR is assigned, update the linked Jira issue to match
   */
  app.on('pull_request.assigned', async (context) => {
    await logEvent(context);
    const login = getPrAssignee(context);
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
    await jira.setAssignee(context, issue, login);
  });

  /**
   * When a reviewer is added/removed, sync with Jira
   */
  app.on(
    ['pull_request.review_request_removed', 'pull_request.review_requested'],
    async (context) => {
      await logEvent(context);
      const jira = await getJira(context);
      if (!jira || !jira.fields?.reviewers) {
        // Jira is not configured for this project, do nothing
        return;
      }
      const issue = await jira.getCachedIssue(context);
      if (!issue) {
        app.log.warn('Cannot update reviewers, no issue associated.');
        return;
      }
      const { requested_reviewers } = context.payload.pull_request;
      await jira.setReviewers(
        context,
        issue,
        requested_reviewers.map((r) => r.login),
      );
    },
  );
};
