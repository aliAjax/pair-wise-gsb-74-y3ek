# EventRail 多端埋点事件治理与发布评审平台

基于 Vue 3、TDesign、Pinia、Vue Router、TanStack Query、Axios、Vite 与 TypeScript 的独立前端工程。项目使用 Axios 自定义本地适配器模拟契约 API，查询缓存由 TanStack Query 管理，业务编辑状态由 Pinia 持久化到浏览器 `localStorage`。

## 功能

- 按业务域维护事件树、多端触发规则、属性和负责人
- 属性类型、枚举、必填条件、同义字段和跨事件血缘
- 重复事件、同义属性、命名越界、类型变化与删除字段引用检查
- JSON 示例的类型、枚举和必填规则校验
- 发布候选契约比较、受影响下游依赖和迁移确认
- 数据、产品、客户端和测试四角色批量审批与发布门禁
- 事件废弃计划、替代事件和迁移说明
- 发布回滚记录与结果验证
- JSON 契约和 Markdown 契约文档导出

## 运行

```bash
npm install
npm run dev
```

默认开发地址为 `http://localhost:18474`。

## 构建

```bash
npm run build
```

## 数据层

- `src/services/api.ts`：Axios 实例与本地 API 适配器
- `src/composables/useGovernanceQueries.ts`：TanStack Query 查询组合
- `src/stores/governance.ts`：Pinia 编辑、审批、废弃和回滚状态
- `src/services/selectors.ts`：契约指纹、契约比较、影响分析和校验规则
- `src/services/repository.ts`：带暂存区（journal）的原子持久化、崩溃恢复与跨窗口同步
- `src/services/migrate.ts`：旧数据首次打开时回填契约版本指纹

## 发布评审一致性约定

- **契约指纹**：发布候选保存属性与平台规则（名称/类型/必填/枚举、触发时机、平台必填属性）的 FNV 指纹。评审期间属性或平台规则一变，候选差异、受影响依赖、迁移清单自动重算；旧审批与已确认迁移标记作废（保留处理记录），门禁不再放行，需按当前版本重新审批。
- **同版本并发提交**：两个窗口同时提交同一版本时，只放行最先提交的一份；另一窗口不创建候选，只追加“契约已更新、本次提交不再放行”的审计记录，并自动切到已放行的候选。
- **写入原子性**：所有状态（含发布时写入的契约快照与下游依赖状态）先写暂存区再覆盖提交区。写入中途失败后刷新页面会按暂存区自动恢复，不会只写一半。开发环境可在控制台执行 `__eventrailDebug.crashOnNextWrite('journal' | 'commit')` 演示，`__eventrailDebug.storage()` 查看暂存区状态。
- **旧数据回填**：没有版本指纹的历史数据，在首次打开时按当时的契约回填指纹；不属于候选当前版本的迁移确认一律作废，迁移确认只对当前版本有效。
- 可运行 `node scripts/verify-release-invariants.mjs` 验证上述一致性不变量。
