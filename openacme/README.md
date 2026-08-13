# OpenAcme 项目工作区

产品交付组（`product-delivery`）的共享工作区。  
OpenAcme 内部路径仍是 `~/.openacme/teams/product-delivery/workspace/`，已软链到本目录。

## 用法

每个项目一个子目录，例如：

```text
openacme/
  todo-app/                 # 示例：个人待办 MVP
    docs/prd/
    docs/arch/
    docs/design/
    docs/test/
    docs/ops/
    ...源码
  <你的项目名>/
    docs/design/...         # 已有设计文档可直接放这里
```

给产品经理下目标时写清项目根，例如：

`/mnt/d/mytools/openacme/<项目名>`

（Windows 资源管理器即 `D:\mytools\openacme\<项目名>`）

## 说明

- 平台配置、编制、任务状态仍在 WSL 的 `~/.openacme/`（不要挪走）
- 这里只放各项目的业务产物与代码
