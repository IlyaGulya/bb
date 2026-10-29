import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { PluggableList } from "unified";

export function createMarkdownHtmlRehypePlugins(editorFileUrlSchemes: readonly string[]): PluggableList {
  return [
    rehypeRaw,
    [
      rehypeSanitize,
      {
        ...defaultSchema,
        tagNames: [
          ...(defaultSchema.tagNames ?? []),
          "video",
          "bb-thread-mention",
          "bb-prompt-mention",
          "bb-message-directive",
        ],
        protocols: {
          ...defaultSchema.protocols,
          href: [
            ...(defaultSchema.protocols?.href ?? []),
            ...editorFileUrlSchemes,
          ],
          poster: ["http", "https"],
        },
        attributes: {
          ...defaultSchema.attributes,
          source: [
            ...(defaultSchema.attributes?.source ?? []),
            "src",
            "type",
            "media",
          ],
          video: [
            "src",
            "controls",
            "playsInline",
            "preload",
            "poster",
            "width",
            "height",
            "title",
            "ariaLabel",
          ],
          code: [
            ...(defaultSchema.attributes?.code ?? []),
            "dataCodeFenceOffset",
            "dataCodeFenceClosed",
          ],
          "bb-thread-mention": [
            "dataThreadId",
            "dataRawThreadId",
            "dataRawThreadInlineCode",
          ],
          "bb-prompt-mention": ["dataMentionIndex"],
          "bb-message-directive": ["dataDirectiveIndex"],
        },
      },
    ],
  ];
}
