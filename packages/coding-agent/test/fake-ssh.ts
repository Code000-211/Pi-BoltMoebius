import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** An ssh that runs the remote command on this machine: options and the host are skipped, `-O exit` does nothing. */
export function writeFakeSsh(dir: string): string {
	const path = join(dir, "fake-ssh");
	writeFileSync(
		path,
		'#!/bin/bash\nwhile [ $# -gt 0 ]; do case "$1" in -o|-O|-p|-i) shift 2;; --) shift; break;; -*) shift;; *) shift;; esac; done\n[ $# -eq 0 ] && exit 0\nexec sh -c "$1"\n',
	);
	chmodSync(path, 0o755);
	return path;
}

/**
 * Like {@link writeFakeSsh}, but asks for a passphrase through SSH_ASKPASS until `secret` is given once (the master
 * connection then stands, as with ssh's ControlMaster). Counts the questions in `asked`.
 */
export function writeFakeSshAskingPassphrase(dir: string, secret: string): string {
	const path = join(dir, "fake-ssh-askpass");
	const master = join(dir, "master");
	const asked = join(dir, "asked");
	writeFileSync(
		path,
		`#!/bin/bash\nwhile [ $# -gt 0 ]; do case "$1" in -o|-O|-p|-i) shift 2;; --) shift; break;; -*) shift;; *) shift;; esac; done\n[ $# -eq 0 ] && exit 0\nif [ ! -e '${master}' ]; then\n  [ -n "$SSH_ASKPASS" ] || { echo "Permission denied (publickey)." >&2; exit 255; }\n  echo x >> '${asked}'\n  answer=$("$SSH_ASKPASS" "Enter passphrase for key '/k':") || { echo "Permission denied (publickey)." >&2; exit 255; }\n  [ "$answer" = '${secret}' ] || { echo "Permission denied (publickey)." >&2; exit 255; }\n  touch '${master}'\nfi\nexec sh -c "$1"\n`,
	);
	chmodSync(path, 0o755);
	return path;
}
