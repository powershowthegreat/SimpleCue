import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";

export class Store {
  constructor({
    url = process.env.UPSTASH_REDIS_REST_URL,
    token = process.env.UPSTASH_REDIS_REST_TOKEN,
    prefix = process.env.REDIS_PREFIX || "simplecue:v1",
    file = path.resolve(process.env.DATA_DIR || "data", "database.json"),
  } = {}) {
    if (Boolean(url) !== Boolean(token))
      throw new Error("Both Upstash environment variables are required.");
    this.url = url;
    this.token = token;
    this.prefix = prefix;
    this.file = file;
    this.queue = Promise.resolve();
    this.ready = url ? Promise.resolve() : this.load();
  }
  async load() {
    try {
      this.local = JSON.parse(await readFile(this.file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      this.local = {};
    }
  }
  async command(...args) {
    await this.ready;
    if (this.url) {
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok)
        throw new Error("Redis is unavailable. Check the server environment.");
      const data = await res.json();
      if (data.error) throw new Error("Redis command failed.");
      return data.result;
    }
    const [cmd, key, ...rest] = args;
    const job = this.queue.then(async () => {
      let result;
      if (cmd === "GET") {
        const entry = this.local[key];
        result =
          entry && (!entry.expires || entry.expires > Date.now())
            ? entry.value
            : null;
      }
      if (cmd === "SET") {
        this.local[key] = {
          value: rest[0],
          expires:
            rest[1] === "EX" ? Date.now() + Number(rest[2]) * 1000 : null,
        };
        result = "OK";
      }
      if (cmd === "DEL") {
        delete this.local[key];
        result = 1;
      }
      if (cmd === "HGETALL")
        result = Object.entries(this.local[key] || {}).flat();
      if (cmd === "HSET" || cmd === "HSETNX") {
        this.local[key] ||= {};
        if (cmd === "HSET" || !(rest[0] in this.local[key])) {
          this.local[key][rest[0]] = rest[1];
          result = 1;
        } else result = 0;
      }
      if (cmd === "HDEL") {
        delete this.local[key]?.[rest[0]];
        result = 1;
      }
      if (!["GET", "HGETALL"].includes(cmd)) {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(
          this.file + ".tmp",
          JSON.stringify(this.local, null, 2),
        );
        await rename(this.file + ".tmp", this.file);
      }
      return result;
    });
    this.queue = job.catch(() => {});
    return job;
  }
  key(k) {
    return `${this.prefix}:${k}`;
  }
  async all(k) {
    const arr = await this.command("HGETALL", this.key(k));
    const result = {};
    for (let i = 0; i < arr.length; i += 2)
      result[arr[i]] = JSON.parse(arr[i + 1]);
    return result;
  }
  put(k, id, value, onlyNew = false) {
    return this.command(
      onlyNew ? "HSETNX" : "HSET",
      this.key(k),
      id,
      JSON.stringify(value),
    );
  }
  remove(k, id) {
    return this.command("HDEL", this.key(k), id);
  }
  async get(k) {
    const v = await this.command("GET", this.key(k));
    return v ? JSON.parse(v) : null;
  }
  set(k, v, ttl) {
    return this.command(
      "SET",
      this.key(k),
      JSON.stringify(v),
      ...(ttl ? ["EX", ttl] : []),
    );
  }
  del(k) {
    return this.command("DEL", this.key(k));
  }
}
export const store = new Store();
