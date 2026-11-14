/**
 * The build identity the service worker is versioned by (ADR 0014). It is computed from the
 * content-hashed client build, so a deploy produces a new worker version; development uses a
 * stable `dev` version and leaves the asset list empty (Vite serves modules directly).
 */

export interface PwaBuild {
  readonly version: string;
  /** Absolute URLs of the hashed client assets, precached on install. */
  readonly assets: readonly string[];
}

let cached: Promise<PwaBuild> | undefined;

async function readBuild(): Promise<PwaBuild> {
  const override = process.env.BULLETIN_PWA_VERSION?.trim();

  if (!import.meta.env.PROD) {
    return { version: override === undefined || override === "" ? "dev" : override, assets: [] };
  }

  const assets: string[] = [];

  for await (const file of new Bun.Glob("dist/client/_astro/**/*").scan({
    cwd: process.cwd(),
    onlyFiles: true,
  })) {
    assets.push(`/${file.replace(/^dist\/client\//, "")}`);
  }

  assets.sort();
  const version =
    override === undefined || override === ""
      ? new Bun.CryptoHasher("sha256").update(assets.join("\n")).digest("hex").slice(0, 16)
      : override;

  return { version, assets };
}

export function pwaBuild(): Promise<PwaBuild> {
  cached ??= readBuild();
  return cached;
}
