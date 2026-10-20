-- Admins can create login accounts from the app (More → Users). Nobody is an admin until it's set from the command
-- line on the server: npm run user -- admin <email>
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
