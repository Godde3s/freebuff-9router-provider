#!/usr/bin/env node
// fb9r — Freebuff provider for 9router.
//
//   fb9r login            log in once with the official browser flow
//   fb9r serve [--port N] run the local OpenAI-compatible provider
//   fb9r status           show login + session state
//   fb9r models           list available models
//   fb9r whoami           print the connected account
//   fb9r logout           clear local credentials
//   fb9r import           import the token from the official CLI credentials

import { login, logout } from '../src/login.js';
import { loadCredentials, importFromOfficialCli, clearCredentials } from '../src/credentials.js';
import { fetchMe, FreebuffSession } from '../src/session.js';
import { createServer } from '../src/server.js';
import { MODELS, DEFAULT_MODEL } from '../src/constants.js';

const HELP = `
fb9r — Freebuff provider for 9router

USAGE
  fb9r login                 Log in once with the official browser flow
  fb9r serve [options]       Run the local OpenAI-compatible provider
  fb9r status                Show login + session state
  fb9r models                List available models
  fb9r whoami                Print the connected account
  fb9r logout                Clear local credentials (logs out upstream, best effort)
  fb9r import                Import token from the official Freebuff CLI credentials
  fb9r help                  This help

SERVE OPTIONS
  --port <n>                 Port to listen on (default 8787, env FB9R_PORT)
  --host <addr>              Bind address (default 127.0.0.1)
  --api-key <key>            Require this key on chat calls (env FB9R_API_KEY)

ENV
  FB9R_CONFIG_DIR            Config directory (default ~/.config/freebuff-9router)
  FB9R_LOGIN_BASE            Login origin   (default https://freebuff.com)
  FB9R_API_BASE              API origin     (default https://codebuff.com)

Then add it in 9router:  Add Provider -> OpenAI Compatible
  Base URL: http://127.0.0.1:8787/v1    API key: anything (or your --api-key)
`;

function argValue(args, flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  switch (cmd || 'help') {
    case 'login': {
      const cred = await login({ onPending: (p) => { if (p?.waiting) process.stdout.write('.'); } });
      console.log(`\n\n  Logged in as ${cred.name || cred.email || cred.id || 'unknown'} <${cred.email || 'n/a'}>`);
      console.log('  Now run:  fb9r serve\n');
      break;
    }

    case 'import': {
      const cred = importFromOfficialCli();
      if (!cred) {
        console.error('  No official CLI credentials found at ~/.config/manicode/credentials.json (or they had no token). Use `fb9r login`.');
        process.exit(1);
      }
      console.log(`  Imported: ${cred.email || cred.name || cred.id}`);
      break;
    }

    case 'models': {
      console.log('\n  Upstream id                     Label               Alias(es)');
      for (const m of MODELS) {
        const id = m.id.padEnd(32);
        const label = m.label.padEnd(18);
        console.log(`  ${id} ${label} ${m.aliases.join(', ')}${m.unmetered ? '   [unmetered]' : ''}`);
      }
      console.log(`\n  default: ${DEFAULT_MODEL}\n`);
      break;
    }

    case 'status':
    case 'whoami': {
      const cred = loadCredentials();
      if (!cred) {
        console.log('  Not logged in. Run `fb9r login` (or `fb9r import`).');
        process.exit(2);
      }
      const me = await fetchMe(cred.authToken);
      console.log(`  account : ${cred.email || cred.name || cred.id || 'unknown'}`);
      console.log(`  id      : ${me?.id || cred.id || '?'}`);
      console.log(`  token   : ${me ? 'valid (upstream accepts it)' : 'present (upstream check failed)'}`);
      break;
    }

    case 'logout': {
      const ok = await logout();
      console.log(ok ? '  Logged out.' : '  No credentials to clear.');
      break;
    }

    case 'serve': {
      const args = rest;
      const port = Number(argValue(args, '--port', process.env.FB9R_PORT || 8787));
      const host = argValue(args, '--host', '127.0.0.1');
      const apiKey = argValue(args, '--api-key', process.env.FB9R_API_KEY || null);

      const cred = loadCredentials();
      if (!cred) {
        console.error('  Not logged in. Run `fb9r login` first.');
        process.exit(2);
      }

      const { server, session } = createServer({ port, host, apiKey });
      let closing = false;
      const release = async () => {
        if (closing) return;
        closing = true;
        try {
          await session.stop(); // DELETE the free seat upstream
        } catch { /* best effort */ }
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
      };
      process.on('SIGINT', release);
      process.on('SIGTERM', release);

      server.listen(port, host, () => {
        console.log(`
  freebuff-9router-provider listening on http://${host}:${port}

  9router  ->  Add Provider -> OpenAI Compatible
             Base URL : http://${host}:${port}/v1
             API key  : ${apiKey ? '(your --api-key)' : 'anything (no local gate set)'}

  models   : ${MODELS.map((m) => m.id).join(', ')}
  account  : ${cred.email || cred.name || cred.id}

  Ctrl+C stops the server and releases your free session seat.
`);
      });
      break;
    }

    case 'help':
    case '--help':
    case '-h':
    default:
      console.log(HELP);
      break;
  }
}

main().catch((err) => {
  console.error('  error:', err?.message || err);
  process.exit(1);
});
