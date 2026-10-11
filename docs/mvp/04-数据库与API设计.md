# 声音时间机器｜数据库与 API 设计

版本：v0.1｜日期：2026-10-11｜逻辑设计与接口契约草案，非已部署数据库或可直接执行的迁移脚本。

与 01–03 文档共用同一 MVP 基线。所有写操作的主体由服务端凭证解析，禁止客户端提交 user_id 来决定数据归属。P1 接口仅在微信能力启用后提供。

## 1. 通用类型与约定

- 主键：服务端生成 UUID；接口以字符串表示。
- 年代 `era`：`1970s | 1980s | 1990s | 2000s`；展示文字为 70／80／90／00 年代。`all` 仅用于查询和偏好，不写入节目的 era。
- 类型 `category`：`news | storytelling | novel | opera`；`all` 同样仅为查询值。
- 来源 `source_kind`：`archive_original | modern_performance | ai_reconstruction`。
- 内容状态：`draft | in_review | published | offline`；媒体状态：`processing | ready | failed`。
- 时间：数据库 UTC timestamp，API ISO 8601；业务日报按配置的 Asia/Shanghai 转换。
- 时长与进度统一整数毫秒，字段后缀 `_ms`；前端自行格式化分钟，避免“20分钟”混入计算。
- 标准分页 `cursor`＋`limit`，默认 20、最大 100；返回 `next_cursor`，不存在为 null。
- 成功包：`{data, request_id}`；失败包：`{error:{code,message,retryable},request_id}`。队列无候选属于可预期业务结果，不作为服务器异常。

## 2. 逻辑数据表

### 2.1 身份、偏好与行为关系

| 表 | 核心字段 | 约束／索引 |
|---|---|---|
| principals | id、kind(guest/account)、created_at、deleted_at | 逻辑主体；不存明文会话凭证 |
| auth_sessions | id、principal_id、token_hash、expires_at、revoked_at | token_hash 唯一；principal_id 索引；凭证仅 cookie 传输 |
| external_identities（P1） | id、principal_id、provider、app_id、openid_ciphertext、openid_lookup_hash | unique(provider,app_id,openid_lookup_hash)；敏感值受控保存 |
| identity_links（P1） | guest_principal_id、account_principal_id、linked_at、merge_version | guest 唯一，禁止重绑不同账号 |
| preferences | principal_id、era、category、tuning_sound_enabled、analytics_enabled、updated_at | principal_id 主键；默认 all/all/false，分析偏好按实际同意方案初始化 |
| likes | principal_id、program_id、created_at | 复合主键；取消即删除当前关系；事件独立保留 |
| feedback | id、principal_id、program_id、playback_id、prompt_id、answer、created_at | unique(principal_id,prompt_id)；answer 为 like/neutral |
| feedback_prompts | id、principal_id、session_id、program_id、playback_id、trigger、issued_at、shown_at、dismissed_at | 同 session 最多一个；24 小时频控；shown_at 由确认曝光写入 |
| deletion_jobs | id、principal_id、status、requested_at、finished_at | 清除请求幂等；状态 pending/running/done/failed |

收藏查询合并已绑定主体时只返回有效唯一节目；账号绑定事务将游客收藏并入账号并清理游客关系，防止双计。历史事件仍保留原主体 ID，通过映射解释，不复制事件。

### 2.2 内容与媒体

| 表 | 核心字段 | 约束／索引 |
|---|---|---|
| audio_assets | id、object_key、mime_type、bytes、duration_ms、checksum、status、created_at | object_key 唯一；时长 >0；校验真实媒体元数据 |
| programs | id、title、era、category、audio_asset_id、source_kind、event_year、work_year、recording_year、era_basis、source_note、is_excerpt、excerpt_label、status、starter_pool、published_at、updated_at | status/era/category 联合索引；未知年份允许 null；不编造具体年份 |
| program_sources | id、program_id、source_url、source_title、source_type、checked_by、checked_at | 一个节目可有多个来源；链接只允许安全协议 |
| program_clearances | id、program_id、usage_basis、evidence_ref、valid_from、valid_until、checked_by、checked_at | 发布至少一条有效审核记录；依据附件不公开给游客 |
| program_reviews | id、program_id、script_version、decision、notes、reviewer_id、created_at | 记录资料与音频审核；AI 重制保留稿件版本 |
| admin_users | id、login_identity、role、disabled_at | 独立运营认证；role 为 editor/reviewer/admin |
| audit_logs | id、admin_id、action、entity_id、before_summary、after_summary、created_at | 追加写；无密钥、音频签名 URL |

