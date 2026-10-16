import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { badRequest } from '../http.js';
import { createProjects } from '../projects.js';
import { createTemplates } from '../templates.js';
import * as v from '../validate.js';
import { stepInput } from './projects.js';

export function templateRoutes({ db }) {
  const templates = createTemplates(db);
  const projects = createProjects(db);
  const router = Router();
  router.use(requireAuth);

  router.get('/', (req, res) => {
    res.json({ templates: templates.list(req.user.id) });
  });

  // Body: { name, steps: [{ title, items? }] } or { name, fromProjectId } to copy a project's steps and checklists.
  router.post('/', (req, res) => {
    const { name, steps, fromProjectId } = req.body ?? {};
    if ((steps === undefined) === (fromProjectId === undefined)) {
      throw badRequest('Send either steps or fromProjectId');
    }
    const stepInputs =
      fromProjectId !== undefined
        ? projects
            .detail(req.user.id, v.optionalId(fromProjectId, 'fromProjectId'))
            .steps.map((s) => ({ title: s.title, items: s.items.map((i) => i.title) }))
        : v.list(steps, 'steps', stepInput);
    if (stepInputs.length === 0) throw badRequest('A template needs at least one step');
    res.status(201).json(templates.create(req.user.id, v.title(name, 'name'), stepInputs));
  });

  router.get('/:id', (req, res) => {
    res.json(templates.detail(req.user.id, v.pathId(req.params.id)));
  });

  router.delete('/:id', (req, res) => {
    templates.remove(req.user.id, v.pathId(req.params.id));
    res.status(204).end();
  });

  return router;
}
