"""Prompt templates and message builders for the news reader (spec section 5).

Only explained templates live here; no filled-in sample sentences, so the model has
nothing to copy. All answers are requested in Chinese.
"""

PRINCIPLES = '提示词里只放带说明的模板，不放填好具体句子的示例。所有回答使用中文。'

GLOSS_TEMPLATE = '''<gloss>
  <meaning>中文释义。最多两个义项，用「；」分隔，每个义项不超过 15 个字。
    助词、助动词写出它的主要功能。</meaning>
</gloss>'''

ANALYSIS_TEMPLATE = '''<analysis>
  <selection>
    <reading>选中部分的平假名读音</reading>
    <role>选中部分在句中的作用：修饰或说明哪个成分、起什么作用</role>
    <meaning>选中部分在本句中的中文意思</meaning>
  </selection>
  <translation>整句的通顺中文译文</translation>
  <grammar>
    <item related="true 或 false">
      <form>语法形式，例如 〜ている</form>
      <level>N5、N4、N3、N2、N1 之一</level>
      <brief>一句话说明功能，不超过 15 个字</brief>
      <connection>接续方式</connection>
      <usage>在本句中的具体用法和意思</usage>
      <confusable>容易混淆的形式及区别；没有就省略这个标签</confusable>
    </item>
  </grammar>
</analysis>

规则：没有选中部分时不输出 `<selection>`；语法覆盖 N5 到 N1，按在句中出现的顺序排列；与选中部分相关的标 `related="true"` 并排在最前；标签之外不写任何内容。'''

ASK_INSTRUCTIONS = ('回答用中文普通文字，不套模板、不用 XML 标签。要求简短；'
                    '能举例时给一个对比例句。')

MAX_HISTORY_ROUNDS = 6


def gloss_messages(lemma, reading, pos):
    system = ('你是日语词典助手，服务于日语学习者。%s\n请严格按下面的模板回复，不要输出模板之外的内容：\n%s'
              % (PRINCIPLES, GLOSS_TEMPLATE))
    user = '词典形：%s\n读音：%s\n词性：%s' % (lemma, reading, pos)
    return [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]


def analysis_messages(paragraph, sentence, selection):
    system = ('你是日语老师，帮助日语学习者读懂新闻句子。%s\n请严格按下面的模板回复：\n%s'
              % (PRINCIPLES, ANALYSIS_TEMPLATE))
    lines = ['所在段落：', paragraph, '', '原句：', sentence]
    if selection:
        lines += ['', '选中部分：', selection]
    return [{'role': 'system', 'content': system}, {'role': 'user', 'content': '\n'.join(lines)}]


def ask_messages(sentence, selection, analysis_text, history, question):
    lines = ['你是日语老师，正在和日语学习者讨论一个新闻句子。%s' % PRINCIPLES, ASK_INSTRUCTIONS,
             '', '原句：', sentence]
    if selection:
        lines += ['', '选中部分：', selection]
    if analysis_text:
        lines += ['', '已给出的分析：', analysis_text]
    msgs = [{'role': 'system', 'content': '\n'.join(lines)}]
    for item in (history or [])[-MAX_HISTORY_ROUNDS:]:
        msgs.append({'role': 'user', 'content': item['q']})
        msgs.append({'role': 'assistant', 'content': item['a']})
    msgs.append({'role': 'user', 'content': question})
    return msgs
