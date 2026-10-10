SKILLS = {
    'generate': ('出卷', 'quiz-generate'),
    'grade': ('判卷', 'quiz-grade'),
}


def build_prompt(operation, user_text):
    if operation not in SKILLS:
        raise ValueError('请选择出卷或判卷')
    label, skill = SKILLS[operation]
    return f'请使用{label} skill：.claude/skills/{skill}/SKILL.md\n\n{user_text}'
