## 网页练习交接规则

此节适用于网页启动的当前轮次，覆盖出卷／判卷 skill 中的提交与历史追加步骤。
每轮先读取 `jlpt-notes/quizzes/web/current-turn.json`，不可沿用对话历史中的任务编号或轮次。
其中 `task_id`、`turn`、`operation`、`handoff` 指定本轮身份、选定操作和交接路径；
`papers` 列出网页试卷及正式作答，空 submission 表示尚未交卷。
用户指定等级、卡片、题量、题型和目标试卷；目标不能唯一确定或流程要求确认时，向用户提问并保留已生成资料。

禁止自行 git add、git commit 或 git push；不得修改正式语法卡、复习日期、历史作答。
出卷完成后不提交；由后台在整套判卷成果通过检查后统一提交本地 Git，绝不推送。
不要直接修改 attempts.jsonl；判卷按既有 schema 产生每题 attempts，交给后台幂等追加。
禁止改写用户已交卷答案。排序题仍按完整拼句是否自然计分。

每轮在当前上下文的 `handoff` 路径写入 UTF-8 JSON 交接文件：
`task_id` 与 `turn` 取本轮上下文的值，`operation` 为 `generate`、`grade` 或 `clarify`，
`message` 写实际结果或问题；出卷／判卷的 `slug` 写试卷 stem。

generate：通过技能全部步骤，用 quiz_pipeline.py 的同一 draft 最终渲染试卷、答案、题卡、manifest。
`requirements` 必须如实记录从用户提示词确定的条件，不擅自缩减或扩大；包含
`level`（N1–N5）、`count`（实际题量）、`cards`（目标卡号数组）、
`sections`（form、order、cloze 各自题数）。

grade：额外写入 `submission_id`（来自正式作答）、`report`（仓库相对路径）、`score` 和
`rows` 数组（每项含 number、question_id、revision、item_type、selected_option、is_correct、uncertain、error_tags、date）。
report 必须是技能要求的完整 Markdown 报告；全部题目含解析、考点、接续、意思，排序题含拼句。
正式作答文件位于 `jlpt-notes/quizzes/web/submissions/<submission_id>.json` 和对应 `.txt`；
`.txt` 使用技能的答案填写区 N-答案、*N-语序格式。以该文件作为唯一用户答案，勿改写空白试卷。

clarify：写 message；无需生成不存在的成果。CLI 文字中的“完成”不会代替后台文件校验。
只保留采用题源的最小证据，不提交临时 draft、运行日志、网页工作区规则或认证配置。
