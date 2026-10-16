import { MIN_PASSWORD_LENGTH, hashPassword } from './auth/password.js';

// User accounts are only created and changed from the command line (src/cli/users.js); there is no sign-up page.

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
  db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(normalizeEmail(email));

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
  db.prepare('SELECT id, email, created_at FROM users ORDER BY id').all();

/** Deletes the user and, through ON DELETE CASCADE, all of their data. */
export function removeUser(db, email) {
  const { changes } = db.prepare('DELETE FROM users WHERE email = ?').run(normalizeEmail(email));
  if (changes === 0) throw new Error(`No user with email ${normalizeEmail(email)}`);
}
