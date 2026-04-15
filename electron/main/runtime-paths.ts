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

module.exports = {
  resolveBundledHelperPath
};
