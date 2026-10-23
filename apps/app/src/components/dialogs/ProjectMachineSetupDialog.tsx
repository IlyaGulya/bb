import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  getProjectPathValidationMessage,
  normalizeProjectPathInput,
  type ProjectSource,
} from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";
import { Textarea } from "@bb/shared-ui/textarea";
import { RemotePathBrowser } from "@/components/dialogs/RemotePathBrowser";
import {
  useAddProjectSource,
  usePrepareProjectMachine,
  type PrepareProjectMachineMutation,
} from "@/hooks/mutations/project-mutations";
import {
  isHostPathMissing,
  useHostPathExistence,
} from "@/hooks/queries/host-path-queries";
import { useHostCloneDefaultPath } from "@/hooks/queries/host-queries";
import { BbHttpError } from "@bb/sdk/browser";
import { getMutationErrorMessage } from "@/lib/mutation-errors";

export interface ProjectMachineSetupDialogTarget {
  projectId: string;
  projectName: string;
  gitRemoteUrl: string | null;
  hostId: string;
  hostName: string;
  sources: ProjectSource[];
}

export interface ProjectMachineSetupCompletion {
  hostId: string;
  source: ProjectSource;
}

interface ProjectMachineSetupDialogProps {
  target: ProjectMachineSetupDialogTarget | null;
  onOpenChange: (open: boolean) => void;
  onComplete: (completion: ProjectMachineSetupCompletion) => void;
}

