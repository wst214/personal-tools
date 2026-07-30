import { jsonTool } from './json.js';
import { timestampTool } from './timestamp.js';
import { cryptoTool } from './crypto.js';
import { baseTool } from './base.js';
import { uuidTool } from './uuid.js';
import { sqlTool } from './sql.js';
import { regexTool } from './regex.js';
import { textTool } from './text.js';
import { qrcodeTool } from './qrcode.js';
import { cronTool } from './cron.js';
import { notesTool } from './notes.js';
import { translateTool } from './translate.js';
import { httpTool } from './http.js';
import { portScanTool } from './portscan.js';
import { sysInfoTool } from './sysinfo.js';
import { hostsTool } from './hosts.js';

// 工具注册表。侧边栏按「置顶 → 分类（编码转换/文本/网络/系统/其它）」渲染，其它类在最下。
export const tools = [
  notesTool,
  jsonTool, timestampTool, cryptoTool, baseTool, uuidTool,
  sqlTool, regexTool, textTool,
  qrcodeTool, cronTool, translateTool,
  httpTool, portScanTool,
  sysInfoTool, hostsTool,
];
