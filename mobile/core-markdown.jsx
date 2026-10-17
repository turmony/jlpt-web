import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

const roots = new WeakMap();
const remarkPlugins = [remarkGfm, remarkBreaks];

// Existing comparison tables use <br>. Allow only this attribute-free tag;
// all other source HTML remains escaped by ReactMarkdown.
function rehypeLineBreaks() {
  return function transform(node) {
    if (!node.children) return;
    node.children = node.children.map(child => {
      if (child.type === 'raw' && /^<br\s*\/?>$/i.test(child.value.trim())) {
        return { type: 'element', tagName: 'br', properties: {}, children: [] };
      }
      transform(child);
      return child;
    });
  };
}
const rehypePlugins = [rehypeLineBreaks];

export function renderCoreMarkdown(content, source) {
  let root = roots.get(content);
  if (!root) {
    root = createRoot(content);
    roots.set(content, root);
  }
  // Navigation measures the headings immediately after this render.
  flushSync(() => root.render(<Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>{source}</Markdown>));
}
