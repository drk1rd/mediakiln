import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { RemoteCacheConfig } from "./config.js";
import type { Logger } from "./util/logger.js";

/**
 * Shared cache in S3-compatible storage (AWS S3, Cloudflare R2, MinIO, Backblaze B2, …), so a
 * team or several CI runners encode each asset once. Every cache entry is one object: a small
 * JSON index followed by the files' bytes ("mkpack"), streamed in both directions.
 */
export interface RemoteCache {
  /** Download entry `key` into `dir` (created). Resolves false when the entry doesn't exist. */
  get(key: string, dir: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  /** Upload the folder `dir` as entry `key`. */
  put(key: string, dir: string): Promise<void>;
  readonly write: boolean;
}

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): Credentials | undefined {
  const accessKeyId = env.MEDIAKILN_S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.MEDIAKILN_S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return undefined;
  const sessionToken = env.MEDIAKILN_S3_SESSION_TOKEN ?? env.AWS_SESSION_TOKEN;
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

// ---- AWS Signature Version 4 ------------------------------------------------------------

const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as S3 expects for each path segment. */
export function encodeKeyPath(p: string): string {
  return p
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

export interface SignInput {
  method: string;
  url: URL;
  region: string;
  headers: Record<string, string>;
  /** Hex sha256 of the body, or "UNSIGNED-PAYLOAD". */
  payloadHash: string;
  credentials: Credentials;
  date: Date;
  service?: string;
}

/** Returns the request headers including `Authorization` (SigV4, header-based). */
export function signV4(i: SignInput): Record<string, string> {
  const amzDate = i.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const service = i.service ?? "s3";
  const headers: Record<string, string> = {
    ...i.headers,
    host: i.url.host,
    "x-amz-content-sha256": i.payloadHash,
    "x-amz-date": amzDate,
    ...(i.credentials.sessionToken ? { "x-amz-security-token": i.credentials.sessionToken } : {}),
  };
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()]),
  );
  const names = Object.keys(lower).sort();
  const query = [...i.url.searchParams.entries()]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join("&");
  const canonical = [
    i.method,
    i.url.pathname,
    query,
    names.map((n) => `${n}:${lower[n]}\n`).join(""),
    names.join(";"),
    i.payloadHash,
  ].join("\n");
  const scope = `${day}/${i.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
  const kDate = hmac("AWS4" + i.credentials.secretAccessKey, day);
  const kSigning = hmac(hmac(hmac(kDate, i.region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${i.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

// ---- mkpack: [uint32 index length][index JSON][file bytes…] -------------------------------

interface PackEntry {
  path: string;
  size: number;
}

async function listFiles(dir: string, prefix = ""): Promise<PackEntry[]> {
  const out: PackEntry[] = [];
  for (const e of await fs.readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (e.isFile()) out.push({ path: rel, size: (await fs.stat(path.join(dir, rel))).size });
  }
  return out;
}

export async function packStream(dir: string): Promise<{ stream: Readable; length: number }> {
  const files = await listFiles(dir);
  const index = Buffer.from(JSON.stringify({ v: 1, files }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(index.length);
  async function* gen() {
    yield header;
    yield index;
    for (const f of files) yield* createReadStream(path.join(dir, f.path));
  }
  return {
    stream: Readable.from(gen()),
    length: 4 + index.length + files.reduce((n, f) => n + f.size, 0),
  };
}

/** Unpack a stream produced by `packStream` into `dir`, rejecting unsafe paths. */
export async function unpackStream(source: AsyncIterable<Uint8Array>, dir: string): Promise<void> {
  const iterator = source[Symbol.asyncIterator]();
  let buf: Buffer = Buffer.alloc(0);
  const need = async (n: number) => {
    while (buf.length < n) {
      const { value, done } = await iterator.next();
      if (done) throw new Error("Truncated cache entry");
      buf = Buffer.concat([buf, Buffer.from(value)]);
    }
  };
  await need(4);
  const indexLength = buf.readUInt32BE(0);
  await need(4 + indexLength);
  const { files } = JSON.parse(buf.subarray(4, 4 + indexLength).toString("utf8")) as {
    files: PackEntry[];
  };
  buf = buf.subarray(4 + indexLength);
  const root = path.resolve(dir);
  for (const f of files) {
    const target = path.resolve(root, f.path);
    if (!target.startsWith(root + path.sep))
      throw new Error(`Unsafe path in cache entry: ${f.path}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const out = createWriteStream(target);
    let remaining = f.size;
    try {
      while (remaining > 0) {
        if (buf.length === 0) await need(1);
        const take = buf.subarray(0, Math.min(remaining, buf.length));
        buf = buf.subarray(take.length);
        remaining -= take.length;
        if (!out.write(take)) await new Promise<void>((r) => out.once("drain", () => r()));
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        out.end((err?: Error | null) => (err ? reject(err) : resolve())),
      );
    }
  }
}

