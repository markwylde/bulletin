import { escapeHtml, escapeXml, htmlResponse, jsonResponse, renderPage } from "@bulletin/mock-ui";
import { type S3Credentials, verifyRequestSignature } from "./sigv4.ts";
import type { ObjectStore, StoredObject } from "./types.ts";

export interface S3MockOptions {
  readonly store: ObjectStore;
  readonly bucket: string;
  readonly credentials: S3Credentials;
  readonly basePath?: string;
  readonly now?: () => Date;
}

function normalizeBasePath(basePath: string | undefined): string {
  if (basePath === undefined || basePath === "" || basePath === "/") {
    return "";
  }

  return `/${basePath.replace(/^\/+|\/+$/g, "")}`;
}

function stripBasePath(pathname: string, basePath: string): string | null {
  if (basePath === "") {
    return pathname;
  }

  if (pathname === basePath) {
    return "/";
  }

  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : null;
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, HEAD, PUT, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "*");
  headers.set("access-control-expose-headers", "ETag, Content-Length, Content-Type");
  return new Response(response.body, { status: response.status, headers });
}

function s3Error(code: string, message: string, status: number): Response {
  return cors(
    new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${escapeXml(code)}</Code><Message>${escapeXml(
        message,
      )}</Message></Error>`,
      { status, headers: { "content-type": "application/xml" } },
    ),
  );
}

function objectHeaders(object: StoredObject): Headers {
  const headers = new Headers({
    "content-type": object.contentType,
    "content-length": String(object.body.byteLength),
    etag: object.etag,
    "last-modified": object.lastModified.toUTCString(),
  });

  for (const [key, value] of Object.entries(object.metadata)) {
    headers.set(`x-amz-meta-${key}`, value);
  }

  return headers;
}

function listXml(
  bucket: string,
  prefix: string,
  result: Awaited<ReturnType<ObjectStore["list"]>>,
): string {
  const contents = result.objects
    .map(
      (object) => `<Contents>
        <Key>${escapeXml(object.key)}</Key>
        <LastModified>${object.lastModified.toISOString()}</LastModified>
        <ETag>${escapeXml(object.etag)}</ETag>
        <Size>${object.body.byteLength}</Size>
        <StorageClass>STANDARD</StorageClass>
      </Contents>`,
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${escapeXml(bucket)}</Name>
  <Prefix>${escapeXml(prefix)}</Prefix>
  <KeyCount>${result.objects.length}</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>${result.isTruncated}</IsTruncated>
  ${result.nextContinuationToken === undefined ? "" : `<NextContinuationToken>${escapeXml(result.nextContinuationToken)}</NextContinuationToken>`}
  ${contents}
</ListBucketResult>`;
}

function renderObjects(objects: readonly StoredObject[]): string {
  if (objects.length === 0) {
    return '<p class="empty">No objects stored.</p>';
  }

  const rows = objects
    .map(
      (object) => `<tr>
        <td><code>${escapeHtml(object.key)}</code></td>
        <td>${object.body.byteLength}</td>
        <td>${escapeHtml(object.contentType)}</td>
        <td>${escapeHtml(object.lastModified.toISOString())}</td>
      </tr>`,
    )
    .join("");

  return `<div class="panel"><table>
    <thead><tr><th>Key</th><th>Bytes</th><th>Type</th><th>Last modified</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

async function readKey(
  url: URL,
  basePath: string,
  bucket: string,
): Promise<{ key: string } | Response> {
  const path = stripBasePath(url.pathname, basePath);

  if (path === null) {
    return s3Error("NoSuchBucket", "Unknown bucket", 404);
  }

  const segments = path.replace(/^\/+/, "").split("/");
  const requestBucket = decodeURIComponent(segments[0] ?? "");

  if (requestBucket !== bucket) {
    return s3Error("NoSuchBucket", "Unknown bucket", 404);
  }

  return {
    key: segments
      .slice(1)
      .map((segment) => decodeURIComponent(segment))
      .join("/"),
  };
}

/** Builds the S3-compatible request handler used by the mock server and its tests. */
export function createS3Handler(options: S3MockOptions): (request: Request) => Promise<Response> {
  const basePath = normalizeBasePath(options.basePath);
  const now = options.now ?? (() => new Date());

  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    const path = stripBasePath(url.pathname, basePath);

    if (path === null) {
      return s3Error("NoSuchBucket", "Unknown bucket", 404);
    }

    if (path === "/health") {
      const result = await options.store.list(options.bucket, { maxKeys: 1000 });
      return cors(jsonResponse({ status: "ok", objects: result.objects.length }));
    }

    if (path === "/" || path === "") {
      const result = await options.store.list(options.bucket, { maxKeys: 1000 });
      return cors(
        htmlResponse(
          renderPage(
            "S3 mock",
            `<p>Bucket <code>${escapeHtml(options.bucket)}</code> is stored in Postgres. The API is at <code>${escapeHtml(
              basePath || "/",
            )}/${escapeHtml(options.bucket)}/&lt;key&gt;</code>.</p>${renderObjects(result.objects)}`,
          ),
        ),
      );
    }

    const uploadBody =
      request.method === "PUT" && request.headers.get("x-amz-copy-source") === null
        ? new Uint8Array(await request.arrayBuffer())
        : undefined;
    const signature = verifyRequestSignature(request, url, options.credentials, now(), uploadBody);

    if (!signature.ok) {
      return s3Error("SignatureDoesNotMatch", signature.reason, 403);
    }

    const parsed = await readKey(url, basePath, options.bucket);

    if (parsed instanceof Response) {
      return parsed;
    }

    const key = parsed.key;

    if (key === "") {
      if (request.method !== "GET") {
        return s3Error("MethodNotAllowed", "Only GET is supported on a bucket", 405);
      }

      const prefix = url.searchParams.get("prefix") ?? "";
      const result = await options.store.list(options.bucket, {
        prefix,
        maxKeys: Number(url.searchParams.get("max-keys") ?? "1000"),
        ...(url.searchParams.has("continuation-token")
          ? { continuationToken: url.searchParams.get("continuation-token") ?? "" }
          : {}),
      });

      return cors(
        new Response(listXml(options.bucket, prefix, result), {
          headers: { "content-type": "application/xml" },
        }),
      );
    }

    if (request.method === "GET" || request.method === "HEAD") {
      const object = await options.store.get(options.bucket, key);

      if (object === null) {
        return s3Error("NoSuchKey", "The specified key does not exist", 404);
      }

      return cors(
        new Response(request.method === "HEAD" ? null : object.body, {
          headers: objectHeaders(object),
        }),
      );
    }

    if (request.method === "PUT") {
      const copySource = request.headers.get("x-amz-copy-source");

      if (copySource !== null) {
        const source = decodeURIComponent(copySource).replace(/^\/+/, "");
        const slash = source.indexOf("/");
        const sourceBucket = slash === -1 ? source : source.slice(0, slash);
        const sourceKey = slash === -1 ? "" : source.slice(slash + 1);

        if (sourceBucket !== options.bucket) {
          return s3Error("NoSuchBucket", "Unknown copy source bucket", 404);
        }

        const original = await options.store.get(options.bucket, sourceKey);

        if (original === null) {
          return s3Error("NoSuchKey", "Copy source does not exist", 404);
        }

        const copied = await options.store.put({
          bucket: options.bucket,
          key,
          body: original.body,
          contentType: original.contentType,
          metadata: original.metadata,
        });

        return cors(
          new Response(
            `<CopyObjectResult><ETag>${escapeXml(copied.etag)}</ETag><LastModified>${copied.lastModified.toISOString()}</LastModified></CopyObjectResult>`,
            { headers: { "content-type": "application/xml" } },
          ),
        );
      }

      const body = uploadBody ?? new Uint8Array();
      const metadata: Record<string, string> = {};

      for (const [name, value] of request.headers.entries()) {
        if (name.startsWith("x-amz-meta-")) {
          metadata[name.slice("x-amz-meta-".length)] = value;
        }
      }

      const object = await options.store.put({
        bucket: options.bucket,
        key,
        body,
        contentType: request.headers.get("content-type") ?? "application/octet-stream",
        metadata,
      });

      return cors(new Response(null, { status: 200, headers: { etag: object.etag } }));
    }

    if (request.method === "DELETE") {
      await options.store.delete(options.bucket, key);
      return cors(new Response(null, { status: 204 }));
    }

    return s3Error("MethodNotAllowed", "Unsupported method", 405);
  };
}
