import { transaction } from './db.js';
import { conflict, notFound } from './http.js';
import { orderedList } from './orderedList.js';

/**
 * Progress: every step is an equal share. A finished step counts fully; the current step counts the part of its
 * checklist that's ticked; locked steps count nothing. Rounded down, so 100% only shows when everything is done.
 */
export function projectProgress(steps) {
  if (steps.length === 0) return 0;
  const units = steps.reduce((sum, s) => {
    if (s.state === 'done') return sum + 1;
    if (s.state === 'current' && s.itemsTotal > 0) return sum + s.itemsDone / s.itemsTotal;
    return sum;
  }, 0);
  return Math.floor((units / steps.length) * 100);
}

/** Projects (general goals): ordered steps, each with an optional checklist. Every method checks ownership. */
export function createProjects(db) {
  const steps = orderedList(db, { table: 'project_steps', parentCol: 'project_id', noun: 'step' });

  const q = {
    owned: db.prepare('SELECT id, title, created_at FROM projects WHERE id = ? AND user_id = ?'),
    ofUser: db.prepare('SELECT id FROM projects WHERE user_id = ? ORDER BY position, id'),
    insert: db.prepare(`
      INSERT INTO projects (user_id, title, position)
      VALUES (?, ?, (SELECT coalesce(max(position), -1) + 1 FROM projects WHERE user_id = ?))`),
    rename: db.prepare('UPDATE projects SET title = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM projects WHERE id = ?'),

    insertStep: db.prepare('INSERT INTO project_steps (project_id, title, position) VALUES (?, ?, ?)'),
    renameStep: db.prepare('UPDATE project_steps SET title = ? WHERE id = ?'),

    items: db.prepare(`
      SELECT i.id, i.step_id, i.title, i.done_at
      FROM step_items i JOIN project_steps s ON s.id = i.step_id
      WHERE s.project_id = ?
      ORDER BY i.position, i.id`),
    item: db.prepare('SELECT id FROM step_items WHERE id = ? AND step_id = ?'),
    insertItem: db.prepare(`
      INSERT INTO step_items (step_id, title, position)
      VALUES (?, ?, (SELECT coalesce(max(position), -1) + 1 FROM step_items WHERE step_id = ?))`),
    renameItem: db.prepare('UPDATE step_items SET title = ? WHERE id = ?'),
    tickItem: db.prepare("UPDATE step_items SET done_at = coalesce(done_at, datetime('now')) WHERE id = ?"),
    untickItem: db.prepare('UPDATE step_items SET done_at = NULL WHERE id = ?'),
    tickAllItems: db.prepare("UPDATE step_items SET done_at = datetime('now') WHERE step_id = ? AND done_at IS NULL"),
    removeItem: db.prepare('DELETE FROM step_items WHERE id = ?'),
  };

  function owned(userId, projectId) {
    const project = q.owned.get(projectId, userId);
    if (!project) throw notFound('No such project');
    return project;
  }

  function stepOf(userId, projectId, stepId) {
    owned(userId, projectId);
    return steps.find(projectId, stepId);
  }

  function addStepRow(projectId, { title, items }, position) {
    const stepId = Number(q.insertStep.run(projectId, title, position).lastInsertRowid);
    for (const item of items) q.insertItem.run(stepId, item, stepId);
    return stepId;
  }

  function detail(userId, projectId) {
    const project = owned(userId, projectId);
    const items = q.items.all(project.id);
    const stepList = steps.withState(steps.rows(project.id)).map((s) => {
      const own = items
        .filter((i) => i.step_id === s.id)
        .map((i) => ({ id: i.id, title: i.title, done: i.done_at !== null }));
      return {
        id: s.id,
        title: s.title,
        state: s.state,
        doneAt: s.done_at,
        itemsDone: own.filter((i) => i.done).length,
        itemsTotal: own.length,
        items: own,
      };
    });
    const current = stepList.find((s) => s.state === 'current') ?? null;
    return {
      id: project.id,
      title: project.title,
      createdAt: project.created_at,
      progress: projectProgress(stepList),
      done: stepList.length > 0 && current === null,
      stepsDone: stepList.filter((s) => s.state === 'done').length,
      stepsTotal: stepList.length,
      currentStepId: current?.id ?? null,
      steps: stepList,
    };
  }

  /** Runs a change in a transaction and returns the updated project. */
  const change = (userId, projectId, fn) => {
    transaction(db, fn);
    return detail(userId, projectId);
  };

  return {
    detail,

    list(userId) {
      return q.ofUser.all(userId).map(({ id }) => {
        const d = detail(userId, id);
        const current = d.steps.find((s) => s.id === d.currentStepId);
        return {
          id: d.id,
          title: d.title,
          progress: d.progress,
          done: d.done,
          stepsDone: d.stepsDone,
          stepsTotal: d.stepsTotal,
          currentStep: current
            ? { id: current.id, title: current.title, itemsDone: current.itemsDone, itemsTotal: current.itemsTotal }
            : null,
        };
      });
    },

    /** stepInputs: [{ title, items: [title] }] */
    create(userId, title, stepInputs) {
      const projectId = transaction(db, () => {
        const id = Number(q.insert.run(userId, title, userId).lastInsertRowid);
        stepInputs.forEach((step, i) => addStepRow(id, step, i));
        return id;
      });
      return detail(userId, projectId);
    },

    rename(userId, projectId, title) {
      owned(userId, projectId);
      return change(userId, projectId, () => q.rename.run(title, projectId));
    },

    remove(userId, projectId) {
      owned(userId, projectId);
      q.remove.run(projectId);
    },

    addStep(userId, projectId, step, beforeStepId) {
      owned(userId, projectId);
      return change(userId, projectId, () => {
        const stepId = addStepRow(projectId, step, Number.MAX_SAFE_INTEGER);
        steps.place(projectId, stepId, beforeStepId);
      });
    },

    renameStep(userId, projectId, stepId, title) {
      stepOf(userId, projectId, stepId);
      return change(userId, projectId, () => q.renameStep.run(title, stepId));
    },

    removeStep(userId, projectId, stepId) {
      owned(userId, projectId);
      return change(userId, projectId, () => steps.remove(projectId, stepId));
    },

    reorderSteps(userId, projectId, stepIds) {
      owned(userId, projectId);
      return change(userId, projectId, () => steps.reorder(projectId, stepIds));
    },

    /** Finishing a step also ticks whatever is left on its checklist, and opens the next step. */
    finishStep(userId, projectId, stepId) {
      owned(userId, projectId);
      return change(userId, projectId, () => {
        steps.finish(projectId, stepId);
        q.tickAllItems.run(stepId);
      });
    },

    reopenStep(userId, projectId, stepId) {
      owned(userId, projectId);
      return change(userId, projectId, () => steps.reopen(projectId, stepId));
    },

    addItem(userId, projectId, stepId, title) {
      const step = stepOf(userId, projectId, stepId);
      if (step.state === 'done') throw conflict('This step is finished; reopen it to change its checklist');
      return change(userId, projectId, () => q.insertItem.run(stepId, title, stepId));
    },

    /** changes: { title?, done? }. Items can only be ticked on the current step. */
    updateItem(userId, projectId, stepId, itemId, { title, done }) {
      const step = stepOf(userId, projectId, stepId);
      if (!q.item.get(itemId, stepId)) throw notFound('No such checklist item');
      if (step.state === 'done') throw conflict('This step is finished; reopen it to change its checklist');
      if (done !== undefined && step.state === 'locked') throw conflict('Finish the earlier steps first');
      return change(userId, projectId, () => {
        if (title !== undefined) q.renameItem.run(title, itemId);
        if (done === true) q.tickItem.run(itemId);
        if (done === false) q.untickItem.run(itemId);
      });
    },

    removeItem(userId, projectId, stepId, itemId) {
      const step = stepOf(userId, projectId, stepId);
      if (!q.item.get(itemId, stepId)) throw notFound('No such checklist item');
      if (step.state === 'done') throw conflict('This step is finished; reopen it to change its checklist');
      return change(userId, projectId, () => q.removeItem.run(itemId));
    },
  };
}
