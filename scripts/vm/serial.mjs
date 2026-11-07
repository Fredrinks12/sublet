// Drives a QEMU guest over its serial console. Used to prepare a stock Debian VM on machines that
// have no Linux, such as a Windows laptop without WSL. Not needed on a real Linux server.
import net from 'node:net';

export class Serial {
  constructor(port = 4555, host = '127.0.0.1') {
    this.port = port;
    this.host = host;
    this.buffer = '';
    this.echo = false;
  }

  async connect(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await new Promise((resolve, reject) => {
          this.socket = net.connect(this.port, this.host, resolve);
          this.socket.once('error', reject);
        });
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    this.socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.buffer += text;
      if (this.echo) process.stdout.write(text);
    });
  }

  send(text) {
    this.socket.write(text);
  }

  /** Waits for a pattern in output received since the last match, then consumes it. */
  async expect(pattern, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = this.buffer.match(pattern);
      if (match) {
        this.buffer = this.buffer.slice(match.index + match[0].length);
        return match;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${pattern}. Tail:\n${this.buffer.slice(-600)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** Gets to a root shell, whether the guest is at a login prompt or already logged in. */
  async login(timeoutMs = 420_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.send('\n');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (/root@[^\s]*:.*#\s*$/.test(this.buffer)) break;
      if (/login:\s*$/.test(this.buffer)) {
        this.buffer = '';
        this.send('root\n');
        await this.expect(/#\s*$/, 60_000);
        break;
      }
      if (Date.now() > deadline) throw new Error(`No login prompt. Tail:\n${this.buffer.slice(-600)}`);
    }
    await this.run('export TERM=dumb PS1="# "; stty -echo cols 200; dmesg -n 1');
  }

  /** Runs a command, returning its output. Rejects on a non-zero exit unless `check` is false. */
  async run(command, { timeoutMs = 120_000, check = true } = {}) {
    const tag = `__S${Date.now().toString(36)}__`;
    this.buffer = '';
    this.send(`${command}; echo ${tag}$?${tag}\n`);
    const match = await this.expect(new RegExp(`([\\s\\S]*?)${tag}(\\d+)${tag}`), timeoutMs);
    const output = match[1].replaceAll('\r', '').trim();
    const code = Number(match[2]);
    if (check && code !== 0) throw new Error(`"${command}" exited ${code}:\n${output}`);
    return { output, code };
  }

  close() {
    this.socket?.destroy();
  }
}
