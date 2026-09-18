# 官网只读作业云函数

后续唯一部署来源为 **tuoban-website/cloudfunctions/webHomework/**，配置为官网根目录的 `cloudbaserc.webHomework.json`。homework-manager 中旧副本保留作参考，不应再从该副本部署同名函数。线上函数应始终使用该目录和配置发布。

仅支持 `session`、`classes`、`workspace`。每个请求通过平台身份、启用中的老师映射、老师角色和班级权限检查。作业业务数据只读 `hw_*`；`integration_teacher_links` 仅作为既有设计中的身份映射读取，不写入。禁止匿名调用、客户端指定老师身份、任意集合和写入 action。

上线前需要人工核实官网域名已加入 CloudBase Web 安全来源，并核对 CloudBase 用户与 `hw_teachers` 的关联、班级/代班权限、数据库索引和已有规则。映射字段为 `authUid`、`authEnvId`、`homeworkEnvId`、`homeworkTeacherId`、`status: active`；两个环境字段必须与函数实际环境一致。`WEB_HOMEWORK_ENV_ID` 也必须匹配实际环境。不提供自动建表、初始化数据或修复脚本。

预警和优先级纯计算来源：homework-manager 的 `cloudfunctions/plans/common/planEngine.js` 中 `buildProjection`、`countWorkdays`、`buildAlerts`，以及 `cloudfunctions/plans/index.js` 中 `calcPriorityScore`。没有引入原计划引擎、调用 `plans.today` 或生成计划。工作日以中国日期为输入，用 UTC 日期算术避免服务端时区差异。

优先级公式：`0.5*risk + 0.3*min(risk*0.6,1) + 0.1*urgency + 0.1*capacityGap`，保留两位小数。颜色按配置的预计完成率阈值，容量预警另列；同色按分数降序，未知排末位。缺失可选阈值/容量沿用小程序默认值 0.8、0.6、40；无有效学期开始日期不虚构优先级。历史日期没有当时进度快照，不提供学期预测或优先级。

实际完成率为所选日计划任务的实际负载 / 计划负载；任一计划任务未记录、重复或数据不足时不展示数值。没有计划只提示“尚未生成计划”，实际记录仍可查看。刷新、日期/班级筛选只调用读取接口；退出仅注销认证会话，不写业务集合。

本地测试（模拟数据库，不连接云端）：

```sh
node --test tests/homework-api.test.js tests/webHomework.test.js
node tests/homework-browser.mjs
```

浏览器测试需要 Node >=22 和本机 Chrome，使用临时浏览器配置，拦截非本地请求。发布后仍需从 GitHub Pages 正式域名验证 Web 安全来源、登录会话和只读查询链路。
