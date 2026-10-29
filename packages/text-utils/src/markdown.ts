import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { markdownBaseRemarkPlugins } from "./markdown-plugins.js";
import { createMarkdownHtmlRehypePlugins } from "./markdown-html.js";

const markdownParser = unified()
  .use(remarkParse)
  .use(markdownBaseRemarkPlugins)
  .use(remarkRehype, { allowDangerousHtml: true })
  .freeze();
const htmlParser = markdownParser()
  .use(createMarkdownHtmlRehypePlugins([]))
  .freeze();

const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "dd", "details", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tr", "ul",
]);

type RenderedNode = { type: string; tagName?: string; value?: string; children?: RenderedNode[] };

export function markdownSelectionText(source: string, role: "user" | "assistant"): string {
  const parser = role === "assistant" ? htmlParser : markdownParser;
  const parts: string[] = [];
  let lastPart = "";
  function append(value: string): void {
    if (value.length === 0) return;
    parts.push(value);
    lastPart = value;
  }
  function boundary(): void {
    if (parts.length > 0 && !lastPart.endsWith("\n")) append("\n");
  }
  function collect(node: RenderedNode): void {
    if ((node.type === "text" || role === "user" && node.type === "raw") && node.value !== undefined) {
      append(node.value);
      return;
    }
    if (node.type === "element" && node.tagName === "br") {
      append("\n");
      return;
    }
    const block = node.type === "element" && node.tagName !== undefined && BLOCK_ELEMENTS.has(node.tagName);
    if (block) boundary();
    if (node.children) {
      for (const child of node.children) collect(child);
    }
    if (block) boundary();
  }
  collect(parser.runSync(parser.parse(source)));
  return parts.join("").trim();
}
