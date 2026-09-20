import fs from 'node:fs';
import path from 'node:path';

const LEGACY_INFO_PATTERN = /^server-(\d+)\.html$/;

export function createProjectInfoStore({ appName, sessionId, projectPath, sessionDir, nowIso }) {
  const projectInfoPath = () => path.join(sessionDir, 'project.json');
  const openPagePath = () => path.join(sessionDir, 'open.html');

  function openPageHtml(port) {
    const url = `http://127.0.0.1:${port}/`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=${url}">
<title>I Need Better UI</title>
</head>
<body data-app="${appName}" data-session-id="${sessionId}" data-port="${port}" data-pid="${process.pid}">
<p>Opening <a href="${url}">${url}</a>. If nothing happens, this ${appName} server is no longer running.</p>
</body>
</html>
`;
  }

  function legacyInfoFiles() {
    try {
      return fs.readdirSync(sessionDir).flatMap(name => {
        const match = LEGACY_INFO_PATTERN.exec(name);
        return match ? [{ file: path.join(sessionDir, name), port: Number(match[1]) }] : [];
      });
    } catch {
      return [];
    }
  }

  function removeFile(file) {
    try { fs.unlinkSync(file); } catch {}
  }

  function readProjectInfo() {
    try { return JSON.parse(fs.readFileSync(projectInfoPath(), 'utf8')); } catch { return null; }
  }

  function writeProjectInfo(server, agents) {
    const previous = readProjectInfo();
    const keepServer = server === undefined ? previous?.server : server;
    const info = {
      app: appName,
      sessionId,
      projectPath,
      createdAt: previous?.createdAt || nowIso(),
      lastStartedAt: server ? nowIso() : (previous?.lastStartedAt || nowIso())
    };
    if (keepServer) info.server = keepServer;
    const keepAgents = agents === undefined ? previous?.agents : agents;
    if (keepAgents && Object.keys(keepAgents).length) info.agents = keepAgents;
    const temp = `${projectInfoPath()}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, projectInfoPath());
  }

  return { legacyInfoFiles, openPageHtml, openPagePath, readProjectInfo, removeFile, writeProjectInfo };
}
