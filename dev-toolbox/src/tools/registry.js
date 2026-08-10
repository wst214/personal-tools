import { notesTool } from './notes.js';
import { jsonTool } from './json.js';
import { timestampTool } from './timestamp.js';
import { regexTool } from './regex.js';
import { httpTool } from './http.js';

// 重型工具按需动态 import，避免启动时打包进首屏（xterm/crypto-js/sql-formatter/opencc 等）
function lazyTool(meta, importer) {
  let resolved = null;
  let pending = null;
  const ensure = () => {
    if (resolved) return Promise.resolve(resolved);
    if (!pending) {
      pending = importer().then((m) => {
        resolved = m[meta.exportName] || Object.values(m).find((v) => v && v.id === meta.id);
        if (!resolved) throw new Error('工具加载失败: ' + meta.id);
        return resolved;
      });
    }
    return pending;
  };
  return {
    id: meta.id,
    name: meta.name,
    category: meta.category,
    keywords: meta.keywords,
    desc: meta.desc,
    icon: meta.icon || '',
    async render(container) {
      const tool = await ensure();
      return tool.render(container);
    },
  };
}

const cryptoTool = lazyTool(
  { id: 'crypto', exportName: 'cryptoTool', name: '加解密编码', category: '编码转换', keywords: 'base64 md5 sha aes des rsa sm2 sm3 sm4 hash encrypt', desc: '编码 / 哈希 / 对称 / 非对称 / 国密' },
  () => import('./crypto.js'),
);
const sqlTool = lazyTool(
  { id: 'sql', exportName: 'sqlTool', name: 'SQL 格式化', category: '文本', keywords: 'sql format beautify', desc: 'SQL 美化 / 压缩' },
  () => import('./sql.js'),
);
const textTool = lazyTool(
  { id: 'text', exportName: 'textTool', name: '文本处理', category: '文本', keywords: 'text case convert opencc', desc: '去重 / 排序 / 简繁 / 大小写' },
  () => import('./text.js'),
);
const qrcodeTool = lazyTool(
  { id: 'qrcode', exportName: 'qrcodeTool', name: '二维码', category: '其它', keywords: 'qrcode qr jsqr', desc: '生成 / 解析二维码' },
  () => import('./qrcode.js'),
);
const cronTool = lazyTool(
  { id: 'cron', exportName: 'cronTool', name: 'Cron', category: '其它', keywords: 'cron schedule', desc: 'Cron 表达式解析' },
  () => import('./cron.js'),
);
const translateTool = lazyTool(
  { id: 'translate', exportName: 'translateTool', name: '翻译', category: '其它', keywords: 'translate', desc: '多语言互译' },
  () => import('./translate.js'),
);
const portScanTool = lazyTool(
  { id: 'portscan', exportName: 'portScanTool', name: '端口扫描', category: '网络', keywords: 'port scan', desc: '主机端口扫描' },
  () => import('./portscan.js'),
);
const uuidTool = lazyTool(
  { id: 'uuid', exportName: 'uuidTool', name: 'UUID 生成', category: '编码转换', keywords: 'uuid guid', desc: '批量生成 UUID' },
  () => import('./uuid.js'),
);
const baseTool = lazyTool(
  { id: 'base', exportName: 'baseTool', name: '进制转换', category: '编码转换', keywords: 'base hex binary', desc: '二/八/十/十六进制' },
  () => import('./base.js'),
);
const sshTool = lazyTool(
  { id: 'ssh', exportName: 'sshTool', name: 'SSH 终端', category: '网络', keywords: 'ssh terminal shell linux 远程 终端', desc: 'SSH 远程终端连接（支持多会话）' },
  () => import('./ssh.js'),
);
const sysInfoTool = lazyTool(
  { id: 'sysinfo', exportName: 'sysInfoTool', name: '系统信息', category: '系统', keywords: 'sysinfo cpu memory', desc: '本机系统信息' },
  () => import('./sysinfo.js'),
);
const hostsTool = lazyTool(
  { id: 'hosts', exportName: 'hostsTool', name: 'Hosts', category: '系统', keywords: 'hosts', desc: '读写系统 hosts' },
  () => import('./hosts.js'),
);
const deployTool = lazyTool(
  { id: 'deploy', exportName: 'deployTool', name: '部署工作台', category: '系统', keywords: 'deploy build docker', desc: '本地部署任务执行' },
  () => import('./deploy.js'),
);
const diffTool = lazyTool(
  { id: 'diff', exportName: 'diffTool', name: 'Diff 对比', category: '文本', keywords: 'diff compare text json 对比 差异', desc: '文本 / JSON 左右 Diff' },
  () => import('./diff.js'),
);
const embedTool = lazyTool(
  { id: 'embed', exportName: 'embedTool', name: 'TestHub', category: '系统', keywords: 'testhub 测试平台 iframe 内嵌', desc: '内嵌本机 TestHub' },
  () => import('./embed.js'),
);
const newapiTool = lazyTool(
  { id: 'newapi', exportName: 'newapiTool', name: 'New API', category: '系统', keywords: 'newapi new-api llm 中转 网关 openai 火山 讯飞 统一转发', desc: '多上游 LLM 统一转发（本机 New API）' },
  () => import('./newapi.js'),
);

// 工具注册表。侧边栏按「置顶 → 分类」渲染。notes/json 等常用工具仍静态引入以保证首屏快开。
export const tools = [
  notesTool,
  jsonTool, timestampTool, cryptoTool, baseTool, uuidTool,
  sqlTool, regexTool, textTool, diffTool,
  qrcodeTool, cronTool, translateTool, embedTool, newapiTool,
  httpTool, portScanTool, sshTool,
  sysInfoTool, hostsTool, deployTool,
];

export const hiddenToolIds = new Set(['uuid', 'base', 'text', 'portscan', 'translate']);
export const visibleTools = tools.filter((t) => !hiddenToolIds.has(t.id));
