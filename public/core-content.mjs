// Keep source notes intact; collapse only surplus empty paragraphs for display.
export function normalizeCoreMarkdown(source = '') {
  const lines = [];
  let fence = null;
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const run = marker[1];
      if (!fence) fence = run;
      else if (run[0] === fence[0] && run.length >= fence.length && !line.slice(marker[0].length).trim()) fence = null;
    } else if (!fence && !line.trim()) {
      if (lines.length && lines.at(-1) !== '') lines.push('');
      continue;
    }
    lines.push(line);
  }
  if (!fence && lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

const FUNCTION_NUMBER = '一二三四五六七八九十百零〇两\\d';
const FUNCTION_HEADING = new RegExp(`^( {0,3}#{1,6}[ \\t]+)功能\\s*[${FUNCTION_NUMBER}]+`);
// 功能 headings as displayed: bare “功能” (the only function) or “功能一 1/3”.
const FUNCTION_LABEL = new RegExp(`^功能(?:\\s*[${FUNCTION_NUMBER}]+(?: \\d+/\\d+)?|(?=[：:（(]|$))`);

function chineseNumber(n) {
  const digits = '零一二三四五六七八九';
  if (n < 10) return digits[n];
  return `${n >= 20 ? digits[Math.floor(n / 10)] : ''}十${n % 10 ? digits[n % 10] : ''}`;
}

// The notes keep “功能一”, “功能二” as written; the display shows 功能 alone for a single
// function and “功能一 1/3” when there are several, so the label never goes stale.
export function labelCoreFunctions(source = '') {
  const lines = source.split('\n');
  const found = [];
  let fence = null;
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const run = marker[1];
      if (!fence) fence = run;
      else if (run[0] === fence[0] && run.length >= fence.length && !line.slice(marker[0].length).trim()) fence = null;
    } else if (!fence && FUNCTION_HEADING.test(line)) found.push(index);
  }
  for (const [order, index] of found.entries()) {
    const label = found.length === 1 ? '功能' : `功能${chineseNumber(order + 1)} ${order + 1}/${found.length}`;
    lines[index] = lines[index].replace(FUNCTION_HEADING, (_, prefix) => prefix + label);
  }
  return lines.join('\n');
}

export function renderCoreContent(content, navigation, source, renderMarkdown) {
  // Clear our annotations before React reuses heading elements for another card.
  for (const target of content.querySelectorAll('[data-core-function]')) {
    target.removeAttribute('id');
    target.removeAttribute('data-core-function');
    target.classList.remove('core-function-target');
  }
  renderMarkdown(content, labelCoreFunctions(normalizeCoreMarkdown(source)));
  navigation.replaceChildren();
  const headings = [...content.querySelectorAll('h1, h2, h3, h4, h5, h6')]
    .filter(target => FUNCTION_LABEL.test(target.textContent));
  navigation.hidden = headings.length === 0;
  for (const [index, target] of headings.entries()) {
    const title = target.textContent;
    target.id = `core-function-${index + 1}`;
    target.dataset.coreFunction = String(index + 1);
    target.classList.add('core-function-target');

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = FUNCTION_LABEL.exec(title)[0];
    button.title = title;
    button.setAttribute('aria-label', `跳转到${title}`);
    button.setAttribute('aria-controls', 'card-core');
    button.addEventListener('click', () => {
      const padding = parseFloat(getComputedStyle(content).paddingTop);
      content.scrollTop += target.getBoundingClientRect().top - content.getBoundingClientRect().top - content.clientTop - padding;
    });
    navigation.append(button);
  }
  content.scrollTop = 0;
}
