// Boot file for the forge entry.
//
// The harness runs this process next to its grading env and the two talk over
// HTTP: my server has to come up on a port the kernel picks, the env has to be
// told which port that was, and the process then has to stay alive until the
// env reports the trial finished. Only then may it exit, with code 0.
//
// Concretely:
//   * The env's origin arrives in MAKEFUN_ENV_URL. With no origin there is
//     nothing to register with, so booting is pointless: complain on stderr
//     and exit 1 immediately.
//   * The server itself is built by createApp() from ./app.ts. I listen on
//     port 0 and read the real port back from server.address(); a fixed port
//     is never an option because the env owns its own.
//   * Registration is a POST of {"port": N} to <env>/register. The env may
//     still be starting, so failures are retried with an exponential backoff.
//     200 means registered; 409 means an earlier registration already won and
//     this one changes nothing, which is also fine. 400 and 405 mean the
//     request itself broke the contract, so those are fatal.
//   * Afterwards I poll GET <env>/done. It answers right away with
//     {"done": false} while the suite runs, so polling (never a held-open
//     request) is the way to wait. The first {"done": true} ends the trial:
//     close the server and exit 0.
//   * Anything fatal along the way prints its message to stderr and exits 1.

import { createApp } from './app.ts';

/** Origin of the grading env, with any trailing slashes removed. */
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envOrigin === '') {
  process.stderr.write('[boot] MAKEFUN_ENV_URL is missing, so there is no env to register with\n');
  process.exit(1);
}

/** One HTTP call to the env may take at most this long before I give up on it. */
const CALL_TIMEOUT_MS = 30_000;
/** Backoff between retries: starts at the floor, doubles, stops at the cap. */
const BACKOFF_FLOOR_MS = 250;
const BACKOFF_CAP_MS = 2_000;

/** An error that retrying cannot fix; catching one ends the process. */
class FatalBootError extends Error {}

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** How long to wait before retry number `failures + 1`. */
function backoffMs(failures: number): number {
  const grown = BACKOFF_FLOOR_MS * 2 ** Math.min(failures, 8);
  return Math.min(BACKOFF_CAP_MS, grown);
}

/**
 * Tell the env which port the server bound, retrying while the env is not
 * ready yet. Returns once the env holds a registration for this trial.
 */
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      // 200: registered. 409: a registration already won; nothing to repair.
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new FatalBootError(`register was refused with HTTP ${reply.status}: ${await reply.text()}`);
      }
      // Any other status is treated as "env not ready" and retried below.
    } catch (err) {
      if (err instanceof FatalBootError) throw err;
      // Network errors and timeouts land here: also retried below.
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

/** Poll the env's /done endpoint until it confirms the trial is over. */
async function waitUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Unreachable or slow env: that is not "done", so keep polling.
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

/** Start the server, register its port, and wait out the trial. */
async function run(): Promise<void> {
  const server = createApp();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });

  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new FatalBootError('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[boot] forge listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[boot] registered with the env; waiting for the trial to end\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[boot] trial over; shutting down\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[boot] ${message}\n`);
  process.exit(1);
}
