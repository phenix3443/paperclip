export function isolatedCommand({ env, source, command, args, uid, gid, seconds }) {
  return ['timeout', '--signal=TERM', '--kill-after=5s', `${seconds}s`,
    'unshare', '--pid', '--fork', '--kill-child=KILL', '--mount', '--mount-proc', '--net', '--',
    '/bin/bash', '-euc', 'mount --make-rprivate /; mount --bind "$1" /tmp; shift; ip link set lo up; exec "$@"', '--', env.TMPDIR,
    'setpriv', `--reuid=${uid}`, `--regid=${gid}`, '--init-groups', '/usr/bin/env', '-i',
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`), command, ...args];
}
