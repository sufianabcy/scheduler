import { transaction } from './db.js';
import { notFound } from './http.js';

/** Reusable step lists for new projects, e.g. Design → Backend → Frontend → Deploy. */
export function createTemplates(db) {
  const q = {
    owned: db.prepare('SELECT id, name FROM templates WHERE id = ? AND user_id = ?'),
    ofUser: db.prepare(`
      SELECT t.id, t.name, count(s.id) AS steps_total
      FROM templates t LEFT JOIN template_steps s ON s.template_id = t.id
      WHERE t.user_id = ?
      GROUP BY t.id
      ORDER BY t.name COLLATE NOCASE, t.id`),
    steps: db.prepare('SELECT title, items FROM template_steps WHERE template_id = ? ORDER BY position, id'),
    insert: db.prepare('INSERT INTO templates (user_id, name) VALUES (?, ?)'),
    insertStep: db.prepare('INSERT INTO template_steps (template_id, title, position, items) VALUES (?, ?, ?, ?)'),
    remove: db.prepare('DELETE FROM templates WHERE id = ?'),
  };

  function detail(userId, templateId) {
    const template = q.owned.get(templateId, userId);
    if (!template) throw notFound('No such template');
    const steps = q.steps.all(template.id).map((s) => ({ title: s.title, items: JSON.parse(s.items) }));
    return { id: template.id, name: template.name, steps };
  }

  return {
    detail,

    list: (userId) => q.ofUser.all(userId).map((t) => ({ id: t.id, name: t.name, stepsTotal: t.steps_total })),

    /** steps: [{ title, items: [title] }] */
    create(userId, name, steps) {
      const id = transaction(db, () => {
        const templateId = Number(q.insert.run(userId, name).lastInsertRowid);
        steps.forEach((s, i) => q.insertStep.run(templateId, s.title, i, JSON.stringify(s.items)));
        return templateId;
      });
      return detail(userId, id);
    },

    remove(userId, templateId) {
      detail(userId, templateId);
      q.remove.run(templateId);
    },
  };
}
