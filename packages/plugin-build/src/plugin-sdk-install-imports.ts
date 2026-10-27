import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isPathWithinDirectory } from "@bb/process-utils";
import {
  isPluginSdkImportProvided,
  type PluginEntryKind,
} from "./plugin-sdk-runtime.js";
import { sourceImports } from "./source-imports.js";
import { isRecord, readPluginPackageJsonFile } from "./plugin-manifest.js";
import { PLUGIN_SDK_PACKAGE_NAME } from "./plugin-sdk-install.js";

export interface PluginSdkInstallImport {
  entry: PluginEntryKind;
  file: string;
  specifier: string;
}

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
  const pluginRoot = await realpath(rootDir);
  const found: PluginSdkInstallImport[] = [];
  for (const entry of ["server", "host", "app"] as const) {
    const entryPath = bb[entry];
    if (typeof entryPath !== "string") continue;
    const pending = [resolve(pluginRoot, entryPath)];
    const visited = new Set<string>();
    for (const path of pending) {
      const file = await readSourceFile(pluginRoot, path);
      if (file === null || visited.has(file.path)) continue;
      visited.add(file.path);
      const imports = sourceImports(file.source);
      const reported = new Set<string>();
      for (const { specifier, names } of imports) {
        if (names.length === 0) continue;
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          pending.push(resolve(dirname(file.path), specifier));
          continue;
        }
        const sdkSpecifier = specifier.replace(
          /^@bb\/plugin-sdk(?=\/|$)/u,
          PLUGIN_SDK_PACKAGE_NAME,
        );
        if (
          sdkSpecifier !== PLUGIN_SDK_PACKAGE_NAME &&
          !sdkSpecifier.startsWith(`${PLUGIN_SDK_PACKAGE_NAME}/`)
        ) {
          continue;
        }
        if (isPluginSdkImportProvided(entry, sdkSpecifier, names)) {
          continue;
        }
        const relativeFile = relative(pluginRoot, file.path)
          .split(sep)
          .join("/");
        if (!reported.has(specifier)) {
          reported.add(specifier);
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
      !isPathWithinDirectory(rootDir, candidate)
    ) {
      continue;
    }
    const sourcePath = await realpath(candidate).catch(() => null);
    if (sourcePath === null || !isPathWithinDirectory(rootDir, sourcePath)) {
      continue;
    }
    const source = await readFile(sourcePath, "utf8").catch(() => null);
    if (source !== null) return { path: sourcePath, source };
  }
  return null;
}
