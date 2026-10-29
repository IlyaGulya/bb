import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { markdownBaseRemarkPlugins } from "./markdown-plugins.js";

const parser = unified()
  .use(remarkParse)
  .use(markdownBaseRemarkPlugins)
  .use(remarkRehype, { allowDangerousHtml: true })
  .freeze();

type RenderedNode = { type: string; value?: string; children?: RenderedNode[] };

export function markdownSelectionText(source: string): string {
  const parts: string[] = [];
  function collect(node: RenderedNode): void {
    if ((node.type === "text" || node.type === "raw") && node.value !== undefined) {
      parts.push(node.value);
    } else if (node.children) {
      for (const child of node.children) collect(child);
    }
  }
  collect(parser.runSync(parser.parse(source)));
  return parts.join("");
}
