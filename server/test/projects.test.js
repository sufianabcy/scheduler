import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { projectProgress } from '../src/projects.js';
import { loggedIn, startTestServer } from './helpers.js';

const states = (project) => project.steps.map((s) => s.state);

describe('projectProgress', () => {
  test('matches the spec example: 4 steps, 1 done, current half ticked → 37%', () => {
    const steps = [
      { state: 'done' },
      { state: 'current', itemsDone: 2, itemsTotal: 4 },
      { state: 'locked', itemsDone: 0, itemsTotal: 0 },
      { state: 'locked', itemsDone: 0, itemsTotal: 3 },
    ];
    assert.equal(projectProgress(steps), 37);
  });

  test('no steps is 0%, and it only reaches 100% when every step is done', () => {
    assert.equal(projectProgress([]), 0);
    const almost = [...Array(299)].map(() => ({ state: 'done' }));
    almost.push({ state: 'current', itemsDone: 9, itemsTotal: 10 });
    assert.equal(projectProgress(almost), 99);
  });
});

describe('projects API', () => {
  let t, api, other;

  before(async () => {
    t = await startTestServer();
    api = await loggedIn(t, 'peter@example.test');
    other = await loggedIn(t, 'miles@example.test');
  });
  after(() => t.close());

  let project;
  beforeEach(async () => {
    const res = await api('POST', '/api/projects', {
      title: 'Planner app',
      steps: [
        { title: 'Design' },
        { title: 'Backend', items: ['Login', 'Schema', 'Goals', 'Daily'] },
        { title: 'Frontend' },
        { title: 'Deploy', items: ['Server', 'HTTPS', 'Backups'] },
      ],
    });
    assert.equal(res.status, 201);
    project = res.body;
  });

  const path = (suffix = '') => `/api/projects/${project.id}${suffix}`;
  const step = (i) => project.steps[i];

  test('a new project opens only its first step', () => {
    assert.deepEqual(states(project), ['current', 'locked', 'locked', 'locked']);
    assert.equal(project.progress, 0);
    assert.equal(project.currentStepId, step(0).id);
    assert.deepEqual(step(1).items.map((i) => i.title), ['Login', 'Schema', 'Goals', 'Daily']);
  });

  test('finishing the current step opens the next, and progress follows the checklist', async () => {
    let res = await api('POST', path(`/steps/${step(0).id}/finish`));
    assert.equal(res.status, 200);
    assert.deepEqual(states(res.body), ['done', 'current', 'locked', 'locked']);
    assert.equal(res.body.progress, 25);

    const [login, schema] = step(1).items;
    await api('PATCH', path(`/steps/${step(1).id}/items/${login.id}`), { done: true });
    res = await api('PATCH', path(`/steps/${step(1).id}/items/${schema.id}`), { done: true });
    assert.equal(res.body.progress, 37);
    assert.equal(res.body.steps[1].itemsDone, 2);

    res = await api('PATCH', path(`/steps/${step(1).id}/items/${schema.id}`), { done: false });
    assert.equal(res.body.steps[1].itemsDone, 1);
  });

  test('locked steps cannot be finished or ticked', async () => {
    let res = await api('POST', path(`/steps/${step(2).id}/finish`));
    assert.equal(res.status, 409);
    assert.match(res.body.error, /earlier steps/);

    res = await api('PATCH', path(`/steps/${step(3).id}/items/${step(3).items[0].id}`), { done: true });
    assert.equal(res.status, 409);

    // Planning ahead is fine: a locked step's checklist can still be added to and renamed.
    res = await api('POST', path(`/steps/${step(3).id}/items`), { title: 'Domain' });
    assert.equal(res.status, 201);
    res = await api('PATCH', path(`/steps/${step(3).id}/items/${step(3).items[0].id}`), { title: 'EC2' });
    assert.equal(res.body.steps[3].items[0].title, 'EC2');
  });

  test('finishing a step ticks the rest of its checklist', async () => {
    await api('POST', path(`/steps/${step(0).id}/finish`));
    const res = await api('POST', path(`/steps/${step(1).id}/finish`));
    assert.equal(res.body.steps[1].itemsDone, 4);
    assert.equal(res.body.progress, 50);
  });

  test("a finished step's checklist is frozen until it is reopened", async () => {
    await api('POST', path(`/steps/${step(0).id}/finish`));
    await api('POST', path(`/steps/${step(1).id}/finish`));
    const item = step(1).items[0];
    assert.equal((await api('PATCH', path(`/steps/${step(1).id}/items/${item.id}`), { done: false })).status, 409);
    assert.equal((await api('POST', path(`/steps/${step(1).id}/items`), { title: 'More' })).status, 409);
    assert.equal((await api('DELETE', path(`/steps/${step(1).id}/items/${item.id}`))).status, 409);
  });

  test('only the last finished step can be reopened', async () => {
    await api('POST', path(`/steps/${step(0).id}/finish`));
    await api('POST', path(`/steps/${step(1).id}/finish`));

    let res = await api('POST', path(`/steps/${step(0).id}/reopen`));
    assert.equal(res.status, 409);
    res = await api('POST', path(`/steps/${step(2).id}/reopen`));
    assert.equal(res.status, 409);

    res = await api('POST', path(`/steps/${step(1).id}/reopen`));
    assert.equal(res.status, 200);
    assert.deepEqual(states(res.body), ['done', 'current', 'locked', 'locked']);
  });

  test('all steps finished → 100% and done', async () => {
    let res;
    for (const s of project.steps) res = await api('POST', path(`/steps/${s.id}/finish`));
    assert.equal(res.body.progress, 100);
    assert.equal(res.body.done, true);
    assert.equal(res.body.currentStepId, null);
    assert.equal((await api('POST', path(`/steps/${step(3).id}/finish`))).status, 409);
  });

  test('steps can be added at the end or before an unfinished step, never before a finished one', async () => {
    await api('POST', path(`/steps/${step(0).id}/finish`));

    let res = await api('POST', path('/steps'), { title: 'Test', items: ['E2E'] });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.steps.map((s) => s.title), ['Design', 'Backend', 'Frontend', 'Deploy', 'Test']);

    res = await api('POST', path('/steps'), { title: 'API design', beforeStepId: step(1).id });
    assert.deepEqual(res.body.steps.map((s) => s.title), ['Design', 'API design', 'Backend', 'Frontend', 'Deploy', 'Test']);
    assert.deepEqual(states(res.body).slice(0, 3), ['done', 'current', 'locked']);

    res = await api('POST', path('/steps'), { title: 'Nope', beforeStepId: step(0).id });
    assert.equal(res.status, 409);

    res = await api('POST', path('/steps'), { title: 'Nope', beforeStepId: 999999 });
    assert.equal(res.status, 400);
  });

  test('unfinished steps can be reordered; finished ones stay first', async () => {
    await api('POST', path(`/steps/${step(0).id}/finish`));
    const stepIds = [step(3).id, step(1).id, step(2).id];
    let res = await api('PUT', path('/steps/order'), { stepIds });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.steps.map((s) => s.title), ['Design', 'Deploy', 'Backend', 'Frontend']);
    assert.equal(res.body.steps[1].state, 'current');

    res = await api('PUT', path('/steps/order'), { stepIds: [step(0).id, ...stepIds] });
    assert.equal(res.status, 400);
    res = await api('PUT', path('/steps/order'), { stepIds: stepIds.slice(1) });
    assert.equal(res.status, 400);
  });

  test('unfinished steps can be renamed and deleted; finished ones cannot be deleted', async () => {
    await api('POST', path(`/steps/${step(0).id}/finish`));
    assert.equal((await api('DELETE', path(`/steps/${step(0).id}`))).status, 409);

    let res = await api('DELETE', path(`/steps/${step(1).id}`));
    assert.deepEqual(res.body.steps.map((s) => s.title), ['Design', 'Frontend', 'Deploy']);
    assert.equal(res.body.steps[1].state, 'current');

    res = await api('PATCH', path(`/steps/${step(2).id}`), { title: 'UI' });
    assert.equal(res.body.steps[1].title, 'UI');
  });

  test('the list shows progress and the current step', async () => {
    await api('POST', path(`/steps/${step(0).id}/finish`));
    const res = await api('GET', '/api/projects');
    const summary = res.body.projects.find((p) => p.id === project.id);
    assert.deepEqual(summary.currentStep, { id: step(1).id, title: 'Backend', itemsDone: 0, itemsTotal: 4 });
    assert.equal(summary.progress, 25);
    assert.equal(summary.stepsDone, 1);
    assert.equal(summary.stepsTotal, 4);
  });

  test('rename and delete a project', async () => {
    let res = await api('PATCH', path(), { title: '  Planner v2  ' });
    assert.equal(res.body.title, 'Planner v2');
    res = await api('DELETE', path());
    assert.equal(res.status, 204);
    assert.equal((await api('GET', path())).status, 404);
  });

  test("another user can't see or change the project", async () => {
    assert.equal((await other('GET', path())).status, 404);
    assert.equal((await other('PATCH', path(), { title: 'Mine now' })).status, 404);
    assert.equal((await other('POST', path(`/steps/${step(0).id}/finish`))).status, 404);
    assert.equal((await other('DELETE', path())).status, 404);
    assert.ok((await other('GET', '/api/projects')).body.projects.every((p) => p.id !== project.id));
  });

  test('a step id from another project is a 404', async () => {
    const second = (await api('POST', '/api/projects', { title: 'Other', steps: [{ title: 'Only' }] })).body;
    const res = await api('POST', path(`/steps/${second.steps[0].id}/finish`));
    assert.equal(res.status, 404);
  });

  test('bad input is rejected', async () => {
    assert.equal((await api('POST', '/api/projects', { title: '   ' })).status, 400);
    assert.equal((await api('POST', '/api/projects', { title: 'x'.repeat(201) })).status, 400);
    assert.equal((await api('POST', '/api/projects', { title: 'X', steps: [{ items: ['a'] }] })).status, 400);
    assert.equal((await api('POST', '/api/projects', { title: 'X', steps: 'Design' })).status, 400);
    assert.equal((await api('PATCH', path(`/steps/${step(0).id}/items/${step(1).items[0].id}`), { done: true })).status, 404);
    assert.equal((await api('PATCH', path(`/steps/${step(1).id}/items/${step(1).items[0].id}`), {})).status, 400);
    assert.equal((await api('GET', '/api/projects/abc')).status, 404);
    assert.equal((await api('GET', '/api/projects/0')).status, 404);
  });

  test('a project with no steps is allowed and is not "done"', async () => {
    const res = await api('POST', '/api/projects', { title: 'Someday' });
    assert.equal(res.status, 201);
    assert.equal(res.body.progress, 0);
    assert.equal(res.body.done, false);
  });

  test('login is required', async () => {
    assert.equal((await t.request('/api/projects')).status, 401);
  });
});

