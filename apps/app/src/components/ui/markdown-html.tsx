import { useMemo } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import { createMarkdownHtmlRehypePlugins } from "@bb/text-utils/markdown-html";
import { EDITOR_FILE_URL_SCHEMES } from "./markdown-local-file-link.js";

type MarkdownRehypePlugins = NonNullable<Options["rehypePlugins"]>;

const MARKDOWN_HTML_REHYPE_PLUGINS: MarkdownRehypePlugins = createMarkdownHtmlRehypePlugins(EDITOR_FILE_URL_SCHEMES);

export function MarkdownHtml({ rehypePlugins, ...props }: Options) {
  const plugins = useMemo(
    () => [...MARKDOWN_HTML_REHYPE_PLUGINS, ...(rehypePlugins ?? [])],
    [rehypePlugins],
  );
  return <ReactMarkdown {...props} rehypePlugins={plugins} />;
}
