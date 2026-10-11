SKILLS = {
    'auto': ('对话', None),
    'generate': ('出卷', 'quiz-generate'),
    'grade': ('判卷', 'quiz-grade'),
}


def build_prompt(operation, user_text):
    if operation not in SKILLS:
        raise ValueError('不支持的对话操作')
    return user_text
