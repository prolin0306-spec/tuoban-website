# 官网作业录入云函数

唯一部署来源为 **tuoban-website/cloudfunctions/webHomework/**，部署参数在官网根目录的 `cloudbaserc.webHomework.json`。homework-manager 中的原云函数继续作为业务规则基准，不从那里部署 `webHomework`。

允许的 action 只有：

- `session`、`classes`、`workspace`：读取老师会话、获授权班级和工作台数据。
- `managedClasses`：按角色读取可管理班级及关联学生、作业本、计划数量。`boss` 可查看启用和停用班级，其他角色只读取获授权的启用班级。
- `createClass`：沿用小程序班级字段新增启用班级。`teacher` 新增时在同一事务内写入班级 `teacherIds` 和本人 `hw_teachers.classIds`；`boss` 可新增但不需要写个人班级权限；代班老师不能新增。
- `updateClass`：只更新获授权班级的名称、年级和审计字段，不允许浏览器修改任课老师或代班关系。
- `setClassActive`：只有 `boss` 可以停用或重新启用班级。停用前必须先停用该班全部学生；停用学生及其作业本、计划、记录继续保留，不物理删除数据。
- `students`：只读取获授权班级的 `hw_students`，支持班级与姓名筛选，并统计关联作业本及今天/未来计划状态。
- `createStudent`：只向获授权且可用的班级新增 `hw_students`。速度规则固定为小程序的 `slow=0.7`、`normal=1.0`、`fast=1.3`，默认 `normal`，默认启用。
- `updateStudent`：只更新姓名、年级、班级、速度等级/系数及审计字段。改班同时校验原班级和目标班级权限；存在今天或未来计划时拒绝改班。
- `setStudentActive`：只切换 `hw_students.isActive` 并写审计字段，不删除学生或任何历史作业数据。
- `createBook`：为获授权班级中的启用学生新增 `hw_homework_books`，字段和默认值沿用小程序 `books/add`；不自动改动计划。
- `createClassBooks`：一次输入后，在同一事务内为获授权班级的每名启用学生分别创建独立 `hw_homework_books`；最多 100 名学生，使用请求标识提供幂等重试，不共享完成量，也不自动生成或重建计划。
- `createBookList`：一次提交 1–20 组一一对应的作业名称、数量、单位和小程序作业本字段；为单个获授权学生或当前班级全部启用学生在同一事务内创建独立作业本，最多 300 本。请求标识保证重复提交幂等；不自动生成或重建计划。
- `workspace` 同时返回已登记作业本与当天计划；没有当天计划时，已登记作业仍可查看。`setBookComplete` 只允许在作业本从未产生计划或实际记录、完成量为 0 或总量时勾选整项完成；它只更新该作业本的 `completedAmount`，不伪造每日计划或记录。已有计划的作业继续用 `saveDailyRecord` 按对应日期录入。
- `generateTodayPlan`：显式为一个学生生成当天计划。复用小程序的工作日、剩余量和整数分配规则；当天任一计划已存在时整体拒绝，没有剩余任务时不产生成功写入，不删除或重建未来计划。
- `saveDailyRecord`：新增或更新学生当天同一作业本的唯一记录，同步 `hw_daily_plans.isCompleted` 和 `hw_homework_books.completedAmount`。重复保存按“新实际量 - 旧实际量”更新累计量；允许实际完成量为 0，未提交仍保持无记录状态。累计量必须位于 `0..totalAmount`。

每次请求从 CloudBase SDK 网关读取真实登录身份，再核对唯一启用的 `integration_teacher_links`、`hw_teachers` 状态与角色，以及 `classIds`/代班班级和学生归属。`boss` 沿用小程序规则访问全部可用班级，`teacher` 和 `substituteTeacher` 只访问本人班级与代班班级。浏览器不能指定老师身份、集合名或任意 action。所有写操作都在数据库事务内执行，写集合只限 `hw_teachers`、`hw_classes`、`hw_students`、`hw_homework_books`、`hw_daily_plans`、`hw_daily_records`，写字段由 repository 白名单约束。`hw_teachers` 只允许新增班级时更新当前老师的 `classIds` 和 `updatedAt`；浏览器不能指定老师或权限字段。记录、计划完成状态和作业本累计量在同一事务中提交或回滚。

学生新增、编辑和启停会写入 `updatedAt`、`operatorTeacherId`，新增另写 `createdAt`。停用学生后，作业本新增、今日计划生成和完成量录入都会因学生未启用而拒绝；重新启用不会重建或删除历史数据。官网不提供物理删除 action，也不更新 `hw_classes.studentCount`，避免学生写入跨集合后出现部分成功。

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
node tests/students-browser.mjs
node tests/classes-browser.mjs
```

浏览器测试需要 Node >=22 和本机 Chrome，使用临时浏览器配置并拦截所有非本地请求。部署前需再次核对生产索引、事务能力、Web 安全来源及数据库安全规则仍禁止浏览器直接写 `hw_*`。
