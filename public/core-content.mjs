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

export function renderCoreContent(content, navigation, source, renderMarkdown) {
  // Clear our annotations before React reuses heading elements for another card.
  for (const target of content.querySelectorAll('[data-core-function]')) {
    target.removeAttribute('id');
    target.removeAttribute('data-core-function');
    target.classList.remove('core-function-target');
  }
  renderMarkdown(content, normalizeCoreMarkdown(source));
  navigation.replaceChildren();
  const headings = [...content.querySelectorAll('h1, h2, h3, h4, h5, h6')]
    .filter(target => /^功能\s*[一二三四五六七八九十百零〇两\d]+/.test(target.textContent));
  navigation.hidden = headings.length === 0;
  for (const [index, target] of headings.entries()) {
    const title = target.textContent;
    target.id = `core-function-${index + 1}`;
    target.dataset.coreFunction = String(index + 1);
    target.classList.add('core-function-target');

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = /^功能\s*[一二三四五六七八九十百零〇两\d]+/.exec(title)[0];
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