// ---- client ------------------------------------------------------------------------------

export function objectUrl(cfg: RemoteCacheConfig, key: string): { url: URL; region: string } {
  const objectKey = encodeKeyPath(`${cfg.prefix}${key}.mkpack`);
  if (cfg.endpoint) {
    // Custom endpoints (R2, MinIO, …): path-style addressing.
    const base = cfg.endpoint.replace(/\/+$/, "");
    return {
      url: new URL(`${base}/${encodeKeyPath(cfg.bucket)}/${objectKey}`),
      region: cfg.region || "auto",
    };
  }
  const region = !cfg.region || cfg.region === "auto" ? "us-east-1" : cfg.region;
  return { url: new URL(`https://${cfg.bucket}.s3.${region}.amazonaws.com/${objectKey}`), region };
}

export function createRemoteCache(
  cfg: RemoteCacheConfig,
  logger: Logger,
  credentials: Credentials | undefined = credentialsFromEnv(),
  fetchImpl: typeof fetch = fetch,
): RemoteCache | undefined {
  if (!credentials) {
    logger.warn(
      "remoteCache is configured but no credentials were found " +
        "(MEDIAKILN_S3_ACCESS_KEY_ID/MEDIAKILN_S3_SECRET_ACCESS_KEY or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY); using the local cache only",
    );
    return undefined;
  }
  const request = (
    method: string,
    key: string,
    init: { headers?: Record<string, string>; body?: Readable; length?: number } = {},
  ) => {
    const { url, region } = objectUrl(cfg, key);
    const headers = signV4({
      method,
      url,
      region,
      headers: {
        ...(init.headers ?? {}),
        ...(init.length !== undefined ? { "content-length": String(init.length) } : {}),
      },
      payloadHash: init.body ? "UNSIGNED-PAYLOAD" : sha256Hex(""),
      credentials,
      date: new Date(),
    });
    delete headers.host;
    return fetchImpl(url, {
      method,
      headers,
      ...(init.body
        ? { body: Readable.toWeb(init.body) as unknown as BodyInit, duplex: "half" }
        : {}),
    } as RequestInit);
  };

  return {
    write: cfg.write,
    async has(key) {
      const res = await request("HEAD", key);
      if (res.status === 404 || res.status === 403) return false;
      if (!res.ok) throw new Error(`remote cache HEAD ${res.status}`);
      return true;
    },
    async get(key, dir) {
      const res = await request("GET", key);
      if (res.status === 404 || res.status === 403) return false;
      if (!res.ok || !res.body) throw new Error(`remote cache GET ${res.status}`);
      await fs.mkdir(dir, { recursive: true });
      await unpackStream(res.body as unknown as AsyncIterable<Uint8Array>, dir);
      logger.debug(`remote cache hit ${key.slice(0, 12)}`);
      return true;
    },
    async put(key, dir) {
      const { stream, length } = await packStream(dir);
      const res = await request("PUT", key, {
        body: stream,
        length,
        headers: { "content-type": "application/octet-stream" },
      });
      if (!res.ok)
        throw new Error(`remote cache PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
      logger.debug(`remote cache stored ${key.slice(0, 12)} (${length} bytes)`);
    },
  };
}
