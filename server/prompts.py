import json


def build_prompt(task_id, turn, user_text, papers):
    context = [{key: paper.get(key) for key in ('id', 'title', 'task_id', 'submission')} for paper in papers]
    return f'''你在 jlpt-study 长期工作区中处理个人 JLPT 学习任务。
先读取 README.md、AGENTS.md、jlpt-notes/README.md 与相关题卡；出卷遵守
.claude/skills/quiz-generate/SKILL.md，判卷遵守 .claude/skills/quiz-grade/SKILL.md。
用户通过自由文本指定操作、等级、卡片、题量、题型和目标试卷。不要猜测缺失信息；
目标不能唯一确定或流程要求确认时，向用户提问并保留已生成资料。
网页流程覆盖技能的提交步骤：禁止自行 git add、git commit 或 git push；不得修改正式语法卡、复习日期、历史作答。
出卷完成后不提交；由后台在整套判卷成果通过检查后统一提交本地 Git，绝不推送。
不要直接修改 attempts.jsonl；判卷按既有 schema 产生每题 attempts，交给后台幂等追加。
禁止改写用户已交卷答案。排序题仍按完整拼句是否自然计分。
每轮在 jlpt-notes/quizzes/web/{task_id}/turn-{turn}.json 写入 UTF-8 JSON 交接文件：
{{"task_id":"{task_id}","turn":{turn},"operation":"generate|grade|clarify", "message":"实际结果或问题",
 "slug":"试卷 stem", "requirements":{{"level":"N1–N5","count":实际题量,"cards":["目标卡号"],"sections":{{"form":题数,"order":题数,"cloze":题数}}}}}}
generate：通过技能全部步骤，用 quiz_pipeline.py 的同一 draft 最终渲染试卷、答案、题卡、manifest。
requirements 必须如实记录从用户提示词确定的条件；不擅自缩减或扩大。
grade：额外写入 submission_id（来自下列正式作答）、report（仓库相对路径）、
rows 数组（每项含 number、question_id、revision、item_type、selected_option、is_correct、uncertain、error_tags、date）和 score。
report 必须是技能要求的完整 Markdown 报告；全部题目含解析、考点、接续、意思，排序题含拼句。
正式作答文件位于 jlpt-notes/quizzes/web/submissions/<submission_id>.json 和对应 .txt；
.txt 使用技能的答案填写区 N-答案、*N-语序格式。以该文件作为唯一用户答案，勿改写空白试卷。
clarify：写 message；无需生成不存在的成果。CLI 文字中的“完成”不会代替后台文件校验。
只保留采用题源的最小证据，不提交临时 draft、运行日志或认证配置。

现有网页试卷及正式作答（空 submission 表示尚未交卷）：
{json.dumps(context, ensure_ascii=False)}

用户原始提示词：
{user_text}'''
