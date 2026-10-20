import { Router } from 'express';
import { requireAdmin } from '../auth/middleware.js';
import { badRequest, conflict } from '../http.js';
import { createUser, findUserByEmail, listUsers, normalizeEmail, validateCredentials } from '../users.js';

const userJson = (u) => ({ id: u.id, email: u.email, createdAt: u.created_at, isAdmin: u.is_admin === 1 });

/** Admin only: see the login accounts and create new ones. Making admins stays on the command line. */
export function adminRoutes({ db }) {
  const router = Router();
  router.use(requireAdmin);

  router.get('/users', (req, res) => {
    res.json({ users: listUsers(db).map(userJson) });
  });

  // Body: { email, password }. The admin passes the password on; the new user can change it in More → Password.
  router.post('/users', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (email.length > 254) throw badRequest('That email is too long');
    if (typeof password === 'string' && password.length > 200) throw badRequest('Password must be at most 200 characters');
    const problem = validateCredentials(email, password);
    if (problem) throw badRequest(problem);
    if (findUserByEmail(db, email)) throw conflict(`There is already an account for ${email}`);
    const user = await createUser(db, email, password);
    console.log(`User ${user.id} created by admin ${req.user.id}`);
    res.status(201).json({ user: userJson(listUsers(db).find((u) => u.id === user.id)) });
  });

  return router;
}
