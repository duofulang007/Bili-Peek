const fs = require('node:fs/promises');
const path = require('node:path');

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
async function resolveOutput(config, relative) {
  const root = path.resolve(config.vault);
  if (relative !== undefined && (typeof relative !== 'string' || !relative || relative.length > 1000 || /\0/.test(relative) || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split(/[\\/]/).includes('..'))) throw new Error('保存路径须为仓库内的文件夹');
  const output = relative === undefined ? path.resolve(config.output) : path.resolve(root, relative);
  if (!within(root, output)) throw new Error('输出目录不在配置的仓库内');
  const vault = await fs.realpath(root);
  let ancestor = output;
  while (true) {
    try {
      if (!within(vault, await fs.realpath(ancestor))) throw new Error('输出目录链接指向仓库外');
      if (!(await fs.stat(ancestor)).isDirectory()) throw new Error('保存路径不是文件夹');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || ancestor === root) throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  if (relative !== undefined && output !== path.resolve(config.output)) await fs.access(output);
  return output;
}
async function listFolders(config) {
  const root = path.resolve(config.vault), output = await resolveOutput(config);
  const defaultDirectory = path.relative(root, output).split(path.sep).join('/') || '.';
  const folders = ['.'];
  for (let index = 0; index < folders.length; index++) {
    for (const entry of await fs.readdir(path.resolve(root, folders[index]), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === 'Bili-Peek附件') continue;
      folders.push(folders[index] === '.' ? entry.name : folders[index] + '/' + entry.name);
      if (folders.length > 20000) throw new Error('仓库文件夹超过 20000 个，请整理后重试');
    }
  }
  if (!folders.includes(defaultDirectory)) folders.push(defaultDirectory);
  return { defaultDirectory, folders: folders.sort((a, b) => a.localeCompare(b, 'zh-CN')) };
}
module.exports = { resolveOutput, listFolders };
