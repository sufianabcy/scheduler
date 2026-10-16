import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { badRequest } from '../http.js';
import { createProjects } from '../projects.js';
import { createTemplates } from '../templates.js';
import * as v from '../validate.js';

/** { title, items?: [title] } from a request body. */
export function stepInput(value, field) {
  if (typeof value !== 'object' || value === null) throw badRequest(`${field} must be an object`);
  return { title: v.title(value.title, `${field}.title`), items: v.list(value.items, `${field}.items`, v.title) };
}

export function projectRoutes({ db }) {
  const projects = createProjects(db);
  const templates = createTemplates(db);
  const router = Router();
  router.use(requireAuth);

  const ids = (req) => ({
    projectId: v.pathId(req.params.id),
    stepId: req.params.stepId === undefined ? undefined : v.pathId(req.params.stepId),
    itemId: req.params.itemId === undefined ? undefined : v.pathId(req.params.itemId),
  });
  const body = (req) => req.body ?? {};

  router.get('/', (req, res) => {
    res.json({ projects: projects.list(req.user.id) });
  });

  // Body: { title, steps?: [{ title, items? }] } or { title, templateId }.
  router.post('/', (req, res) => {
    const { title, steps, templateId } = body(req);
    if (steps !== undefined && templateId !== undefined) throw badRequest('Send steps or templateId, not both');
    const stepInputs =
      templateId !== undefined
        ? templates.detail(req.user.id, v.optionalId(templateId, 'templateId')).steps
        : v.list(steps, 'steps', stepInput);
    res.status(201).json(projects.create(req.user.id, v.title(title), stepInputs));
  });

  router.get('/:id', (req, res) => {
    res.json(projects.detail(req.user.id, ids(req).projectId));
  });

  router.patch('/:id', (req, res) => {
    res.json(projects.rename(req.user.id, ids(req).projectId, v.title(body(req).title)));
  });

  router.delete('/:id', (req, res) => {
    projects.remove(req.user.id, ids(req).projectId);
    res.status(204).end();
  });

  // Body: { title, items?, beforeStepId? }. Without beforeStepId the step goes last.
  router.post('/:id/steps', (req, res) => {
    const b = body(req);
    const step = stepInput(b, 'step');
    const before = v.optionalId(b.beforeStepId, 'beforeStepId');
    res.status(201).json(projects.addStep(req.user.id, ids(req).projectId, step, before));
  });

  // Body: { stepIds: [...] } — the new order of all unfinished steps.
  router.put('/:id/steps/order', (req, res) => {
    const stepIds = v.idList(body(req).stepIds, 'stepIds');
    res.json(projects.reorderSteps(req.user.id, ids(req).projectId, stepIds));
  });

  router.patch('/:id/steps/:stepId', (req, res) => {
    const { projectId, stepId } = ids(req);
    res.json(projects.renameStep(req.user.id, projectId, stepId, v.title(body(req).title)));
  });

  router.delete('/:id/steps/:stepId', (req, res) => {
    const { projectId, stepId } = ids(req);
    res.json(projects.removeStep(req.user.id, projectId, stepId));
  });

  router.post('/:id/steps/:stepId/finish', (req, res) => {
    const { projectId, stepId } = ids(req);
    res.json(projects.finishStep(req.user.id, projectId, stepId));
  });

  router.post('/:id/steps/:stepId/reopen', (req, res) => {
    const { projectId, stepId } = ids(req);
    res.json(projects.reopenStep(req.user.id, projectId, stepId));
  });

  router.post('/:id/steps/:stepId/items', (req, res) => {
    const { projectId, stepId } = ids(req);
    res.status(201).json(projects.addItem(req.user.id, projectId, stepId, v.title(body(req).title)));
  });

  // Body: { title?, done? }
  router.patch('/:id/steps/:stepId/items/:itemId', (req, res) => {
    const { projectId, stepId, itemId } = ids(req);
    const b = body(req);
    if (b.title === undefined && b.done === undefined) throw badRequest('Send title or done');
    const changes = {
      title: b.title === undefined ? undefined : v.title(b.title),
      done: b.done === undefined ? undefined : v.boolean(b.done, 'done'),
    };
    res.json(projects.updateItem(req.user.id, projectId, stepId, itemId, changes));
  });

  router.delete('/:id/steps/:stepId/items/:itemId', (req, res) => {
    const { projectId, stepId, itemId } = ids(req);
    res.json(projects.removeItem(req.user.id, projectId, stepId, itemId));
  });

  return router;
}
