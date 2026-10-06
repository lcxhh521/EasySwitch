/** Private append-only capability journal: only hashes and public scope metadata, never bearer tokens. */
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

const MAX_BYTES = 32 * 1024 * 1024;
const HEADER = '{"version":1}\n';
export class GatewaySessionStoreError extends Error {
  status = 503;
  code = "gateway_session_storage_unavailable";
  constructor() { super("会话令牌持久记录无法安全读取或写入；现有权限不会自动恢复，请检查本地存储。"); }
}

export class GatewaySessionStore {
  #path: string;
  #identity: string | undefined;
  #offset = 0;
  #stamp: string | undefined;
  constructor(path: string) {
    if (!isAbsolute(path)) throw new TypeError("Gateway session stateFile must be absolute");
    this.#path = path;
  }
  #open(flags: number): number {
    const fd = openSync(this.#path, flags | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > MAX_BYTES || (process.platform !== "win32" && ((info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid())))) throw new GatewaySessionStoreError();
      const identity = `${info.dev}:${info.ino}`;
      if (this.#identity !== undefined && identity !== this.#identity) throw new GatewaySessionStoreError();
      this.#identity = identity;
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  /** Only complete journal records count. Corruption/truncation is never repaired by silently dropping data. */
  read(): unknown[] {
    if (!existsSync(this.#path)) {
      // lstat distinguishes a broken symlink from an absent fresh state file.
      try { lstatSync(this.#path); throw new GatewaySessionStoreError(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new GatewaySessionStoreError(); }
      if (this.#identity !== undefined) throw new GatewaySessionStoreError();
      return [];
    }
    const fd = this.#open(constants.O_RDONLY);
    try {
      const info = fstatSync(fd), size = info.size;
      const stamp = `${info.mtimeMs}:${info.ctimeMs}`;
      if (size < this.#offset) throw new GatewaySessionStoreError();
      if (size === this.#offset) {
        if (this.#stamp !== undefined && stamp !== this.#stamp) throw new GatewaySessionStoreError();
        return [];
      }
      const buffer = Buffer.alloc(size - this.#offset);
      let received = 0;
      while (received < buffer.length) {
        const bytes = readSync(fd, buffer, received, buffer.length - received, this.#offset + received);
        if (!bytes) throw new GatewaySessionStoreError();
        received += bytes;
      }
      const text = buffer.toString("utf8");
      if (!text.endsWith("\n")) throw new GatewaySessionStoreError();
      const rows = text.slice(0, -1).split("\n");
      if (this.#offset === 0 && rows.shift() !== HEADER.trim()) throw new GatewaySessionStoreError();
      const events = rows.map(row => { if (!row || Buffer.byteLength(row) > 8192) throw new GatewaySessionStoreError(); return JSON.parse(row) as unknown; });
      this.#offset = size;
      this.#stamp = stamp;
      return events;
    } catch { throw new GatewaySessionStoreError(); }
    finally { closeSync(fd); }
  }
  append(event: unknown): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    if (this.#identity === undefined && !existsSync(this.#path)) {
      let fd: number | undefined;
      let created = false;
      try {
        fd = openSync(this.#path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        created = true;
        if (writeSync(fd, HEADER) !== Buffer.byteLength(HEADER)) throw new GatewaySessionStoreError();
        fsyncSync(fd);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new GatewaySessionStoreError(); }
      finally { if (fd !== undefined) closeSync(fd); }
      if (created && process.platform !== "win32") {
        const directory = openSync(dirname(this.#path), constants.O_RDONLY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    }
    const fd = this.#open(constants.O_WRONLY | constants.O_APPEND);
    try {
      const line = JSON.stringify(event) + "\n";
      const size = fstatSync(fd).size;
      if (size < this.#offset || Buffer.byteLength(line) > 8192 || size + Buffer.byteLength(line) > MAX_BYTES) throw new GatewaySessionStoreError();
      // One append syscall prevents stale snapshots from overwriting another writer's revocations.
      if (writeSync(fd, line) !== Buffer.byteLength(line)) throw new GatewaySessionStoreError();
      fsyncSync(fd);
    } catch { throw new GatewaySessionStoreError(); }
    finally { closeSync(fd); }
  }
}
