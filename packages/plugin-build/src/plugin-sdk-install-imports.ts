import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isPathWithinDirectory } from "@bb/process-utils";
import { RUNTIME_SLOT_BY_SPECIFIER } from "./runtime-shims.mjs";
import {
  importedRuntimeNames,
  PLUGIN_SDK_HOST_FALLBACK_EXPORTS,
  PLUGIN_SDK_HOST_FALLBACK_SPECIFIER,
  sourceImports,
} from "./build-plugin-host.js";
import { PLUGIN_SDK_ROOT_FILTER } from "./build-plugin-server.js";
import { isRecord, readPluginPackageJsonFile } from "./plugin-manifest.js";
import { PLUGIN_SDK_PACKAGE_NAME } from "./plugin-sdk-install.js";

type PluginEntryKind = "server" | "host" | "app";

export interface PluginSdkInstallImport {
  entry: PluginEntryKind;
  file: string;
  specifier: string;
}

const PROVIDED_BY_BB: Record<
  PluginEntryKind,
  (specifier: string, names: readonly string[]) => boolean
> = {
  server: (specifier) => PLUGIN_SDK_ROOT_FILTER.test(specifier),
  host: (specifier, names) =>
    specifier === PLUGIN_SDK_PACKAGE_NAME ||
    (specifier === PLUGIN_SDK_HOST_FALLBACK_SPECIFIER &&
      names.every((name) => PLUGIN_SDK_HOST_FALLBACK_EXPORTS.has(name))),
  app: (specifier) => Object.hasOwn(RUNTIME_SLOT_BY_SPECIFIER, specifier),
};

const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/u;
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

export async function findPluginSdkInstallImports(
  rootDir: string,
): Promise<PluginSdkInstallImport[]> {
  const manifest = await readPluginPackageJsonFile(
    join(rootDir, "package.json"),
  );
  const bb = isRecord(manifest) && isRecord(manifest.bb) ? manifest.bb : {};
  const found: PluginSdkInstallImport[] = [];
  for (const entry of ["server", "host", "app"] as const) {
    const entryPath = bb[entry];
    if (typeof entryPath !== "string") continue;
    const pending = [resolve(rootDir, entryPath)];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = await readSourceFile(rootDir, pending.shift()!);
      if (file === null || visited.has(file.path)) continue;
      visited.add(file.path);
      const imports = sourceImports(file.source);
      for (const { specifier, clause } of imports) {
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          pending.push(resolve(dirname(file.path), specifier));
          continue;
        }
        if (
          specifier !== PLUGIN_SDK_PACKAGE_NAME &&
          !specifier.startsWith(`${PLUGIN_SDK_PACKAGE_NAME}/`)
        ) {
          continue;
        }
        const names = clause
          ? importedRuntimeNames(file.source, specifier)
          : ["*"];
        if (names.length === 0 || PROVIDED_BY_BB[entry](specifier, names)) {
          continue;
        }
        const relativeFile = relative(rootDir, file.path).split(sep).join("/");
        if (
          !found.some(
            (item) =>
              item.file === relativeFile && item.specifier === specifier,
          )
        ) {
          found.push({ entry, file: relativeFile, specifier });
        }
      }
    }
  }
  return found;
}

async function readSourceFile(
  rootDir: string,
  path: string,
): Promise<{ path: string; source: string } | null> {
  const typescriptPath = path.replace(/\.([cm]?)js(x?)$/u, ".$1ts$2");
  for (const candidate of [
    path,
    typescriptPath,
    ...SOURCE_EXTENSIONS.map((extension) => `${path}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => join(path, `index${extension}`)),
  ]) {
    if (
      !SOURCE_FILE_PATTERN.test(candidate) ||
      !isPathWithinDirectory(resolve(rootDir), candidate)
    ) {
      continue;
    }
    const source = await readFile(candidate, "utf8").catch(() => null);
    if (source !== null) return { path: candidate, source };
  }
  return null;
}