describe('templates API', () => {
  let t, api, other;

  before(async () => {
    t = await startTestServer();
    api = await loggedIn(t, 'gwen@example.test');
    other = await loggedIn(t, 'may@example.test');
  });
  after(() => t.close());

  test('save a template, then start a project from it', async () => {
    let res = await api('POST', '/api/templates', {
      name: 'Web project',
      steps: [{ title: 'Design', items: ['Wireframes'] }, { title: 'Build' }],
    });
    assert.equal(res.status, 201);
    const template = res.body;
    assert.deepEqual(template.steps, [
      { title: 'Design', items: ['Wireframes'] },
      { title: 'Build', items: [] },
    ]);

    res = await api('GET', '/api/templates');
    assert.deepEqual(res.body.templates, [{ id: template.id, name: 'Web project', stepsTotal: 2 }]);

    res = await api('POST', '/api/projects', { title: 'Portfolio', templateId: template.id });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.steps.map((s) => s.title), ['Design', 'Build']);
    assert.deepEqual(res.body.steps[0].items.map((i) => i.title), ['Wireframes']);
  });

  test("copy an existing project's steps into a template", async () => {
    const project = (
      await api('POST', '/api/projects', { title: 'App', steps: [{ title: 'Backend', items: ['API'] }, { title: 'Frontend' }] })
    ).body;
    await api('POST', `/api/projects/${project.id}/steps/${project.steps[0].id}/finish`);

    const res = await api('POST', '/api/templates', { name: 'App template', fromProjectId: project.id });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.steps, [
      { title: 'Backend', items: ['API'] },
      { title: 'Frontend', items: [] },
    ]);
  });

  test('bad template requests', async () => {
    assert.equal((await api('POST', '/api/templates', { name: 'Empty', steps: [] })).status, 400);
    assert.equal((await api('POST', '/api/templates', { name: 'Neither' })).status, 400);
    assert.equal((await api('POST', '/api/templates', { steps: [{ title: 'A' }] })).status, 400);
    const res = await api('POST', '/api/projects', { title: 'X', steps: [], templateId: 1 });
    assert.equal(res.status, 400);
  });

  test("another user's template can't be used, read or deleted", async () => {
    const template = (await api('POST', '/api/templates', { name: 'Private', steps: [{ title: 'A' }] })).body;
    assert.equal((await other('GET', `/api/templates/${template.id}`)).status, 404);
    assert.equal((await other('POST', '/api/projects', { title: 'X', templateId: template.id })).status, 404);
    assert.equal((await other('DELETE', `/api/templates/${template.id}`)).status, 404);
    assert.equal((await api('DELETE', `/api/templates/${template.id}`)).status, 204);
    assert.equal((await api('GET', `/api/templates/${template.id}`)).status, 404);
  });
});
