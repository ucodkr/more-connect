import { createReadStream } from "node:fs";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { basename } from "node:path";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import type { S3Host } from "../types";

export type S3Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type S3ListedObject = {
  key: string;
  size?: number;
  lastModified?: Date;
};

export function createS3Client(host: S3Host, creds: S3Credentials): S3Client {
  return new S3Client({
    region: host.region || "us-east-1",
    endpoint: host.endpointUrl ? host.endpointUrl : undefined,
    forcePathStyle: host.forcePathStyle === true ? true : undefined,
    credentials: creds
  });
}

export async function listBuckets(host: S3Host, creds: S3Credentials): Promise<string[]> {
  const client = createS3Client(host, creds);
  const res = await client.send(new ListBucketsCommand({}));
  return (res.Buckets ?? [])
    .map((b) => b.Name)
    .filter((name): name is string => !!name)
    .sort((a, b) => a.localeCompare(b));
}

function normalizePrefix(prefix: string): string {
  if (!prefix) return "";
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

function normalizeKeyPart(input: string): string {
  return input.replace(/^\/+/, "").replace(/\\/g, "/");
}

export async function listFolder(
  host: S3Host,
  creds: S3Credentials,
  bucket: string,
  prefix: string
): Promise<{ prefixes: string[]; objects: S3ListedObject[] }> {
  const client = createS3Client(host, creds);
  const res = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: "/"
    })
  );
  const prefixes = (res.CommonPrefixes ?? [])
    .map((p) => p.Prefix)
    .filter((p): p is string => !!p)
    .sort((a, b) => a.localeCompare(b));
  const objects = (res.Contents ?? [])
    .map((o) => ({
      key: o.Key ?? "",
      size: typeof o.Size === "number" ? o.Size : undefined,
      lastModified: o.LastModified
    }))
    .filter((o) => !!o.key)
    .filter((o) => !o.key.endsWith("/"))
    .filter((o) => o.key !== prefix)
    .sort((a, b) => a.key.localeCompare(b.key));
  return { prefixes, objects };
}

export async function deleteObject(host: S3Host, creds: S3Credentials, bucket: string, key: string): Promise<void> {
  const client = createS3Client(host, creds);
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function deletePrefixRecursive(host: S3Host, creds: S3Credentials, bucket: string, prefix: string): Promise<void> {
  const client = createS3Client(host, creds);
  const targetPrefix = normalizePrefix(prefix);
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: targetPrefix,
        ContinuationToken: token
      })
    );
    const keys = (res.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => !!k);
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })) }
        })
      );
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
}

export async function listKeysRecursive(
  host: S3Host,
  creds: S3Credentials,
  bucket: string,
  prefix: string
): Promise<Array<{ key: string; size?: number }>> {
  const client = createS3Client(host, creds);
  const targetPrefix = prefix ? normalizePrefix(prefix) : "";
  const out: Array<{ key: string; size?: number }> = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: targetPrefix,
        ContinuationToken: token
      })
    );
    for (const o of res.Contents ?? []) {
      const key = o.Key;
      if (!key) continue;
      if (key.endsWith("/")) continue;
      out.push({ key, size: typeof o.Size === "number" ? o.Size : undefined });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export async function downloadObjectToFile(
  host: S3Host,
  creds: S3Credentials,
  bucket: string,
  key: string,
  targetFileFsPath: string
): Promise<void> {
  const client = createS3Client(host, creds);
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = res.Body;
  if (!body) throw new Error("Empty response body");
  // In Node.js, Body is typically a Readable stream.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readable = body as any;
  await pipeline(readable, createWriteStream(targetFileFsPath));
}

export async function createFolder(
  host: S3Host,
  creds: S3Credentials,
  bucket: string,
  parentPrefix: string,
  folderName: string
): Promise<{ prefix: string }> {
  const client = createS3Client(host, creds);
  const cleanName = normalizeKeyPart(folderName).replace(/\/+$/, "");
  const key = `${normalizePrefix(parentPrefix)}${cleanName}/`;
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: ""
    })
  );
  return { prefix: key };
}

export async function uploadFileAsKey(
  host: S3Host,
  creds: S3Credentials,
  bucket: string,
  key: string,
  localFileFsPath: string
): Promise<void> {
  const client = createS3Client(host, creds);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: normalizeKeyPart(key),
      Body: createReadStream(localFileFsPath)
    })
  );
}

export async function uploadFile(
  host: S3Host,
  creds: S3Credentials,
  bucket: string,
  prefix: string,
  localFileFsPath: string
): Promise<{ key: string }> {
  const keyPrefix = prefix ? normalizePrefix(prefix) : "";
  const key = `${keyPrefix}${basename(localFileFsPath)}`;
  await uploadFileAsKey(host, creds, bucket, key, localFileFsPath);
  return { key };
}