`likeCount` 不作为节目主表权威计数，按 likes 聚合或生成可重建缓存。tags 可用简单 JSON 字符串数组，不作为本期检索条件。公开节目对象不包含存储路径、审核附件和身份信息。

### 2.3 队列与播放

| 表 | 核心字段 | 约束／索引 |
|---|---|---|
| listening_sessions | id、principal_id、started_at、last_active_at、entry_source、environment、analytics_enabled | principal_id/started_at 索引；30 分钟规则见 01 |
| queues | id、principal_id、session_id、era、category、round_no、position、last_program_id、expires_at | 每次选择范围生成新队列 |
| queue_items | queue_id、round_no、position、program_id | 复合主键；一轮内 program 不重复 |
| queue_requests | queue_id、request_id、response_payload、created_at | 复合唯一；事务内消费队列和记录响应 |
| playbacks | id、principal_id、session_id、queue_id(nullable)、program_id、era_snapshot、category_snapshot、started_at、ended_at、end_reason、max_seq、listen_ms、observed_wall_ms、last_position_ms | principal/session/program 索引；统计用快照避免内容后续改标签改写历史 |
| playback_day_totals | playback_id、business_date、listen_ms | 复合主键；与进度接受事务一起累加，用于跨日统计 |
| play_attempts | id、playback_id、trigger、requested_at、started_at、status、error_code | id 唯一；trigger 为 user/autonext/retry；成功按实际开始事件更新 |
| analytics_events | event_id、principal_id、session_id、playback_id(nullable)、attempt_id(nullable)、name、client_at、received_at、environment、payload | event_id 唯一；name/received_at 和 session 索引；payload 白名单 |

queues 的初次创建另外按 principal_id＋request_id 做幂等记录，可使用统一 idempotency_keys 表；同 key 不同请求体返回冲突。队列取下一条采用行锁或事务条件更新，避免并发消费两条。

聚合日报可用物化查询或小表按日期／维度存 exposure、starts、listen_ms、listeners、likes、switches；保留 report_version。不要存仅能累加、不能复算的排行榜。

### 2.4 删除策略

删除节目用 offline，不级联删除历史播放。用户清除数据撤销会话、停止本地待发事件、删除偏好收藏和身份映射，并按主体删除或不可逆匿名化分析记录；无法重新识别的聚合可按产品确认策略保留。备份在已确认的生命周期内过期，并使用删除记录防止恢复后重新上线旧个人数据。删除完成时不保留可反查原身份的“匿名”映射。

## 3. API 清单

前缀 `/api/v1`，同源 HTTPS。游客初始化以外接口按需校验会话；公开节目详情允许匿名读取但不能修改数据。所有运营接口另需运营权限。

