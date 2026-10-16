import { badRequest, conflict, notFound } from './http.js';

/**
 * Rules for a list that must be done in order: project steps and monthly-goal tasks.
 *
 * Finished rows always come first. The first unfinished row is "current" (the only one you can finish);
 * the rest are "locked". Every change below keeps that true:
 * - only the current row can be finished, and only the last finished row can be reopened
 * - new rows go after all finished rows
 * - only unfinished rows can be reordered or deleted
 *
 * The table needs id, title, position, done_at and a parent column. Callers check the parent belongs to the user
 * and wrap changes in a transaction.
 */
export function orderedList(db, { table, parentCol, noun }) {
  const q = {
    all: db.prepare(`SELECT * FROM ${table} WHERE ${parentCol} = ? ORDER BY position, id`),
    setPosition: db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`),
    finish: db.prepare(`UPDATE ${table} SET done_at = datetime('now') WHERE id = ?`),
    unfinish: db.prepare(`UPDATE ${table} SET done_at = NULL WHERE id = ?`),
    remove: db.prepare(`DELETE FROM ${table} WHERE id = ?`),
  };

  const rows = (parentId) => q.all.all(parentId);
  const writeOrder = (ids) => ids.forEach((id, i) => q.setPosition.run(i, id));

  function withState(list) {
    let currentSeen = false;
    return list.map((row) => {
      if (row.done_at) return { ...row, state: 'done' };
      const state = currentSeen ? 'locked' : 'current';
      currentSeen = true;
      return { ...row, state };
    });
  }

  function find(parentId, id) {
    const row = withState(rows(parentId)).find((r) => r.id === id);
    if (!row) throw notFound(`No such ${noun}`);
    return row;
  }

  return {
    rows,
    withState,
    find,

    /** Moves a just-inserted row before `beforeId` (an unfinished row), or to the end when beforeId is null. */
    place(parentId, newId, beforeId) {
      const others = rows(parentId).filter((r) => r.id !== newId);
      let index = others.length;
      if (beforeId !== null) {
        index = others.findIndex((r) => r.id === beforeId);
        if (index === -1) throw badRequest(`No such ${noun} to insert before`);
        if (others[index].done_at) throw conflict(`New ${noun}s can't go before a finished ${noun}`);
      }
      const ids = others.map((r) => r.id);
      ids.splice(index, 0, newId);
      writeOrder(ids);
    },

    /** `ids` is the new order of every unfinished row; finished rows stay in front. */
    reorder(parentId, ids) {
      const all = rows(parentId);
      const done = all.filter((r) => r.done_at).map((r) => r.id);
      const open = all.filter((r) => !r.done_at).map((r) => r.id);
      if (ids.length !== open.length || !open.every((id) => ids.includes(id))) {
        throw badRequest(`Send the ids of all unfinished ${noun}s, and only those`);
      }
      writeOrder([...done, ...ids]);
    },

    finish(parentId, id) {
      const row = find(parentId, id);
      if (row.state === 'done') throw conflict(`This ${noun} is already finished`);
      if (row.state === 'locked') throw conflict(`Finish the earlier ${noun}s first`);
      q.finish.run(id);
    },

    reopen(parentId, id) {
      const row = find(parentId, id);
      if (row.state !== 'done') throw conflict(`This ${noun} isn't finished`);
      const lastDone = rows(parentId).filter((r) => r.done_at).at(-1);
      if (lastDone.id !== id) throw conflict(`Only the last finished ${noun} can be reopened`);
      q.unfinish.run(id);
    },

    remove(parentId, id) {
      const row = find(parentId, id);
      if (row.state === 'done') throw conflict(`A finished ${noun} can't be deleted; reopen it first`);
      q.remove.run(id);
      writeOrder(rows(parentId).map((r) => r.id));
    },
  };
}
