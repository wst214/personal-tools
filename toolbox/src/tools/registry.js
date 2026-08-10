import { notesTool } from './notes.js';
import { sshTool } from './ssh.js';
import { jsonTool } from './json.js';
import { deployTool } from './deploy.js';

// 工具注册表。新增工具在这里登记即可出现在侧边栏。
export const tools = [notesTool, sshTool, jsonTool, deployTool];