| 方法与路径 | 请求关键项 | 返回／行为 |
|---|---|---|
| POST `/guest-session` | 无主体 ID | 设置游客 cookie，返回偏好与功能开关；已有有效会话则复用 |
| POST `/listening-sessions` | entry_source、environment（服务端最终判定）、resume_session_id 可选 | 返回 session_id；服务端验证归属及 30 分钟窗口 |
| GET `/me` | cookie | principal_kind、preferences、feature_flags，不返回 openid |
| GET `/catalog` | 可选 era | 已开放年代、类型、组合及数量，服务端上架过滤 |
| GET `/programs/:id` | 节目 ID | 公开元信息；不可用返回 CONTENT_UNAVAILABLE |
| POST `/queues` | session_id、era、category、request_id、mode(today/era) | 新队列和第一条，或 NO_CONTENT |
| POST `/queues/:id/next` | request_id、reason(manual/ended) | 下一条或 NO_ALTERNATIVE；校验队列主体 |
| POST `/playbacks` | program_id、session_id、queue_id 可选、request_id | playback_id、媒体 URL／有效期；验证可播放与归属 |
| POST `/playbacks/:id/attempts` | attempt_id、trigger | 幂等登记播放尝试 |
| POST `/playbacks/:id/progress` | seq、cumulative_listen_ms、observed_wall_ms、position_ms、state、sampled_at | 返回 accepted_seq；只累计新增的可信部分 |
| POST `/playbacks/:id/end` | request_id、reason、最终 progress | 幂等结算；重复结束不多计时长 |
| POST `/playbacks/:id/media-refresh` | 无 | 检查上架后更新媒体 URL，不新建播放记录 |
| PUT `/me/preferences` | 完整 era/category/sound/analytics 设置 | 返回完整偏好，服务器校验枚举与可用性 |
| GET `/me/likes` | cursor、limit | 收藏列表；下架项只返回必要占位信息 |
| PUT `/me/likes/:programId` | 无 | 设置喜欢，幂等；新收藏仅对已发布节目开放 |
| DELETE `/me/likes/:programId` | 无 | 取消喜欢，幂等；下架也可取消 |
| POST `/feedback-prompts` | playback_id、trigger(ended/long_listen) | 可测用户校验时长和频控，返回 prompt 或 null；关闭分析时使用本地触发、服务端仅频控，不长期记录收听时长 |
| POST `/feedback-prompts/:id/shown` | 无 | 确认真实曝光，幂等 |
| POST `/feedback-prompts/:id/dismiss` | 无 | 标记忽略，幂等 |
| PUT `/feedback-prompts/:id/answer` | answer(like/neutral) | 写入或覆盖同 prompt 回答；节目取自 prompt |
| POST `/events/batch` | events，最多 50 条、总量 ≤64KB | 返回 accepted/duplicate/rejected 的 event_id 与错误码 |
| POST `/me/deletion-requests` | request_id、confirmed=true | 202 和 job_id；确认来自 UI，不能代替权限校验 |
| GET `/me/deletion-requests/:id` | 短期删除回执凭证 | 仅查本人任务状态；凭证不进入 URL 或分析事件 |
| POST `/auth/logout` | 无 | 撤销会话；前端清理后建立新游客 |

注销与数据清除均不要求先有微信账号。清除返回的短期回执仅可查结果，不可访问已删除主体数据；执行完成后失效。

### 3.1 微信 P1

| 方法与路径 | 功能与约束 |
|---|---|
| GET `/auth/wechat/start?return_to=...` | 生成 state 并跳转；return_to 限本站白名单 |
| GET `/auth/wechat/callback` | 服务端验证 state、交换身份、事务合并、设置 cookie、跳回原页 |
| GET `/wechat/sdk-config?url=...` | 仅为本站允许 URL 生成配置；不返回私密 token；失败不阻断基础分享 |

接口为方案草案，具体平台参数和可用权限须在 W1 按账号核验。没有权限时 feature_flags 关闭，不以假的成功响应代替。

### 3.2 运营接口

| 方法与路径 | 功能 |
|---|---|
| POST `/admin/uploads` | 文件名、mime、大小；获得受限上传目标与 asset_id |
| POST `/admin/uploads/:assetId/complete` | 校验对象存在、大小、格式与时长，状态 ready/failed |
| POST `/admin/programs` | 新建草稿与来源记录 |
| PATCH `/admin/programs/:id` | 编辑，携带 version 防止覆盖他人修改 |
| POST `/admin/programs/:id/submit` | 送审并冻结该次审查版本 |
| POST `/admin/programs/:id/review` | reviewer/admin 给出 approve/reject；变更音频或关键资料后须重审 |
| POST `/admin/programs/:id/publish` | 校验最新版本已通过、媒体就绪、依据有效后上架 |
| POST `/admin/programs/:id/offline` | 下架、失效队列候选、清可控缓存并审计 |
| GET `/admin/programs` | 草稿／审核／发布状态列表 |
| GET `/admin/reports/daily` | date_from、date_to、dimension；返回口径版本、样本和指标 |
| GET `/admin/reports/export` | 与日报同口径 CSV；防公式注入，不导出凭证或外部身份原值 |