export function ProjectMachineSetupDialog({
  target,
  onOpenChange,
  onComplete,
}: ProjectMachineSetupDialogProps) {
  const addSource = useAddProjectSource();
  const prepareMachine = usePrepareProjectMachine();
  const targetKey = target ? `${target.projectId}:${target.hostId}` : null;
  const resetAddSource = addSource.reset;
  const resetPreparation = prepareMachine.reset;
  useEffect(() => {
    resetAddSource();
    resetPreparation();
  }, [resetAddSource, resetPreparation, targetKey]);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && (addSource.isPending || prepareMachine.isPending)) return;
        onOpenChange(open);
      }}
    >
      <DialogContent>
        {target ? (
          <ProjectMachineSetupDialogContent
            key={targetKey}
            target={target}
            addSource={addSource}
            prepareMachine={prepareMachine}
            onOpenChange={onOpenChange}
            onComplete={onComplete}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type SetupOption = "clone" | "folder";

interface ProjectMachineSetupDialogContentProps {
  target: ProjectMachineSetupDialogTarget;
  addSource: ReturnType<typeof useAddProjectSource>;
  prepareMachine: PrepareProjectMachineMutation;
  onOpenChange: (open: boolean) => void;
  onComplete: (completion: ProjectMachineSetupCompletion) => void;
}

function ProjectMachineSetupDialogContent({
  target,
  addSource,
  prepareMachine,
  onOpenChange,
  onComplete,
}: ProjectMachineSetupDialogContentProps) {
  const hasRemote = target.gitRemoteUrl !== null;
  const [option, setOption] = useState<SetupOption>(
    hasRemote ? "clone" : "folder",
  );
  const [customClonePath, setCustomClonePath] = useState<string | null>(null);
  const [isEditingClonePath, setIsEditingClonePath] = useState(false);
  const [clonePathDraft, setClonePathDraft] = useState("");
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [sourceHostId, setSourceHostId] = useState("");
  const [copyPathsInput, setCopyPathsInput] = useState("");
  const copySources = target.sources.filter(
    (source) =>
      source.projectId === target.projectId && source.hostId !== target.hostId,
  );
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );

  const defaultClonePathQuery = useHostCloneDefaultPath(
    target.hostId,
    target.projectId,
    { enabled: hasRemote },
  );
  const clonePath = customClonePath ?? defaultClonePathQuery.data ?? null;

  const folderExistence = useHostPathExistence(
    option === "folder" ? target.hostId : null,
    folderPath !== null ? [folderPath] : [],
  );

  const pending = addSource.isPending || prepareMachine.isPending;

  const selectOption = (nextOption: SetupOption) => {
    if (pending || option === nextOption) return;
    setOption(nextOption);
    setValidationMessage(null);
    setIsEditingClonePath(false);
    addSource.reset();
    prepareMachine.reset();
  };

  const commitClonePathEdit = () => {
    setIsEditingClonePath(false);
    const normalized = normalizeProjectPathInput(clonePathDraft);
    if (!normalized) return;
    setCustomClonePath(normalized);
    setValidationMessage(null);
    addSource.reset();
    prepareMachine.reset();
  };

  const submit = (request: Parameters<typeof addSource.mutate>[0]) => {
    addSource.mutate(request, {
      onSuccess: (source) => {
        onComplete({ hostId: target.hostId, source });
      },
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setValidationMessage(null);

    if (option === "clone") {
      if (clonePath === null) return;
      const pathValidationMessage = getProjectPathValidationMessage(clonePath);
      if (pathValidationMessage) {
        setValidationMessage(pathValidationMessage);
        return;
      }
      const copyPaths = [
        ...new Set(
          copyPathsInput
            .split(/\r?\n/u)
            .map((path) => path.trim())
            .filter(Boolean),
        ),
      ];
      if (
        copyPaths.length > 0 &&
        !copySources.some((source) => source.hostId === sourceHostId)
      ) {
        setValidationMessage("Choose a source machine for the additional files.");
        return;
      }
      if (
        copyPaths.some(
          (path) =>
            path.startsWith("/") ||
            path.includes("\\") ||
            /^[a-z]:/iu.test(path) ||
            path
              .split("/")
              .some((part) => part === ".." || part === "." || part === ""),
        )
      ) {
        setValidationMessage(
          "Enter file paths relative to the source project folder, without . or .. segments.",
        );
        return;
      }
      prepareMachine.mutate({
        projectId: target.projectId,
        hostId: target.hostId,
        targetPath: clonePath,
        ...(sourceHostId ? { sourceHostId } : {}),
        ...(copyPaths.length > 0 ? { copyPaths } : {}),
      });
      return;
    }

    if (folderPath === null) {
      setValidationMessage("Choose a folder.");
      return;
    }
    if (isHostPathMissing(folderExistence, folderPath)) {
      setValidationMessage(
        `That folder no longer exists on ${target.hostName}.`,
      );
      return;
    }
    submit({
      projectId: target.projectId,
      request: { type: "local_path", hostId: target.hostId, path: folderPath },
    });
  };

  const activeMutation = option === "clone" ? prepareMachine : addSource;
  const errorMessage = activeMutation.isError
    ? getMutationErrorMessage({
        error: activeMutation.error,
        fallbackMessage: `Couldn't set up ${target.projectName} on ${target.hostName}.`,
      })
    : null;
  const isTargetNotEmptyError =
    activeMutation.error instanceof BbHttpError &&
    activeMutation.error.code === "target_not_empty";

  const submitDisabled =
    pending || (option === "clone" ? clonePath === null : folderPath === null);

  const cloneDestination: ReactNode = isEditingClonePath ? (
    <div className="flex items-center gap-1">
      <Input
        aria-label="Clone destination"
        className="h-7 flex-1 text-xs"
        value={clonePathDraft}
        disabled={pending}
        autoFocus
        placeholder={defaultClonePathQuery.data ?? "/path/to/checkout"}
        onChange={(event) => setClonePathDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitClonePathEdit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setIsEditingClonePath(false);
          }
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label="Use this destination"
        disabled={pending}
        onClick={commitClonePathEdit}
      >
        <Icon name="Check" />
      </Button>
    </div>
  ) : (
    <p className="break-all text-xs text-muted-foreground">
      into <span className="text-foreground">{clonePath ?? "…"}</span>{" "}
      <button
        type="button"
        className="text-primary hover:underline disabled:opacity-50"
        disabled={pending}
        onClick={() => {
          setClonePathDraft(clonePath ?? "");
          setIsEditingClonePath(true);
        }}
      >
        change
      </button>
    </p>
  );

  const preparation = prepareMachine.data;
  if (preparation) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {preparation.readiness.ready
              ? "Project preparation ready"
              : "Project preparation needs attention"}
          </DialogTitle>
          <DialogDescription>
            {target.projectName} on {target.hostName}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="break-all text-sm">{preparation.source.path}</p>
          <ul
            aria-label="Preparation readiness checks"
            className="space-y-2 text-sm"
          >
            {preparation.readiness.checks.map((check, index) => (
              <li key={`${check.name}:${index}`}>
                <p className={check.ok ? "text-foreground" : "text-destructive"}>
                  {check.ok ? "Passed" : "Failed"}: {check.name}
                </p>
                <p className="whitespace-pre-wrap break-words text-muted-foreground">
                  {check.detail}
                </p>
              </li>
            ))}
          </ul>
          <p className="text-sm">
            Copied {preparation.copiedFiles.length} additional{" "}
            {preparation.copiedFiles.length === 1 ? "file" : "files"}.
          </p>
          <ul aria-label="Copied file hashes" className="space-y-2 text-xs">
            {preparation.copiedFiles.map((file) => (
              <li key={file.path}>
                <p className="break-all">{file.path}</p>
                <p className="break-all font-mono text-muted-foreground">
                  SHA-256: {file.sha256}
                </p>
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
          <Button
            type="button"
            disabled={!preparation.readiness.ready}
            onClick={() => {
              if (preparation.readiness.ready) {
                onComplete({ hostId: target.hostId, source: preparation.source });
              }
            }}
          >
            Continue
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          Set up {target.projectName} on {target.hostName}
        </DialogTitle>
        <DialogDescription>
          {hasRemote
            ? `${target.hostName} doesn't have this project yet. Pick how to get it there — this happens once.`
            : `${target.hostName} doesn't have this project yet. Point at the project folder on ${target.hostName} — this happens once.`}
        </DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={handleSubmit}>
        {hasRemote ? (
          <div
            role="radiogroup"
            aria-label="Setup method"
            className="flex flex-col gap-2"
          >
            <SetupOptionCard
              selected={option === "clone"}
              disabled={pending}
              onSelect={() => selectOption("clone")}
              title="Clone from the project remote"
            >
              <p className="break-all text-xs text-muted-foreground">
                {target.gitRemoteUrl}
              </p>
              {option === "clone" ? cloneDestination : null}
            </SetupOptionCard>
            <SetupOptionCard
              selected={option === "folder"}
              disabled={pending}
              onSelect={() => selectOption("folder")}
              title={`Use an existing folder on ${target.hostName}`}
            >
              <p className="text-xs text-muted-foreground">
                Browse {target.hostName}'s files and point at a checkout you
                already have.
              </p>
            </SetupOptionCard>
          </div>
        ) : null}
        {option === "folder" ? (
          <RemotePathBrowser
            hostId={target.hostId}
            allowCreateFolder={false}
            onDirectoryChange={(directory) => {
              setFolderPath(directory);
              setValidationMessage(null);
            }}
            disabled={pending}
          />
        ) : null}
        {option === "clone" ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">Copy additional files (optional)</p>
            <Select
              value={sourceHostId}
              disabled={pending || copySources.length === 0}
              onValueChange={setSourceHostId}
            >
              <SelectTrigger aria-label="Additional files source machine">
                <SelectValue placeholder="Choose a project source machine" />
              </SelectTrigger>
              <SelectContent>
                {copySources.map((source) => (
                  <SelectItem key={source.id} value={source.hostId}>
                    {source.hostId}: {source.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Textarea
              aria-label="Additional file relative paths"
              value={copyPathsInput}
              disabled={pending || copySources.length === 0}
              onChange={(event) => setCopyPathsInput(event.target.value)}
              placeholder="One relative file path per line"
              className="text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Only the files you list are copied from that project's source
              folder. No files, including .env files, are selected by default.
              {" "}Copies land in this registered source checkout only. New isolated
              Git worktrees do not automatically inherit untracked or ignored files.
              {copySources.length === 0
                ? " This project has no source on another machine."
                : ""}
            </p>
          </div>
        ) : null}
        {pending && option === "clone" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Icon name="Spinner" className="size-4 shrink-0 animate-spin" />
            Preparing the project on {target.hostName}… This can take a while.
          </p>
        ) : null}
        {validationMessage ? (
          <p className="text-sm text-destructive">{validationMessage}</p>
        ) : null}
        {errorMessage ? (
          <div className="space-y-1">
            <p className="whitespace-pre-wrap break-words text-sm text-destructive">
              {errorMessage}
            </p>
            {isTargetNotEmptyError ? (
              <p className="text-sm text-muted-foreground">
                Pick a different destination, or use the existing-folder option
                to point at what's already there.
              </p>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={submitDisabled}>
            {option === "clone" ? "Prepare project" : "Use folder & continue"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

interface SetupOptionCardProps {
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  title: string;
  children: ReactNode;
}

function SetupOptionCard({
  selected,
  disabled,
  onSelect,
  title,
  children,
}: SetupOptionCardProps) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      aria-label={title}
      tabIndex={disabled ? -1 : 0}
      className={cn(
        "flex items-start gap-3 rounded-md border p-3",
        selected ? "border-primary" : "border-border",
        !disabled && "cursor-pointer",
      )}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
          selected ? "border-primary" : "border-muted-foreground",
        )}
      >
        {selected ? <span className="size-2 rounded-full bg-primary" /> : null}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
    </div>
  );
}
