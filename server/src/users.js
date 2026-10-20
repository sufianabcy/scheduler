import { MIN_PASSWORD_LENGTH, hashPassword } from './auth/password.js';

// There is no sign-up page: accounts are created from the command line (src/cli/users.js) or by an admin in the app
// (More → Users). Only the command line can make someone an admin. Users change their own password in More.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();

export function validateCredentials(email, password) {
  if (!EMAIL_RE.test(email)) return 'That is not a valid email address';
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

export const findUserByEmail = (db, email) =>
  db.prepare('SELECT id, email, password_hash, is_admin FROM users WHERE email = ?').get(normalizeEmail(email));

export async function createUser(db, email, password) {
  email = normalizeEmail(email);
  const problem = validateCredentials(email, password);
  if (problem) throw new Error(problem);
  if (findUserByEmail(db, email)) throw new Error(`A user with email ${email} already exists`);
  const hash = await hashPassword(password);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(email, hash);
  return { id: Number(lastInsertRowid), email };
}

/** A user changing their own password in the app (More → Password). Logs them out everywhere; the caller starts a
 *  fresh session for the device they did it on. The current password is checked by the caller. */
export async function changeOwnPassword(db, userId, password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Sets a new password and logs the user out everywhere. */
export async function setPassword(db, email, password) {
  email = normalizeEmail(email);
  const problem = validateCredentials(email, password);
  if (problem) throw new Error(problem);
  const user = findUserByEmail(db, email);
  if (!user) throw new Error(`No user with email ${email}`);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
}

export const listUsers = (db) =>
  db.prepare('SELECT id, email, created_at, is_admin FROM users ORDER BY id').all();

/** Gives or takes away admin (command line only). */
export function setAdmin(db, email, isAdmin) {
  const { changes } = db.prepare('UPDATE users SET is_admin = ? WHERE email = ?').run(isAdmin ? 1 : 0, normalizeEmail(email));
  if (changes === 0) throw new Error(`No user with email ${normalizeEmail(email)}`);
}

/** Deletes the user and, through ON DELETE CASCADE, all of their data. */
export function removeUser(db, email) {
  const { changes } = db.prepare('DELETE FROM users WHERE email = ?').run(normalizeEmail(email));
  if (changes === 0) throw new Error(`No user with email ${normalizeEmail(email)}`);
}
