// Manage login accounts. Run from the server folder:
//   npm run user -- add <email>          asks for the password twice
//   npm run user -- passwd <email>       sets a new password and logs that user out everywhere
//   npm run user -- list
//   npm run user -- admin <email>        lets that user create accounts in the app (More → Users)
//   npm run user -- unadmin <email>      takes that away
//   npm run user -- remove <email> --yes deletes the user and ALL of their data
// When stdin is not a terminal, the password is read from its first line instead of being asked for.

import { config } from '../config.js';
import { openDb } from '../db.js';
import { createUser, listUsers, removeUser, setAdmin, setPassword } from '../users.js';

const USAGE = `Usage:
  npm run user -- add <email>
  npm run user -- passwd <email>
  npm run user -- list
  npm run user -- admin <email>
  npm run user -- unadmin <email>
  npm run user -- remove <email> --yes`;

/** Reads a line from the terminal without echoing it. */
function askHidden(prompt) {
  const { stdin, stdout } = process;
  return new Promise((resolve, reject) => {
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let value = '';
    const finish = (err) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      err ? reject(err) : resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Error('Cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPassword() {
  if (!process.stdin.isTTY) {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    return input.split(/\r?\n/)[0];
  }
  const first = await askHidden('Password: ');
  const second = await askHidden('Repeat password: ');
  if (first !== second) throw new Error('The passwords do not match');
  return first;
}

async function main(args) {
  const [command, email] = args;
  const db = openDb(config.dbPath);
  try {
    switch (command) {
      case 'add': {
        if (!email) throw new Error(USAGE);
        const user = await createUser(db, email, await readPassword());
        console.log(`Created user ${user.email}`);
        break;
      }
      case 'passwd': {
        if (!email) throw new Error(USAGE);
        await setPassword(db, email, await readPassword());
        console.log(`Password changed for ${email}; their open sessions were logged out`);
        break;
      }
      case 'list': {
        const users = listUsers(db);
        if (users.length === 0) console.log('No users yet');
        for (const u of users) console.log(`${u.id}\t${u.email}\tcreated ${u.created_at} UTC${u.is_admin ? '\tadmin' : ''}`);
        break;
      }
      case 'admin':
      case 'unadmin': {
        if (!email) throw new Error(USAGE);
        setAdmin(db, email, command === 'admin');
        console.log(command === 'admin' ? `${email} is now an admin` : `${email} is no longer an admin`);
        break;
      }
      case 'remove': {
        if (!email) throw new Error(USAGE);
        if (!args.includes('--yes')) {
          throw new Error(`This deletes ${email} and ALL of their data. Add --yes to confirm.`);
        }
        removeUser(db, email);
        console.log(`Removed ${email}`);
        break;
      }
      default:
        throw new Error(USAGE);
    }
  } finally {
    db.close();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
