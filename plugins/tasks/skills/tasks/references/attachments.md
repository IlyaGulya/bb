# Task attachments

Read this file when a task needs files, video evidence, or image references.

## Choose the owner

A task key adds a file to the task. A comment ID adds a file to that comment.

For a comment attachment, create the comment as JSON and use its ID:

```sh
comment_id=$(
  bb tasks comment ABC-12 \
    --body "Screenshot of the failing step." \
    --json | jq -r '.comment.id'
)
bb tasks attachment add "$comment_id" --file ./screenshot.png
bb tasks attachment add "$comment_id" --file ./trace.log
```

Use JSON output when another command needs returned attachment data.

## Add and remove files

Use repeatable `--attach <path>` with `bb tasks create` for initial files.

List IDs with `bb tasks attachment list <key>`. Remove a file with
`bb tasks attachment remove <attachment-id>`.

The remove command deletes the row and the stored file. It rejects a referenced
file unless `--remove-references` confirms description cleanup.

## Video evidence

For newly classified UI/interactive work, select `workflow draft set TASK
--task-kind ui`; the explicit version-1 evidence policy requires video. Read the
saved draft first. Old `uiRequired` and legacy screenshots/previews are unchanged.
An explicit video policy cannot be satisfied with only a screenshot or preview.

Use the existing approved recorder for a short real action/result scenario on
the exact reviewed commit. If safe capture is unavailable, stop with a blocker.
Do not record secrets or unrelated work. Add the completed MP4 / H.264 or WebM
using `bb tasks attachment add TASK --file ./demo.mp4 --json`, then use its returned
attachment ID in the structured evidence. Preserve a server-accessible original
when editing or speeding up, and report its run, commit, scenario and changes.
The limit remains 25 MiB. A local temporary path is not a human-review artifact.

Video attachments open in the same task's responsive player, with native
controls and a separate download. Loading, missing/corrupt files and unsupported
decoders are visible failures, not evidence of a working demo. Ordinary downloads
use the existing attachment URL with `download=1`; authenticated playback uses
the same owner gate and supports HEAD and single-byte Range requests. Browser
decode/playback and technical smoke still require actual observation.


## Select a machine

The invoking machine owns `--file`, `--attach`, `--out`, `--description-file`,
and `--body-file` paths. In a thread, this is the thread machine.

Outside a thread, these paths use the server machine. Use
`--machine <id-or-name>` for another enrolled machine.
