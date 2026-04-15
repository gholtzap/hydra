const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

function resolveBundledHelperPath(fileName: string): string {
  const packagedPath = path.join(process.resourcesPath, "helpers", fileName);
  if (app.isPackaged && fs.existsSync(packagedPath)) {
    return packagedPath;
  }

  return path.join(__dirname, fileName);
}

function resolveBundledNodeModulePath(
  packageName: string,
  relativePath: string,
  options?: { unpacked?: boolean }
): string | null {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    const packagePath = path.dirname(packageJsonPath);
    const resolvedPath = path.join(packagePath, relativePath);

    if (app.isPackaged && options?.unpacked) {
      const unpackedPath = resolvedPath.replace(
        `${path.sep}app.asar${path.sep}`,
        `${path.sep}app.asar.unpacked${path.sep}`
      );
      if (fs.existsSync(unpackedPath)) {
        return unpackedPath;
      }
    }

    return fs.existsSync(resolvedPath) ? resolvedPath : null;
  } catch {
    return null;
  }
}

module.exports = {
  resolveBundledHelperPath,
  resolveBundledNodeModulePath
};