运营认证沿用现有内部账号系统（如有），否则开工时选用受控认证方案；不能仅靠隐藏路由或前端密码。账号配置是部署前置，不视作已经存在。

## 4. 关键契约示例

以下 ID 为说明用占位符，开发时由服务端生成，example.invalid 不是可播放媒体。

创建队列请求：

```json
{
  "session_id": "session-example",
  "request_id": "request-example",
  "mode": "era",
  "era": "1980s",
  "category": "storytelling"
}
```

成功响应：

```json
{
  "data": {
    "queue_id": "queue-example",
    "result": "PROGRAM",
    "program": {
      "id": "program-example",
      "title": "经典评书节选（示例）",
      "era": "1980s",
      "category": "storytelling",
      "duration_ms": 720000,
      "source_kind": "modern_performance",
      "display_year": null,
      "source_note": "现代演绎，按已审核的记忆年代归类",
      "is_liked": false
    }
  },
  "request_id": "request-example"
}
```

无内容返回 HTTP 200、`data.result="NO_CONTENT"`、`program=null`；没有另一条为 `NO_ALTERNATIVE`。服务器故障用 5xx，不能混成空库；前端据 result 显示不同恢复方式。

创建 playback 后返回 `playback_id`、`audio_url`、`expires_at`、`duration_ms`。拿到地址不代表开始成功；前端仍需创建 attempt 并等待真实媒体事件。

进度请求：

```json
{
  "seq": 3,
  "cumulative_listen_ms": 27400,
  "observed_wall_ms": 28000,
  "position_ms": 27400,
  "state": "playing",
  "sampled_at": "2026-10-11T08:00:28Z"
}
```

事件请求：

```json
{
  "events": [{
    "event_id": "event-example",
    "session_id": "session-example",
    "playback_id": "playback-example",
    "attempt_id": "attempt-example",
    "name": "play_started",
    "client_at": "2026-10-11T08:00:00Z",
    "payload": {"trigger": "user", "position_ms": 0}
  }]
}
```

服务端根据 cookie 补充 principal_id、received_at 与 environment；校验 playback、attempt 属于 session 和主体。客户端时间超出允许偏差时标记 clock_skew，日报采用服务端时间；不得靠修改客户端日期伪造回访。

## 5. 幂等、事务与错误码

收藏 PUT／DELETE、反馈 PUT 天然幂等；队列、播放创建、删除请求带 request_id，幂等键默认保留 24 小时。请求体与已使用 key 不同返回 IDEMPOTENCY_CONFLICT，不复用旧响应。

play_started 事件 event_id 去重后，按 attempt_id 只允许从 pending 到 started 一次。事件到达早于 attempt 时返回可重试依赖错误，客户端先重试创建；progress 可以排队重试，不通过补造播放开始事件修补统计。

身份合并、队列消费、收藏修改及其服务端 like_set 事件分别在事务中完成。收听进度更新使用条件判断 max_seq，单调累计回退的包拒绝；重复 seq 返回上次接受结果。

| HTTP | code | 处理 |
|---|---|---|
| 400 | INVALID_ARGUMENT | 展示可理解错误，记录字段错误，不重试原错误请求 |
| 401 | SESSION_EXPIRED | 重新建立游客或提示重新登录；不把旧主体待写数据转给新游客 |
| 403 | FORBIDDEN | 停止操作，不降级绕过权限 |
| 404 | CONTENT_UNAVAILABLE | 展示下架／不可用，并可回首页 |
| 409 | IDEMPOTENCY_CONFLICT / VERSION_CONFLICT | 不自动覆盖，刷新并重试新操作 |
| 409 | DEPENDENCY_NOT_READY | 先完成 attempt 等前置后有限重试 |
| 410 | QUEUE_EXPIRED | 使用原选择重建队列并提示 |
| 429 | RATE_LIMITED | 按 Retry-After 等待，可恢复按钮 |
| 503 | SERVICE_UNAVAILABLE | 提供重试，不显示空库 |

