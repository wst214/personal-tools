// 用户个人默认部署任务：首次启动时若 deploy-tasks.json 不存在则写入这些。
// 来自 leidian-pgsql-center / leidian-pgsql-site 两个项目的 IDEA 运行配置：
//   - build-export-all-services  -> 本地打包内置（导出镜像 tar）
//   - docker-compose.pg-apps-*   -> pg-apps 构建重启（mvn 打包 + compose up --build 重建，--no-deps 只起业务）
// 参数化：运行时可勾选要构建/重启的服务（默认全选），导出路径可自定义。
// 脚本已搬进 toolbox（scripts/leidian/build-export-image.ps1），靠 {{toolbox}} 占位符定位，不再依赖原项目路径。
// cwd 是本机绝对路径；换机器或移目录后请在界面里改或删。

const SERVICES = ['db-migration', 'gateway-service', 'system-service', 'data-service', 'biz-service', 'task-service'];

module.exports = [
  {
    id: 'seed-center-build-export',
    name: 'center·打包内置（导出镜像）',
    cwd: 'D:\\workspace\\leidian\\leidian-pgsql-center',
    params: [
      { key: 'services', label: '服务', type: 'multiselect', options: [...SERVICES], default: [...SERVICES] },
      { key: 'exportDir', label: '导出路径', type: 'dir', default: '{{cwd}}/exports', placeholder: '留空用默认 {cwd}/exports' },
    ],
    commands: [
      '{{#each services}}',
      'powershell -NoProfile -ExecutionPolicy Bypass -File "{{toolbox}}/scripts/leidian/build-export-image.ps1" -ProjectRoot "{{cwd}}" -Service "{{this}}" -ExportDir "{{exportDir}}"',
      '{{/each}}',
    ],
    env: {},
    note: 'IDEA: build-export-all-services。每选一个服务构建并导出 .tar；导出路径留空走脚本默认 {cwd}/exports。脚本已内置到 toolbox',
  },
  {
    id: 'seed-center-pg-apps',
    name: 'center·pg-apps 构建重启',
    cwd: 'D:\\workspace\\leidian\\leidian-pgsql-center',
    params: [
      { key: 'services', label: '服务', type: 'multiselect', options: [...SERVICES], default: [...SERVICES] },
    ],
    commands: [
      'mvn -pl {{services|join=,|prefix=services/}} -am clean package -DskipTests -ntp',
      'docker compose -f deployments/docker-compose/docker-compose.yml -f deployments/docker-compose/overlays/compose-base.yml -f deployments/docker-compose/overlays/compose-center.yml -f deployments/docker-compose/overlays/compose-standard.yml -f deployments/docker-compose/docker-compose.local-build.yml --env-file deployments/docker-compose/.env up --build --force-recreate --no-deps {{services}}',
    ],
    env: {},
    note: 'IDEA: docker-compose.pg-apps-center。勾选哪些服务就构建重启哪些；mvn -pl 自动按服务名派生',
  },
  {
    id: 'seed-center-pg-all',
    name: 'center·全部重启（含基础设施）',
    cwd: 'D:\\workspace\\leidian\\leidian-pgsql-center',
    params: [
      { key: 'services', label: '服务', type: 'multiselect', options: [...SERVICES], default: [...SERVICES] },
    ],
    commands: [
      'mvn -pl {{services|join=,|prefix=services/}} -am clean package -DskipTests -ntp',
      'docker compose -f deployments/docker-compose/docker-compose.yml -f deployments/docker-compose/overlays/compose-base.yml -f deployments/docker-compose/overlays/compose-center.yml -f deployments/docker-compose/overlays/compose-standard.yml -f deployments/docker-compose/docker-compose.local-build.yml --env-file deployments/docker-compose/.env up --build --force-recreate {{services}}',
    ],
    env: {},
    note: 'IDEA: docker-compose.pg-all-center。无 --no-deps，up 业务服务时连带启动依赖的基础设施（kafka/nacos/redis/postgres/minio）；适合首次启动或全量重启',
  },
  {
    id: 'seed-site-build-export',
    name: 'site·打包内置（导出镜像）',
    cwd: 'D:\\workspace\\leidian\\leidian-pgsql-site',
    params: [
      { key: 'services', label: '服务', type: 'multiselect', options: [...SERVICES], default: [...SERVICES] },
      { key: 'exportDir', label: '导出路径', type: 'dir', default: '{{cwd}}/exports', placeholder: '留空用默认 {cwd}/exports' },
    ],
    commands: [
      '{{#each services}}',
      'powershell -NoProfile -ExecutionPolicy Bypass -File "{{toolbox}}/scripts/leidian/build-export-image.ps1" -ProjectRoot "{{cwd}}" -Service "{{this}}" -ExportDir "{{exportDir}}"',
      '{{/each}}',
    ],
    env: {},
    note: 'IDEA: build-export-all-services (site)。脚本内置到 toolbox，与 center 共用',
  },
  {
    id: 'seed-site-pg-apps',
    name: 'site·pg-apps 构建重启',
    cwd: 'D:\\workspace\\leidian\\leidian-pgsql-site',
    params: [
      { key: 'services', label: '服务', type: 'multiselect', options: [...SERVICES], default: [...SERVICES] },
    ],
    commands: [
      'mvn -pl {{services|join=,|prefix=services/}} -am clean package -DskipTests -ntp',
      'docker compose -f deployments/docker-compose/docker-compose.yml -f deployments/docker-compose/overlays/compose-base.yml -f deployments/docker-compose/overlays/compose-site.yml -f deployments/docker-compose/overlays/compose-standard.yml -f deployments/docker-compose/docker-compose.local-build.yml -f deployments/docker-compose/overlays/compose-host-site.yml --env-file deployments/docker-compose/.env up --build --force-recreate --no-deps {{services}}',
    ],
    env: {},
    note: 'IDEA: docker-compose.pg-apps-site。site 比 center 多 compose-host-site.yml overlay',
  },
  {
    id: 'seed-site-pg-all',
    name: 'site·全部重启（含基础设施）',
    cwd: 'D:\\workspace\\leidian\\leidian-pgsql-site',
    params: [
      { key: 'services', label: '服务', type: 'multiselect', options: [...SERVICES], default: [...SERVICES] },
    ],
    commands: [
      'mvn -pl {{services|join=,|prefix=services/}} -am clean package -DskipTests -ntp',
      'docker compose -f deployments/docker-compose/docker-compose.yml -f deployments/docker-compose/overlays/compose-base.yml -f deployments/docker-compose/overlays/compose-site.yml -f deployments/docker-compose/overlays/compose-standard.yml -f deployments/docker-compose/docker-compose.local-build.yml -f deployments/docker-compose/overlays/compose-host-site.yml --env-file deployments/docker-compose/.env up --build --force-recreate {{services}}',
    ],
    env: {},
    note: 'IDEA: docker-compose.pg-all-site。同 center pg-all，site 多 compose-host-site.yml overlay；连基础设施一起起',
  },
];
