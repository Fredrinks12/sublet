import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { newKeyPair, publicKeyLine, sshArgs } from '../src/ssh.js';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sublet-test-'));

test('real ssh-keygen can read a key we generated', () => {
  const dir = temp();
  const key = newKeyPair(dir, 'test-comment');
  const read = spawnSync('ssh-keygen', ['-y', '-f', key.keyPath], { encoding: 'utf8' });
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout.trim().split(' ').slice(0, 2).join(' '), key.publicLine.split(' ').slice(0, 2).join(' '));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('each lease gets a different key', () => {
  const dir = temp();
  const a = newKeyPair(path.join(dir, 'a'));
  const b = newKeyPair(path.join(dir, 'b'));
  assert.notEqual(a.publicLine, b.publicLine);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a public key line is in OpenSSH form', () => {
  const line = publicKeyLine(Buffer.alloc(32, 7), 'me');
  assert.match(line, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI\S+ me$/);
});

test('ssh arguments send only the lease key', () => {
  const args = sshArgs({ keyPath: 'k', certPath: 'c', host: 'h', port: 2222, user: 'u' });
  assert.ok(args.includes('IdentitiesOnly=yes'));
  assert.ok(args.includes('CertificateFile=c'));
  assert.equal(args.at(-1), 'u@h');
});

test('ssh never falls back to asking for a password', () => {
  const args = sshArgs({ keyPath: 'k', certPath: 'c', host: 'h', port: 2222, user: 'u' });
  assert.ok(args.includes('PreferredAuthentications=publickey'));
});
