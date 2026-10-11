"""Short extractive conversation titles derived from the first user message."""
import re


def summarize_first_message(text):
    text = str(text or '').strip()
    text = re.sub(r'^(?:(?:你好[，,：:\s]*|请问|请|麻烦|帮我|帮助我|为我|给我)\s*)+', '', text)
    sentence = re.split(r'[。！？\n]|(?<=[.!?])\s+', text, maxsplit=1)[0]
    sentence = re.sub(r'\s+', ' ', sentence).strip('，,；;：:。.!? ')
    clause = re.split(r'[，,；;]', sentence, maxsplit=1)[0].strip()
    if len(clause) >= 4:
        sentence = clause
    if re.fullmatch(r'介绍(?:一下)?(?:你自己|自己)', sentence):
        return '智能体介绍'
    if re.fullmatch(r'你(?:现在|当前)?(?:是|用的|使用的)?(?:什么|哪个|哪一个)模型', sentence):
        return '模型介绍'
    match = re.fullmatch(r'(推荐|介绍|解释|总结)(?:一下)?\s*(.{2,})', sentence)
    if match:
        sentence = match[2].strip() + match[1]
    if not sentence:
        return '未命名对话'
    return sentence if len(sentence) <= 26 else sentence[:25].rstrip() + '…'
