# jira-workflow-gitbot
A GitHub app to sync PR actions with your Jira workflow.

## Problem
When using Jira as the issue tracker for a project in combination with using GitHub for pull-requests, there is a tedious problem of keeping the Jira ticket in sync with the PR's state. Rather than manually managing any updates across both applications, the idea is to drive the workflow from GitHub, and use a GitHub app to keep the corresponding Jira ticket in sync.

## User Stories

- [x] When an issue is created in GitHub, comment that issues should be created in Jira instead.
- [x] When a PR title is prefixed with a Jira ticket number, the bot should write a comment to indicate that the PR has been linked with the Jira ticket. _This is a prerequisite for all subsequent stories._
- [x] When a PR is assigned to a user, the `Assignee` field on the Jira ticket should be updated to match.
- [ ] When a reviewer is added to a PR, the `Reviewer` field on the Jira ticket should be updated to include this user.
- [ ] When a reviewer is removed from a PR, the `Reviewer` field on the Jira ticket should be updated to exclude this user.
- [ ] When a reviewer requests changes, the Jira ticket should be transitioned back to `In Progress`
- [ ] When a PR is merged, the Jira ticket should be transitioned to `Resolved`

## Design
* Use the [Probot framework](https://probot.github.io) to build a GitHub App in node.js
  * Write hooks for each of the necessary GitHub PR events
  * Use the Jira REST API to make changes to the Jira ticket
    * Store an API key as a secret
  * Use config file in project repo to define bot behavior
    * Provide mapping from GitHub users to Jira users
    * Define the Jira project URL

## Deployment
* Use [Glitch](https://glitch.com/) to host the application in the cloud

## Setup

```sh
# Install dependencies
npm install

# Run the bot
npm start
```

## Docker

```sh
# 1. Build container
docker build -t jira-workflow-gitbot .

# 2. Start container
docker run -e APP_ID=<app-id> -e PRIVATE_KEY=<pem-value> jira-workflow-gitbot
```

## Resources
* [Probot API documentation](https://probot.github.io/docs/)
* [Jira REST API documentation](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/)
* [JiraApi library documentation](https://jira-node.github.io/class/src/jira.js~JiraApi.html)
* [Jira basic auth info](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/)
* [GitHub webhook documentation](https://docs.github.com/en/developers/webhooks-and-events/webhook-events-and-payloads#pull_request)
* [GitHub Apps management](https://github.com/settings/apps/)
* [GitHub REST API documentation](https://octokit.github.io/rest.js/v18#pulls)

## License

[ISC](LICENSE) © 2021 Justin Murray <justin@murrayju.com>
