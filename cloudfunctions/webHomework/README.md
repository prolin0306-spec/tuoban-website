# 官网作业录入云函数

唯一部署来源为 **tuoban-website/cloudfunctions/webHomework/**，部署参数在官网根目录的 `cloudbaserc.webHomework.json`。homework-manager 中的原云函数继续作为业务规则基准，不从那里部署 `webHomework`。

允许的 action 只有：

- `session`、`classes`、`workspace`：读取老师会话、获授权班级和工作台数据。
- `createBook`：为获授权班级中的启用学生新增 `hw_homework_books`，字段和默认值沿用小程序 `books/add`；不自动改动计划。
- `generateTodayPlan`：显式为一个学生生成当天计划。复用小程序的工作日、剩余量和整数分配规则；当天任一计划已存在时整体拒绝，没有剩余任务时不产生成功写入，不删除或重建未来计划。
- `saveDailyRecord`：新增或更新学生当天同一作业本的唯一记录，同步 `hw_daily_plans.isCompleted` 和 `hw_homework_books.completedAmount`。重复保存按“新实际量 - 旧实际量”更新累计量；允许实际完成量为 0，未提交仍保持无记录状态。累计量必须位于 `0..totalAmount`。

每次请求从 CloudBase SDK 网关读取真实登录身份，再核对唯一启用的 `integration_teacher_links`、`hw_teachers` 状态与角色，以及 `classIds`/代班班级和学生归属。浏览器不能指定老师身份、集合名或任意 action。所有写操作都在数据库事务内执行，写集合只限 `hw_homework_books`、`hw_daily_plans`、`hw_daily_records`，写字段由 repository 白名单约束。记录、计划完成状态和作业本累计量在同一事务中提交或回滚。

服务端“今天”固定按 `Asia/Shanghai`（UTC+08:00）换算，生成计划和未来日期校验不使用运行时默认时区。

纯计算规则抽取自 homework-manager：

- `cloudfunctions/common/planEngine.js`：`buildProjection`、`countWorkdays`、`distributeIntegers`、`buildAlerts`。
- `cloudfunctions/plans/index.js`：`calcPriorityScore`、红黄绿排序和完成状态。
- `cloudfunctions/books/index.js`：作业本字段、默认值、学生归属和启用状态。
- `cloudfunctions/plans/index.js`：记录字段、实际量取整、完成状态、作业本累计完成量。

小程序的 `generatePlan()` 会删除并重建今天起的计划，`books/add` 和 `plans/submit` 也会触发该重算。官网 V1 为保护已有计划，不调用这条写路径，只用相同算法算出当天第一份分配并写入当天；新增作业本和保存完成量也不会重建未来计划。

本地测试不会连接 CloudBase：

```sh
node --test tests/homework-api.test.js tests/webHomework.test.js
node tests/homework-browser.mjs
```

浏览器测试需要 Node >=22 和本机 Chrome，使用临时浏览器配置并拦截所有非本地请求。部署前需再次核对生产索引、事务能力、Web 安全来源及数据库安全规则仍禁止浏览器直接写 `hw_*`。
