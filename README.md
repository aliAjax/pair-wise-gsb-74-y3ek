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
- `src/services/selectors.ts`：契约比较（含平台规则）、影响分析和校验规则
- `src/services/contractVersion.ts`：契约指纹（属性 + 平台规则）、平台差异比较与版本归属判定
- `src/services/releaseWorkflow.ts`：候选创建、契约更新后的失效重算、重复版本提交与发布门禁
- `src/services/repository.ts`：localStorage 原子提交（暂存键 + 回读校验 + 崩溃前滚恢复）与旧数据版本指纹回填

## 发布一致性约束

- 属性或平台规则保存后，覆盖该事件的评审中候选立即按契约指纹判定为失效；首次打开评审窗口时差异、受影响依赖和迁移确认全部重算，旧审批与旧迁移确认归档到 `history`，不再放行。
- 两个窗口并行提交同一版本号时，最早进入评审的候选放行，其余候选标记为 `duplicateOf` 重复记录，展示“契约已更新”说明并保留事件范围与提交时间。
- 状态写入采用“暂存键 → 完整性校验 → 替换正式键”的原子提交：写到一半崩溃后，下次加载前滚完整暂存或回退到已提交版本，契约快照与依赖状态不会只写一半。
- 旧数据（无 `schemaVersion`/版本指纹）首次打开时按当前契约回填事件指纹；无实质差异的候选固化当前指纹，仍有差异的候选留待首次打开时重算。迁移确认始终携带 `version`，只对所属版本有效。

## 测试

```bash
npm test
```