媒体文件失败属于客户端播放错误，记录稳定的标准分类 `policy_blocked/network/decode/unavailable/unknown`，不把包含签名 URL 的原始错误直接上传。

## 6. 埋点字典与统计事实来源

| 名称 | 何时记录 | 必要维度／去重 |
|---|---|---|
| session_open | session 创建成功且页面可见 | session_id、entry_source；一次 session 只一次 |
| content_impression | 节目卡／详情进入可见区域 | program_id、surface、exposure_id；同次可见去重 |
| play_attempt | 主动、接播或重试启动 | attempt_id、trigger；服务端 attempts 权威 |
| play_started | 媒体真实推进 | attempt_id；恢复可记新 attempt，playback 不重复创建 |
| play_blocked/error | 启动受阻／媒体错误 | attempt_id、标准原因；策略限制和网络分开 |
| play_progress/end | 周期进度／终止 | playback_id、seq；playbacks 中 accepted 值权威 |
| channel_change | 用户按换台或确认新范围 | old/new program、原因；自动结束接播单列 |
| like_click | 用户点击按钮 | program_id、目标状态；次数可多次 |
| like_set | 服务端状态实际改变 | program_id、liked；幂等重试不新计 |
| feedback_impression/submit | 确认可见／回答成功 | prompt_id；反馈表权威 |
| share_click/copy | 用户发起／复制成功 | program_id 可空、方式；不推断发送成功 |
| share_landing | 带 src=share 链接打开 | program_id 可空；不携带分享者身份 |

播放时长使用 accepted progress，不从 play_started 到 end 的时间差估算。喜欢当前净数使用 likes；喜欢行为率使用历史 like_set 并限定为有效听众。曝光不是播放，分享点击不是发送，session_open 不是有效收听。

### 6.1 统计复算样例（验收用）

测试数据设 4 个可测身份 A/B/C/D 在同一业务日首次打开，A/B 在首开 60 秒内成功播放，C 次日才播放，D 未播放：首次打开播放成功率为 2/4。

A 的某 playback 依次上报累计 10 秒、20 秒、重复 20 秒、乱序 10 秒、结束累计 25 秒：总计 25 秒，不能加成 75 秒。若 pause 持续 60 秒而累计仍为 25 秒，总时长保持 25 秒。

次日只有 A/C 再次打开且观察窗口完整：D1 再打开率 2/4；仅 A 次日累计听满 30 秒：D1 有效收听率 1/4。跨午夜 session 的打开按实际打开日、进度按每个被接受包的 sampled_at 对应业务日归档到 playback_day_totals，不把整段收听都记在开始日。每包新增量全部归到该采样日，日界误差通常不超过一个上报周期；丢包／乱序可能扩大误差，报表需标注估计口径。sampled_at 必须落在 playback 创建之后、接收时间之前（允许约定时钟容差），过期超过 24 小时或时钟异常的数据单列为无法可靠归日，不纳入 D1 有效收听判定。D1 再次打开必须真的发生新打开，持续播放跨午夜本身不算再次打开。

节目有效听众为 A/B，只有 A 曾设喜欢且 B 只点击后接口失败：喜欢率 1/2。A 后来取消，当前净收藏为 0，但历史喜欢行为率仍 1/2。两个指标必须分列。

这些是测试数据而非真实结果。所有成功指标需同时显示分母人数、观测周期与 analytics 可测覆盖率。

## 7. 开发交接清单

开工后将本契约转成 OpenAPI／共享类型，并生成 mock；数据库实现补齐具体 SQL、迁移版本、默认值、索引和约束。前后端先以首播、换台、喜欢三个路径联调，再加分析与 P1。

必须验证：任何用户 ID 篡改不生效；不同 cookie 不能访问他人队列／删除任务；重复请求不多计时长或收藏；下架不再进入新播放；登录绑定不复制事件；用户清除后本地队列停止上传；测试环境数据不进入生产报表。

待细化但不改变产品范围的实施项：最终框架及运行时版本、具体存储服务、认证实现、数据迁移工具、媒体检验组件、实际运营账号配置与监控平台。以上不应通过编造现有基础设施来补齐。
