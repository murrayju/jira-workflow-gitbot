// You can import your modules
// import index from '../src/index'

import nock from 'nock';
import { Probot, ProbotOctokit } from 'probot';
import fs from 'fs-extra';
import path from 'path';

// Requiring our app implementation
import myProbotApp from '../src';
// Requiring our fixtures
import issuesOpenedPayload from './fixtures/issues.opened.json';
import prOpenedPayload from './fixtures/pull_request.opened.json';
import prAssignedPayload from './fixtures/pull_request.assigned.json';

const privateKey = fs.readFileSync(path.join(__dirname, 'fixtures/mock-cert.pem'), 'utf-8');
const jiraConfig = fs.readFileSync(path.join(__dirname, 'fixtures/jira.yml'), 'utf8');

const accessToken = {
  token: 'test',
  permissions: {
    issues: 'write',
  },
};

describe('Probot app', () => {
  let probot: Probot;

  beforeEach(() => {
    nock.disableNetConnect();
    probot = new Probot({
      appId: 123,
      privateKey,
      // disable request throttling and retries for testing
      Octokit: ProbotOctokit.defaults({
        retry: { enabled: false },
        throttle: { enabled: false },
      }),
    });
    // Load our app into probot
    probot.load(myProbotApp);
  });

  test('creates a comment when an issue is opened', async (done) => {
    const mock = nock('https://api.github.com')
      // Test that we correctly return a test token
      .post('/app/installations/2/access_tokens')
      .reply(200, accessToken)
      // Handle config read
      .get('/repos/testuser/test-repo/contents/.github%2Fjira.yml')
      .reply(200, jiraConfig)

      // Test that a comment is posted
      .post('/repos/testuser/test-repo/issues/1/comments', (body: any) => {
        done(expect(body).toMatchSnapshot());
        return true;
      })
      .reply(200);

    // Receive a webhook event
    await probot.receive({ id: '1', name: 'issues', payload: issuesOpenedPayload });

    expect(mock.pendingMocks()).toStrictEqual([]);
  });

  test('creates a linking comment when a PR is created with valid issue', async (done) => {
    const mock = nock('https://api.github.com')
      // Test that we correctly return a test token
      .post('/app/installations/2/access_tokens')
      .reply(200, accessToken)
      // Handle config read
      .get('/repos/testuser/test-repo/contents/.github%2Fjira.yml')
      .reply(200, jiraConfig)

      // Test that a comment is posted
      .post('/repos/testuser/test-repo/issues/1/comments', (body: any) => {
        expect(body).toMatchSnapshot();
        return true;
      })
      .reply(200)
      // Handle metadata read
      .get('/repos/testuser/test-repo/issues/1')
      .reply(200, { body: '' })
      // Handle metadata write
      .patch('/repos/testuser/test-repo/issues/1', (body: any) => {
        done(expect(body).toMatchSnapshot());
        return true;
      })
      .reply(200);

    const jiraMock = nock('https://fake-jira')
      // get the issue details
      .get('/rest/api/latest/issue/TEST-7')
      .reply(200, { id: 'jira123' })
      // get the existing links
      .get('/rest/api/latest/issue/TEST-7/remotelink')
      .reply(200, [])
      // create a new link
      .post('/rest/api/latest/issue/TEST-7/remotelink', (body: any) => {
        expect(body).toMatchSnapshot();
        return true;
      })
      .reply(200, { id: 'link1' })
      // create a new comment
      .post('/rest/api/latest/issue/TEST-7/comment', (body: any) => {
        expect(body).toMatchSnapshot();
        return true;
      })
      .reply(200, { id: 'comment1' });

    // Receive a webhook event
    await probot.receive({ id: '1', name: 'pull_request', payload: prOpenedPayload });

    expect(mock.pendingMocks()).toStrictEqual([]);
    expect(jiraMock.pendingMocks()).toStrictEqual([]);
  });

  test('creates a not found comment when a PR is created with invalid issue', async (done) => {
    const mock = nock('https://api.github.com')
      // Test that we correctly return a test token
      .post('/app/installations/2/access_tokens')
      .reply(200, accessToken)
      // Handle config read
      .get('/repos/testuser/test-repo/contents/.github%2Fjira.yml')
      .reply(200, jiraConfig)

      // Test that a comment is posted
      .post('/repos/testuser/test-repo/issues/1/comments', (body: any) => {
        expect(body).toMatchSnapshot();
        return true;
      })
      .reply(200)
      // Handle metadata read
      .get('/repos/testuser/test-repo/issues/1')
      .reply(200, { body: '' })
      // Handle metadata write
      .patch('/repos/testuser/test-repo/issues/1', (body: any) => {
        done(expect(body).toMatchSnapshot());
        return true;
      })
      .reply(200);

    const jiraMock = nock('https://fake-jira')
      // get the issue details
      .get('/rest/api/latest/issue/TEST-99')
      .reply(404);

    // Receive a webhook event
    await probot.receive({
      id: '1',
      name: 'pull_request',
      payload: {
        ...prOpenedPayload,
        pull_request: {
          ...prOpenedPayload.pull_request,
          title: 'TEST-99: does not exist',
        },
      },
    });

    expect(mock.pendingMocks()).toStrictEqual([]);
    expect(jiraMock.pendingMocks()).toStrictEqual([]);
  });

  test('creates a warning comment if PR created with no issue specified', async (done) => {
    const mock = nock('https://api.github.com')
      // Test that we correctly return a test token
      .post('/app/installations/2/access_tokens')
      .reply(200, accessToken)
      // Handle config read
      .get('/repos/testuser/test-repo/contents/.github%2Fjira.yml')
      .reply(200, jiraConfig)
      // Test that a comment is posted
      .post('/repos/testuser/test-repo/issues/1/comments', (body: any) => {
        expect(body).toMatchSnapshot();
        return true;
      })
      .reply(200)
      // Handle metadata read
      .get('/repos/testuser/test-repo/issues/1')
      .reply(200, { body: '' })
      // Handle metadata write
      .patch('/repos/testuser/test-repo/issues/1', (body: any) => {
        done(expect(body).toMatchSnapshot());
        return true;
      })
      .reply(200);

    // Receive a webhook event
    await probot.receive({
      id: '1',
      name: 'pull_request',
      payload: {
        ...prOpenedPayload,
        pull_request: {
          ...prOpenedPayload.pull_request,
          title: 'No issue',
        },
      },
    });

    expect(mock.pendingMocks()).toStrictEqual([]);
  });

  test('when PR assigned, updates Jira assignee', async (done) => {
    const mock = nock('https://api.github.com')
      // Test that we correctly return a test token
      .post('/app/installations/2/access_tokens')
      .reply(200, accessToken)
      // Handle metadata read
      .get('/repos/testuser/test-repo/issues/1')
      .reply(200, { body: prAssignedPayload.pull_request.body })
      // Handle config read
      .get('/repos/testuser/test-repo/contents/.github%2Fjira.yml')
      .reply(200, jiraConfig)
      // Test that a comment is posted
      .post('/repos/testuser/test-repo/issues/1/comments', (body: any) => {
        done(expect(body).toMatchSnapshot());
        return true;
      })
      .reply(200);

    const jiraMock = nock('https://fake-jira')
      // attempt user lookup
      .get('/rest/api/latest/user?username=testuser')
      .reply(404)
      // search for the user
      .get('/rest/api/latest/user/search?query=testuser&username=testuser')
      .reply(200, [{ accountId: 'jiraAccount123', displayName: 'Mr. Test User' }])
      // set the assignee
      .put('/rest/api/latest/issue/TEST-1/assignee', (body: any) => {
        expect(body).toMatchSnapshot();
        return true;
      })
      .reply(204);

    // Receive a webhook event
    await probot.receive({
      id: '1',
      name: 'pull_request',
      payload: prAssignedPayload,
    });

    expect(mock.pendingMocks()).toStrictEqual([]);
    expect(jiraMock.pendingMocks()).toStrictEqual([]);
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });
});

// For more information about testing with Jest see:
// https://facebook.github.io/jest/

// For more information about using TypeScript in your tests, Jest recommends:
// https://github.com/kulshekhar/ts-jest

// For more information about testing with Nock see:
// https://github.com/nock/nock
