import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const SKILL_ROOT = fileURLToPath(
  new URL(
    "../../../../../plugins/bb-guide/skills/bb-plugin-authoring/",
    import.meta.url,
  ),
);

function readReference(name: string): string {
  return readFileSync(join(SKILL_ROOT, "references", name), "utf8");
}

describe("bb-plugin-authoring skill", () => {
  it("typechecks the machine provider guide example against the public SDK", () => {
    const source = readReference("backend-machines.md").match(
      /```ts\n([\s\S]*?)```/u,
    )?.[1];
    expect(source).toBeDefined();
    const filename = fileURLToPath(
      new URL("./machine-guide-example.ts", import.meta.url),
    );
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    };
    const host = ts.createCompilerHost(options);
    const readSource = host.getSourceFile.bind(host);
    host.getSourceFile = (
      file,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) =>
      resolve(file) === filename
        ? ts.createSourceFile(file, source!, languageVersion)
        : readSource(file, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram([filename], options, host);
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        ),
    ).toEqual([]);
  });
});
